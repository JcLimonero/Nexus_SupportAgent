"""Service status: the banners every visitor sees, and the self-monitor that
raises them on its own.

Three ways the service fails, three answers:
  * Gemini down  — backend and DB work; the monitor opens a banner row.
  * DB down      — /api/status still answers from memory: the last banners it
                   managed to read plus the monitor's in-memory incident.
  * backend down — nothing here runs; the frontend notices /api/status is
                   unreachable and shows its own built-in fallback.

ponytail: all state is per-process. Prod runs a single uvicorn worker, so there
is one monitor and one cache. Scaling out means N monitors opening duplicate
incidents and N caches invalidated independently — move the loop to a single
scheduler and the cache to Redis at that point.
"""
import asyncio
import logging
import shutil
import time
import uuid
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select, text

import db.connection as dbc
from config import get_settings
from db.models import StatusBanner

logger = logging.getLogger(__name__)
settings = get_settings()

_SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2}
_DB_TIMEOUT_S = 5
# Outer budget for the Gemini probe. asyncio.to_thread can't be cancelled, so
# when this fires the probe thread keeps running and holds a slot in the default
# executor that ask_gemini, embed_text and the disk check all share. It must
# stay above the probe's own inner timeouts (llm.gemini_client._TOKEN_TIMEOUT_S
# + _PROBE_TIMEOUT_S = 13s) so the thread ends on its own before we give up.
_LLM_PROBE_TIMEOUT_S = 15


# ── Serialization ─────────────────────────────────────────────────────────────

def iso(dt: datetime | None) -> str | None:
    """Naive-UTC column → ISO-8601 with an explicit Z. Without the Z the browser
    parses the string as local time and every "desde hace" is off by the offset."""
    return dt.replace(microsecond=0).isoformat() + "Z" if dt else None


def to_utc_naive(dt: datetime | None) -> datetime | None:
    """Request datetimes arrive timezone-aware ("…Z" from the browser); columns
    are naive UTC like the rest of the schema. A naive input is taken as UTC."""
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def serialize(b: StatusBanner) -> dict:
    return {
        "id": str(b.id),
        "message": b.message,
        "severity": b.severity,
        "blocks_chat": bool(b.blocks_chat),
        "contact": b.contact,
        "starts_at": iso(b.starts_at),
        "ends_at": iso(b.ends_at),
        "eta_at": iso(b.eta_at),
        "ended_at": iso(b.ended_at),
        "updates": list(b.updates or []),
        "source": b.source,
        "incident_key": b.incident_key,
        "created_by": b.created_by,
        "created_at": iso(b.created_at),
    }


_PUBLIC_FIELDS = ("id", "message", "severity", "blocks_chat", "contact", "starts_at", "ends_at", "eta_at", "updates", "source")


def _public_view(banner: dict) -> dict:
    # Who wrote it and the incident key are for admins, not the login page.
    return {k: banner[k] for k in _PUBLIC_FIELDS}


# ── Active-banner cache ───────────────────────────────────────────────────────
# Every open tab polls /api/status about once a minute, so the DB is read at most
# once per TTL. On a DB error the last good list keeps being served — that is
# what lets a banner survive the database going away.

_CACHE_TTL_S = 10
# rows: [(serialized, ends_at)]. gen counts invalidations, so a read that was
# already in flight when a write landed can tell its result is stale.
_cache: dict = {"at": 0.0, "fresh": False, "rows": [], "gen": 0}
_refresh_lock = asyncio.Lock()


def invalidate() -> None:
    """Call after any banner write so the change shows on the next poll."""
    _cache["at"] = 0.0
    _cache["gen"] += 1


async def _load_active_banners() -> list[tuple[dict, datetime | None]]:
    now = datetime.utcnow()
    async with dbc.AsyncSessionLocal() as db:
        rows = (await db.execute(
            select(StatusBanner).where(
                StatusBanner.ended_at.is_(None),
                StatusBanner.starts_at <= now,
                StatusBanner.ends_at.is_(None) | (StatusBanner.ends_at > now),
            )
        )).scalars().all()
    return [(serialize(r), r.ends_at) for r in rows]


async def _active_banners() -> list[dict]:
    if time.monotonic() - _cache["at"] >= _CACHE_TTL_S:
        # Wait for an in-flight refresh rather than serving the old list: right
        # after an admin publishes, concurrent polls would otherwise answer
        # "nothing" and those tabs wouldn't ask again for a minute. A DB that's
        # down costs waiters at most one _DB_TIMEOUT_S per TTL window.
        async with _refresh_lock:
            if time.monotonic() - _cache["at"] >= _CACHE_TTL_S:   # the holder may have just refreshed
                gen = _cache["gen"]
                try:
                    _cache["rows"] = await asyncio.wait_for(_load_active_banners(), timeout=_DB_TIMEOUT_S)
                    _cache["fresh"] = True
                except Exception as exc:
                    logger.warning("Status banners unreadable, serving the last known list: %s", exc)
                    _cache["fresh"] = False
                # A write that landed mid-read already made this result stale —
                # don't let it stand for the whole TTL.
                _cache["at"] = time.monotonic() if _cache["gen"] == gen else 0.0
    # A stale list can outlive a scheduled end — drop those at serve time.
    now = datetime.utcnow()
    return [b for b, ends_at in _cache["rows"] if ends_at is None or ends_at > now]


async def is_chat_blocked() -> bool:
    """Cheap enough to call on every chat request — reuses the same up-to-10s
    -old cache /api/status serves from, no extra DB round trip of its own."""
    return (await public_status())["chat_blocked"]


async def public_status() -> dict:
    banners = await _active_banners()
    ids = {b["id"] for b in banners}
    for chk in _checks.values():
        inc = chk.incident
        # The monitor's in-memory copy stands in for its row only when the row
        # can't be trusted to be in the list: never written, or DB unreadable.
        # Otherwise an admin who ended it early would see it pop back.
        if inc and inc["id"] not in ids and (not chk.persisted or not _cache["fresh"]):
            banners.append(inc)
            ids.add(inc["id"])
    banners.sort(key=lambda b: b["starts_at"] or "", reverse=True)          # newest first…
    banners.sort(key=lambda b: _SEVERITY_RANK.get(b["severity"], 9))        # …within severity
    severities = {b["severity"] for b in banners}
    state = "down" if "critical" in severities else "degraded" if "warning" in severities else "ok"
    return {
        "state": state,
        "chat_blocked": any(b["blocks_chat"] for b in banners),
        "banners": [_public_view(b) for b in banners],
        "generated_at": iso(datetime.utcnow()),
    }


# ── Passive Gemini signal ─────────────────────────────────────────────────────

_llm_events: deque[tuple[float, bool]] = deque(maxlen=50)


def record_llm_result(ok: bool) -> None:
    """chat.py reports every real stream's outcome — the probe alone can't see
    quota or overload errors, which only show up when generating."""
    _llm_events.append((time.monotonic(), ok))


def llm_failing(now: float | None = None) -> bool:
    now = time.monotonic() if now is None else now
    recent = [(t, ok) for t, ok in _llm_events if now - t <= settings.status_llm_error_window_s]
    failures = [t for t, ok in recent if not ok]
    if len(failures) < settings.status_llm_error_threshold:
        return False
    last_ok = max((t for t, ok in recent if ok), default=None)
    return last_ok is None or last_ok < failures[-1]


def _consume_llm_evidence() -> None:
    """The recorded chat failures have done their job once the banner exists —
    from here recovery is the probe's call. Keeping them would strand us: the
    banner blocks chat, chat is the only thing that records events, so
    llm_failing() would stay true for the whole status_llm_error_window_s no
    matter how healthy Vertex got, and chat would stay blocked minutes after
    the model came back. Trade-off: if generation really is still broken, the
    first real chats after the banner clears record fresh failures and the
    incident reopens — a possible flap we prefer over a stuck block."""
    _llm_events.clear()


# ── Self-monitor ──────────────────────────────────────────────────────────────

class _Skipped(Exception):
    """A check that can't run here (e.g. no Vertex project) — neither up nor down."""


@dataclass
class _Check:
    key: str
    label: str
    user_facing: bool           # opens a banner when down (disk only warns admins)
    message: str = ""
    ok: bool | None = None
    detail: str = "Sin datos todavía"
    checked_at: datetime | None = None
    fails: int = 0
    oks: int = 0
    down: bool = False
    incident: dict | None = None      # serialized banner while an incident is open
    opened_at: datetime | None = None
    persisted: bool = False


_OUTAGE_TAIL = " Nuestro equipo ya fue notificado y está trabajando para restablecerlo."


def _new_checks() -> dict[str, _Check]:
    return {
        "db": _Check("db", "Base de datos", True,
                     "Estamos teniendo problemas técnicos con el servicio." + _OUTAGE_TAIL),
        "llm": _Check("llm", "Asistente IA (Gemini)", True,
                      "El asistente no está disponible en este momento por una falla en el "
                      "servicio de inteligencia artificial." + _OUTAGE_TAIL),
        "disk": _Check("disk", "Almacenamiento", False),
    }


_checks: dict[str, _Check] = _new_checks()

# Closes the DB refused, retried on later ticks. Kept apart from _Check so a
# resolved incident stops being displayed immediately whether or not its row
# could be closed — bookkeeping here, never state anyone sees.
_pending_closes: deque[dict] = deque(maxlen=20)


def reset_state() -> None:
    """Test hook: forget checks, incidents, LLM events, pending writes and the
    banner cache."""
    global _checks, _refresh_lock
    _checks = _new_checks()
    _llm_events.clear()
    _pending_closes.clear()
    _cache.update({"at": 0.0, "fresh": False, "rows": [], "gen": 0})
    _refresh_lock = asyncio.Lock()   # each test runs on its own event loop


async def _check_db() -> str:
    async def _ping():
        async with dbc.AsyncSessionLocal() as db:
            await db.execute(text("SELECT 1"))
    await asyncio.wait_for(_ping(), timeout=_DB_TIMEOUT_S)
    return "Conectada"


async def _check_llm() -> str:
    if not settings.vertex_ai_project:
        raise _Skipped("Vertex AI no configurado")
    from llm.gemini_client import probe_count_tokens
    await asyncio.wait_for(asyncio.to_thread(probe_count_tokens), timeout=_LLM_PROBE_TIMEOUT_S)
    if llm_failing():
        raise RuntimeError("Vertex responde, pero varias respuestas recientes del chat fallaron")
    return f"{settings.gemini_model} disponible"


async def _check_disk() -> str:
    usage = await asyncio.to_thread(shutil.disk_usage, settings.local_storage_path)
    free_mb = usage.free / (1024 * 1024)
    if free_mb < settings.min_free_disk_mb:
        raise RuntimeError(f"Solo {free_mb:,.0f} MB libres")
    return f"{free_mb:,.0f} MB libres"


_CHECK_FUNCS = {"db": _check_db, "llm": _check_llm, "disk": _check_disk}


def _describe(exc: Exception) -> str:
    if isinstance(exc, asyncio.TimeoutError):
        return "Sin respuesta (tiempo de espera agotado)"
    return (str(exc) or exc.__class__.__name__)[:200]


async def _persist(banner: StatusBanner) -> None:
    async with dbc.AsyncSessionLocal() as db:
        db.add(banner)
        await db.commit()


def _incident_row(key: str, banner_id: uuid.UUID, message: str, opened_at: datetime,
                  ended_at: datetime | None = None) -> StatusBanner:
    """The row for one monitor incident. Built fresh for every write attempt —
    a retry can't reuse an instance a failed session already touched."""
    return StatusBanner(
        id=banner_id, message=message, severity="critical", blocks_chat=True,
        starts_at=opened_at, ended_at=ended_at, updates=[], source="monitor",
        incident_key=f"monitor:{key}", created_by="monitor",
        created_at=opened_at, updated_at=ended_at or opened_at,
    )


async def _try_persist_open(chk: _Check) -> bool:
    """Write the row for the incident currently open on chk. False = still
    memory-only, which a later tick retries."""
    inc = chk.incident
    if inc is None:
        return False
    row = _incident_row(chk.key, uuid.UUID(inc["id"]), inc["message"], chk.opened_at or datetime.utcnow())
    try:
        await asyncio.wait_for(_persist(row), timeout=_DB_TIMEOUT_S)
    except Exception as exc:
        # Expected when the DB is the thing that's down — memory serves it.
        logger.warning("Monitor incident for %s kept in memory only: %s", chk.key, _describe(exc))
        return False
    chk.persisted = True
    return True


async def _open_incident(chk: _Check) -> None:
    now = datetime.utcnow()
    row = _incident_row(chk.key, uuid.uuid4(), chk.message, now)
    chk.incident, chk.opened_at, chk.persisted = serialize(row), now, False
    if chk.key == "llm":
        _consume_llm_evidence()
    await _try_persist_open(chk)
    invalidate()
    logger.error("Status monitor: %s is down (%s) — banner opened", chk.label, chk.detail)


async def _persist_close(key: str, inc: dict, opened_at: datetime | None, now: datetime,
                         persisted: bool) -> None:
    async with dbc.AsyncSessionLocal() as db:
        row = await db.get(StatusBanner, uuid.UUID(inc["id"]))
        if row is None:
            if persisted:
                # The row was written and is gone: an admin hard-deleted it.
                # Re-inserting would resurrect a deleted record in the Historial
                # tab and in audit_report.py hours after the fact.
                logger.info("Monitor incident %s (%s) was deleted — nothing to close", inc["id"], key)
                return
            # Opened while the DB was unreachable — record it for history.
            db.add(_incident_row(key, uuid.UUID(inc["id"]), inc["message"], opened_at or now, ended_at=now))
        elif row.ended_at is None:
            row.ended_at = now
            row.updated_at = now
        await db.commit()


async def _try_persist_close(pending: dict) -> bool:
    try:
        await asyncio.wait_for(
            _persist_close(pending["key"], pending["inc"], pending["opened_at"],
                           pending["now"], pending["persisted"]),
            timeout=_DB_TIMEOUT_S,
        )
    except Exception as exc:
        logger.warning("Could not record the end of the %s incident: %s", pending["key"], _describe(exc))
        return False
    return True


async def _resolve_incident(chk: _Check) -> None:
    now = datetime.utcnow()
    pending = {"key": chk.key, "inc": chk.incident, "opened_at": chk.opened_at,
               "now": now, "persisted": chk.persisted}
    # Stop showing it first, and never put it back: the check has recovered
    # whether or not its row can be closed right now.
    chk.incident, chk.opened_at, chk.persisted = None, None, False
    if chk.key == "llm":
        _consume_llm_evidence()
    if pending["inc"] and not await _try_persist_close(pending):
        # ended_at stays NULL and _load_active_banners filters on exactly that,
        # so without a retry this keeps being served as a live chat-blocking
        # banner for a check the admin panel already shows as healthy.
        _pending_closes.append(pending)
    invalidate()
    logger.warning("Status monitor: %s recovered — banner cleared", chk.label)


async def _flush_pending_writes() -> None:
    """Retry the incident writes the DB refused on an earlier tick: a close that
    never lands blocks chat forever, and an open that never lands leaves an
    ongoing outage with no row — nothing for /admin/avisos to show or end, and
    nothing for restore_open_incidents to re-adopt after a restart."""
    changed = False
    for pending in list(_pending_closes):
        if await _try_persist_close(pending):
            _pending_closes.remove(pending)
            changed = True
    for chk in _checks.values():
        if chk.incident is not None and not chk.persisted and await _try_persist_open(chk):
            changed = True
    if changed:
        invalidate()


def forget_incident(banner_id: str) -> None:
    """An admin ended or deleted a banner — drop the monitor's copy of it.

    Without this the in-memory incident outlives the row: public_status merges
    it back in the moment any DB read fails, and chk.down keeps the check from
    ever opening another one. Resetting the hysteresis is deliberate — a check
    that is *still* failing raises a fresh incident status_fail_threshold ticks
    later, because an ongoing outage must not be left invisible just because
    someone closed the banner it raised."""
    for chk in _checks.values():
        if chk.incident and chk.incident["id"] == banner_id:
            chk.incident, chk.opened_at, chk.persisted = None, None, False
            chk.down, chk.fails, chk.oks = False, 0, 0
            logger.info("Status monitor: an admin closed the %s incident %s — forgotten", chk.key, banner_id)
    # The admin's write is the last word on that row: a queued close would
    # either do nothing or fight the delete.
    for pending in [p for p in _pending_closes if p["inc"]["id"] == banner_id]:
        _pending_closes.remove(pending)


async def _apply(chk: _Check) -> None:
    """Hysteresis: N failures in a row open, M passes in a row clear."""
    if chk.ok:
        chk.oks, chk.fails = chk.oks + 1, 0
    else:
        chk.fails, chk.oks = chk.fails + 1, 0
    if not chk.user_facing:
        return
    if not chk.down and chk.fails >= settings.status_fail_threshold:
        chk.down = True
        await _open_incident(chk)
    elif chk.down and chk.oks >= settings.status_ok_threshold:
        chk.down = False
        await _resolve_incident(chk)


async def _run_one(key: str, fn) -> tuple[str, bool | None, str]:
    try:
        return key, True, await fn()
    except _Skipped as exc:
        return key, None, str(exc)
    except Exception as exc:
        return key, False, _describe(exc)


async def run_checks_once() -> None:
    # Anything the DB refused earlier goes first, so a recovered incident's row
    # gets closed even though its check will never report again.
    await _flush_pending_writes()
    # Independent checks (DB ping, an HTTPS call to Vertex with its own
    # _LLM_PROBE_TIMEOUT_S budget, a disk stat) — run them concurrently so a
    # slow one can't stretch out how long the other two take to report, or the
    # overall poll cadence.
    now = datetime.utcnow()
    results = await asyncio.gather(*(_run_one(key, fn) for key, fn in _CHECK_FUNCS.items()))
    for key, ok, detail in results:
        chk = _checks[key]
        chk.checked_at = now
        chk.ok, chk.detail = ok, detail
        if ok is None:   # _Skipped — neither up nor down, hysteresis untouched
            continue
        await _apply(chk)


async def restore_open_incidents() -> None:
    """A restart mid-outage would otherwise orphan the open monitor banner: the
    fresh process never saw it open, so it would never close it."""
    try:
        async with dbc.AsyncSessionLocal() as db:
            rows = (await db.execute(
                select(StatusBanner).where(StatusBanner.source == "monitor", StatusBanner.ended_at.is_(None))
            )).scalars().all()
    except Exception as exc:
        logger.warning("Could not restore open monitor incidents: %s", exc)
        return
    for row in rows:
        chk = _checks.get((row.incident_key or "").removeprefix("monitor:"))
        if chk is None or not chk.user_facing:
            continue
        chk.down, chk.fails = True, settings.status_fail_threshold
        chk.incident, chk.opened_at, chk.persisted = serialize(row), row.starts_at, True


async def run_monitor() -> None:
    while True:
        try:
            await run_checks_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Status monitor iteration failed")
        await asyncio.sleep(settings.status_check_interval_s)


def checks_snapshot() -> dict:
    return {
        "monitor_enabled": settings.status_monitor_enabled,
        "interval_s": settings.status_check_interval_s,
        "fail_threshold": settings.status_fail_threshold,
        "ok_threshold": settings.status_ok_threshold,
        "checks": [
            {
                "key": c.key,
                "label": c.label,
                "ok": c.ok,
                "down": c.down,
                "detail": c.detail,
                "checked_at": iso(c.checked_at),
                "user_facing": c.user_facing,
            }
            for c in _checks.values()
        ],
    }
