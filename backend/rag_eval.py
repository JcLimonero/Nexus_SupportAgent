"""Measure retrieval quality against the live corpus. Read-only.

The 2026-09-11 production audit showed every answer citing exactly 4 sources,
because retrieval_max_distance=0.8 sits above the worst distance the local
MiniLM model ever produces. That was invisible until someone measured it — this
script exists so the next parameter change starts from numbers instead of a
guess.

    # where do we stand
    docker compose run --rm backend python rag_eval.py

    # which cutoff should retrieval_max_distance actually be
    docker compose run --rm backend python rag_eval.py --sweep

    # per-question detail
    docker compose run --rm backend python rag_eval.py --verbose

Reads backend/eval_set.json: each entry is a real user question plus the file
that should answer it, or null when the corpus genuinely doesn't cover it.
Those nulls matter as much as the hits — a good cutoff returns nothing for them
rather than four irrelevant chunks.

Touches no application state: no writes, no cache flush. Safe against prod.
"""
import argparse
import asyncio
import json
from pathlib import Path

from sqlalchemy import select, func

from db.connection import AsyncSessionLocal
from db.models import DocumentChunk
from retrieval.vector_search import embed_text
from config import get_settings

settings = get_settings()

# Pull a generous neighbourhood once per question, then evaluate every
# threshold/k combination in memory — one query serves the whole sweep.
_FETCH_K = 25

DEFAULT_SWEEP = [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.80]


async def _neighbours(db, question: str) -> list[tuple[str, int | None, float]]:
    """(file_name, page_number, cosine_distance) for nearest chunks, closest first."""
    qe = await asyncio.to_thread(embed_text, question)
    dist = DocumentChunk.embedding.cosine_distance(qe)
    rows = (await db.execute(
        select(DocumentChunk.file_name, DocumentChunk.page_number, dist.label("d"))
        .order_by(dist).limit(_FETCH_K)
    )).all()
    return [(r.file_name, r.page_number, float(r.d)) for r in rows]


def _cited(neighbours, threshold: float, k: int, delta: float | None = None) -> list[tuple[str, float]]:
    """The sources a user would actually see, mirroring the real pipeline:
    search_chunks cuts by threshold then limits to k, and build_context dedupes
    what's left per file+page (first, i.e. nearest, wins).

    `delta` additionally applies a RELATIVE cutoff — drop anything further than
    `best + delta` from the nearest chunk. Not implemented in the app; this is
    here to size the gain before deciding whether to build it.
    """
    kept = [n for n in neighbours if n[2] <= threshold]
    if delta is not None and kept:
        kept = [n for n in kept if n[2] <= kept[0][2] + delta]
    kept = kept[:k]
    seen: set[tuple[str, int | None]] = set()
    out: list[tuple[str, float]] = []
    for file_name, page, d in kept:
        if (file_name, page) in seen:
            continue
        seen.add((file_name, page))
        out.append((file_name, d))
    return out


def _evaluate(results: list[dict], threshold: float, k: int, delta: float | None = None) -> dict:
    """Score one (threshold, k, delta) combination over already-fetched neighbours."""
    covered = [r for r in results if r["expected"]]
    uncovered = [r for r in results if not r["expected"]]

    top1 = hit_at_k = 0
    cited_cov: list[int] = []
    for r in covered:
        cited = _cited(r["neighbours"], threshold, k, delta)
        cited_cov.append(len(cited))
        files = [f for f, _ in cited]
        if files and files[0] == r["expected"]:
            top1 += 1
        if r["expected"] in files:
            hit_at_k += 1

    cited_unc = [len(_cited(r["neighbours"], threshold, k, delta)) for r in uncovered]
    silent = sum(1 for c in cited_unc if c == 0)

    return {
        "threshold": threshold,
        "k": k,
        "delta": delta,
        "n_covered": len(covered),
        "n_uncovered": len(uncovered),
        "top1": top1,
        "hit_at_k": hit_at_k,
        "avg_sources_covered": (sum(cited_cov) / len(cited_cov)) if cited_cov else 0.0,
        "avg_sources_uncovered": (sum(cited_unc) / len(cited_unc)) if cited_unc else 0.0,
        "uncovered_silent": silent,
    }


async def main(args) -> None:
    eval_path = Path(args.eval_set)
    if not eval_path.exists():
        raise SystemExit(f"No existe el conjunto de evaluación: {eval_path}")
    spec = json.loads(eval_path.read_text(encoding="utf-8"))
    questions = spec["questions"]

    async with AsyncSessionLocal() as db:
        total_chunks = (await db.execute(select(func.count(DocumentChunk.id)))).scalar_one()
        total_files = (await db.execute(
            select(func.count(func.distinct(DocumentChunk.gcs_url)))
        )).scalar_one()

        print(f"Corpus: {total_files} archivos, {total_chunks} chunks")
        print(f"Embeddings: {settings.embedding_provider} / "
              f"{settings.embedding_model_local if settings.embedding_provider == 'local' else settings.embedding_model_vertexai} "
              f"({settings.embedding_dimensions}d)")
        print(f"Config actual: retrieval_max_distance={settings.retrieval_max_distance}, "
              f"max_chunks_retrieved={settings.max_chunks_retrieved}")
        print(f"Preguntas: {len(questions)}\n")

        if total_chunks == 0:
            raise SystemExit("El índice está vacío — sube documentos antes de evaluar.")

        results = []
        for item in questions:
            neighbours = await _neighbours(db, item["q"])
            results.append({
                "q": item["q"],
                "expected": item.get("expected_file"),
                "note": item.get("note", ""),
                "neighbours": neighbours,
            })

    threshold = args.threshold if args.threshold is not None else settings.retrieval_max_distance
    k = args.k or settings.max_chunks_retrieved

    if args.verbose:
        for r in results:
            kept = _cited(r["neighbours"], threshold, k)
            exp = r["expected"]
            if exp is None:
                tag = "SIN COBERTURA" if not kept else f"RUIDO ({len(kept)} fuentes)"
            elif kept and kept[0][0] == exp:
                tag = "OK"
            elif any(f == exp for f, _ in kept):
                tag = f"PARCIAL (rank {[f for f, _ in kept].index(exp) + 1})"
            else:
                tag = "FALLA"
            print(f"[{tag}] {r['q'][:88]}")
            if exp:
                print(f"        esperado: {exp}")
            if r["note"]:
                print(f"        nota: {r['note']}")
            for f, d in kept:
                print(f"        {'*' if f == exp else ' '} {d:.3f}  {f}")
            if not kept:
                print("          (ningún chunk bajo el umbral)")
            print()

    all_d = [d for r in results for *_, d in r["neighbours"]]
    best_d = [r["neighbours"][0][2] for r in results if r["neighbours"]]
    cov_best = [r["neighbours"][0][2] for r in results if r["expected"] and r["neighbours"]]
    unc_best = [r["neighbours"][0][2] for r in results if not r["expected"] and r["neighbours"]]

    print("── Distancias observadas ─────────────────────────────────────────")
    print(f"  rango global:            {min(all_d):.3f} … {max(all_d):.3f}")
    print(f"  mejor chunk (media):     {sum(best_d)/len(best_d):.3f}")
    if cov_best and unc_best:
        sep = (sum(unc_best) / len(unc_best)) - (sum(cov_best) / len(cov_best))
        print(f"  con cobertura (media):   {sum(cov_best)/len(cov_best):.3f}")
        print(f"  sin cobertura (media):   {sum(unc_best)/len(unc_best):.3f}")
        print(f"  separación:              {sep:.3f}   "
              f"{'(buena)' if sep > 0.12 else '(pobre — el umbral no puede distinguirlas)'}")
    if max(all_d) < settings.retrieval_max_distance:
        print(f"\n  ⚠ retrieval_max_distance={settings.retrieval_max_distance} está por encima de la "
              f"distancia máxima observada ({max(all_d):.3f}): el filtro nunca descarta nada.")

    if args.sweep:
        print("\n── Barrido de umbral ─────────────────────────────────────────────")
        print(f"{'umbral':>7} {'top-1':>7} {'hit@k':>7} {'fuentes/cubierta':>17} "
              f"{'fuentes/sin cob.':>17} {'sin cob. en silencio':>21}")
        for t in DEFAULT_SWEEP:
            m = _evaluate(results, t, k)
            print(f"{t:>7.2f} {m['top1']:>3}/{m['n_covered']:<3} {m['hit_at_k']:>3}/{m['n_covered']:<3} "
                  f"{m['avg_sources_covered']:>17.2f} {m['avg_sources_uncovered']:>17.2f} "
                  f"{m['uncovered_silent']:>15}/{m['n_uncovered']:<5}")
        print("\n  Busca el umbral más bajo que conserve top-1 y hit@k, y que ponga en "
              "silencio\n  el mayor número de preguntas sin cobertura.")

        print("\n── Corte relativo (descarta lo que esté a más de `delta` del mejor) ──")
        print("   Aún NO implementado en la app; esto dimensiona la ganancia.")
        print(f"{'delta':>7} {'top-1':>7} {'hit@k':>7} {'fuentes/cubierta':>17} "
              f"{'fuentes/sin cob.':>17} {'sin cob. en silencio':>21}")
        for dl in (0.04, 0.06, 0.08, 0.10, 0.15):
            m = _evaluate(results, settings.retrieval_max_distance, k, dl)
            print(f"{dl:>7.2f} {m['top1']:>3}/{m['n_covered']:<3} {m['hit_at_k']:>3}/{m['n_covered']:<3} "
                  f"{m['avg_sources_covered']:>17.2f} {m['avg_sources_uncovered']:>17.2f} "
                  f"{m['uncovered_silent']:>15}/{m['n_uncovered']:<5}")
    else:
        m = _evaluate(results, threshold, k)
        print(f"\n── Con umbral {threshold} y k={k} ──────────────────────────────────")
        print(f"  top-1 correcto:          {m['top1']}/{m['n_covered']}")
        print(f"  documento correcto en k: {m['hit_at_k']}/{m['n_covered']}")
        print(f"  fuentes citadas (cubiertas):     {m['avg_sources_covered']:.2f}")
        print(f"  fuentes citadas (sin cobertura): {m['avg_sources_uncovered']:.2f}")
        print(f"  sin cobertura sin citar nada:    {m['uncovered_silent']}/{m['n_uncovered']}")

    if args.json:
        payload = {
            "corpus": {"files": total_files, "chunks": total_chunks},
            "embedding_provider": settings.embedding_provider,
            "metrics": _evaluate(results, threshold, k),
            "sweep": [_evaluate(results, t, k) for t in DEFAULT_SWEEP],
        }
        Path(args.json).write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"\nJSON escrito en {args.json}")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Evalúa la calidad de recuperación del RAG (solo lectura).")
    p.add_argument("--eval-set", default="eval_set.json")
    p.add_argument("--threshold", type=float, help="umbral a evaluar (default: el de config)")
    p.add_argument("--k", type=int, help="chunks a recuperar (default: max_chunks_retrieved)")
    p.add_argument("--sweep", action="store_true", help="compara varios umbrales")
    p.add_argument("--verbose", action="store_true", help="detalle por pregunta")
    p.add_argument("--json", help="escribe las métricas a este archivo")
    asyncio.run(main(p.parse_args()))
