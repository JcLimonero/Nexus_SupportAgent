<#
.SYNOPSIS
    Reconstruye el stack de desarrollo y, opcionalmente, re-indexa y mide el RAG.

.DESCRIPTION
    Envuelve la secuencia que hay que repetir cada vez que cambia la ingestión o
    la configuración de recuperación:

        build → up → esperar health → re-indexar → medir

    Ninguno de los pasos destruye datos. El volumen pgdata y los archivos
    subidos (nexus_data) se conservan siempre: este script nunca invoca
    `docker compose down -v`.

.PARAMETER Reindex
    Re-indexa los PDF ya almacenados (los relee con OCR). Úsalo después de
    cambiar algo de la ingestión.

.PARAMETER ReindexAll
    Re-indexa TODOS los documentos, no solo los PDF. Necesario si cambiaste el
    modelo de embeddings. Añade -IncludeMedia para volver a transcribir video.

.PARAMETER Eval
    Corre rag_eval.py --sweep al terminar, para ver el efecto del cambio.

.PARAMETER Frontend
    Reconstruye también el frontend (por defecto solo el backend, que es lo que
    cambia al tocar ingestión o retrieval).

.EXAMPLE
    .\scripts\rebuild-dev.ps1 -Reindex -Eval
    Reconstruye, relee los PDF con OCR y muestra el barrido de umbral.

.EXAMPLE
    .\scripts\rebuild-dev.ps1 -Eval
    Solo mide: no reconstruye índice, útil para comparar umbrales.
#>
[CmdletBinding()]
param(
    [switch]$Reindex,
    [switch]$ReindexAll,
    [switch]$IncludeMedia,
    [switch]$Eval,
    [switch]$Frontend,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Ok($msg)   { Write-Host "  OK $msg" -ForegroundColor Green }

# ── Comprobaciones previas ──────────────────────────────────────────────────
Step "Comprobaciones"
try { docker info 2>&1 | Out-Null } catch { throw "Docker no responde. ¿Docker Desktop está corriendo?" }
if ($LASTEXITCODE -ne 0) { throw "Docker no responde. ¿Docker Desktop está corriendo?" }
Ok "Docker responde"

# El compose de dev publica 127.0.0.1:5432. Otro Postgres en ese puerto hace
# fallar el `up` con un error que no menciona el puerto — avisar antes.
$portOwner = docker ps --format "{{.Names}} {{.Ports}}" | Select-String ":5432->"
if ($portOwner -and ($portOwner -notmatch "nexus")) {
    Warn "El puerto 5432 ya lo usa otro contenedor:"
    Warn "  $portOwner"
    Warn "Deténlo, o publica la db de este proyecto en otro puerto con un override."
    throw "Puerto 5432 ocupado por un contenedor ajeno al proyecto."
}

# ── Build ───────────────────────────────────────────────────────────────────
if (-not $SkipBuild) {
    $services = @("backend")
    if ($Frontend) { $services += "frontend" }
    Step "Construyendo: $($services -join ', ')"
    docker compose build @services
    if ($LASTEXITCODE -ne 0) { throw "Falló el build." }
    Ok "Imagen(es) construida(s)"
}

# ── Up ──────────────────────────────────────────────────────────────────────
Step "Levantando el stack"
docker compose up -d
if ($LASTEXITCODE -ne 0) { throw "Falló `docker compose up`." }

Step "Esperando a que el backend responda"
$healthy = $false
foreach ($i in 1..60) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:8000/health" -TimeoutSec 3 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $healthy = $true; break }
    } catch { Start-Sleep -Seconds 2 }
}
if (-not $healthy) {
    Warn "El backend no respondió en ~2 min. Últimos logs:"
    docker compose logs --tail 40 backend
    throw "El backend no llegó a estado saludable."
}
Ok "/health responde"

try {
    $db = Invoke-WebRequest -Uri "http://localhost:8000/health/db" -TimeoutSec 5 -UseBasicParsing
    if ($db.StatusCode -eq 200) { Ok "/health/db responde" }
} catch { Warn "/health/db falló: $_" }

# Confirmar que Tesseract quedó dentro de la imagen — si falta, el OCR se
# degrada en silencio y las páginas escaneadas se indexan vacías otra vez.
Step "Verificando OCR"
$tess = docker compose exec -T backend tesseract --version 2>&1 | Select-Object -First 1
if ($LASTEXITCODE -eq 0 -and $tess) {
    Ok "$tess"
    $langs = docker compose exec -T backend tesseract --list-langs 2>&1 | Select-String "^spa$"
    if ($langs) { Ok "paquete de idioma 'spa' presente" }
    else { Warn "Falta el paquete 'spa': el OCR usará inglés y leerá peor el español." }
} else {
    Warn "Tesseract no está en la imagen. El OCR se desactivará solo (con warning en logs)."
    Warn "Reconstruye sin -SkipBuild para instalarlo."
}

# ── Re-indexado ─────────────────────────────────────────────────────────────
if ($Reindex -or $ReindexAll) {
    $rargs = @("reindex_all.py")
    if (-not $ReindexAll) { $rargs += @("--only", "pdf") }
    if ($IncludeMedia)    { $rargs += "--include-media" }
    Step "Re-indexando (docker compose exec backend python $($rargs -join ' '))"
    Warn "El OCR tarda ~2 s por página escaneada. Paciencia."
    docker compose exec -T backend python @rargs
    if ($LASTEXITCODE -ne 0) { Warn "El re-indexado terminó con errores — revisa la salida." }
    else { Ok "Re-indexado completo" }
}

# ── Evaluación ──────────────────────────────────────────────────────────────
if ($Eval) {
    Step "Evaluando recuperación"
    docker compose exec -T backend python rag_eval.py --sweep
}

Step "Listo"
Write-Host "  Frontend: http://localhost:3000"
Write-Host "  API:      http://localhost:8000/docs"
Write-Host ""
Write-Host "  Recuerda: el hot-reload del frontend no funciona en bind-mounts de Windows." -ForegroundColor DarkGray
Write-Host "  Si tocaste el frontend, vacía /app/.next en el contenedor y reinícialo." -ForegroundColor DarkGray
