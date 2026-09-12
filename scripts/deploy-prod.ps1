<#
.SYNOPSIS
    Despliega el stack on-premises. Se ejecuta EN EL SERVIDOR, no desde tu equipo.

.DESCRIPTION
    Ruta esperada en el servidor: C:\inetpub\Nexus_SupportAgent

    Secuencia: mostrar qué se va a desplegar → confirmar → pull → build → up →
    health check → (opcional) re-indexar.

    Garantías de seguridad, deliberadas:
      · NUNCA ejecuta `docker compose down -v`. Ese flag borraría los volúmenes
        pgdata (conversaciones, usuarios, índice) y nexus_data (archivos
        subidos). No hay vuelta atrás y no existe backup automático.
      · NUNCA toca IIS ni nginx del host.
      · Pide confirmación explícita antes de construir, mostrando los commits
        que entran. -Force la omite (para ejecuciones desatendidas).
      · Si el health check falla, se detiene y muestra los logs en vez de
        continuar con el re-indexado.

    El backend de producción NO monta el código como volumen: el Dockerfile lo
    copia con `COPY . .`. Cualquier cambio de código exige `build`, no basta con
    reiniciar el contenedor.

.PARAMETER SkipPull
    No hace git pull (para cuando los archivos se copian a mano al servidor).

.PARAMETER Reindex
    Re-lee los PDF almacenados con OCR después de desplegar. Tarda ~2 s por
    página escaneada; el chat sigue funcionando mientras corre.

.PARAMETER ReindexAll
    Re-indexa todos los documentos, no solo PDF. Necesario solo si cambió el
    modelo de embeddings.

.PARAMETER DryRun
    Muestra lo que haría y termina sin tocar nada.

.EXAMPLE
    .\scripts\deploy-prod.ps1 -DryRun
    Revisa qué se desplegaría.

.EXAMPLE
    .\scripts\deploy-prod.ps1 -Reindex
    Despliegue completo y re-lectura de los manuales escaneados.
#>
[CmdletBinding()]
param(
    [switch]$SkipPull,
    [switch]$Reindex,
    [switch]$ReindexAll,
    [switch]$IncludeMedia,
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$compose = "docker-compose.prod.yml"

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Ok($msg)   { Write-Host "  OK $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "  X $msg" -ForegroundColor Red }

Step "Entorno"
Write-Host "  Repo:    $repo"
if (-not (Test-Path $compose)) { throw "No se encontró $compose. ¿Estás en la raíz del repo en el servidor?" }
if (-not (Test-Path ".env"))   { throw "Falta .env. Cópialo de .env.prod.example y complétalo antes de desplegar." }
if (-not (Test-Path "gcp-credentials.json")) {
    throw "Falta gcp-credentials.json (la cuenta de servicio de Vertex AI). El backend no arrancará sin ella."
}
Ok ".env y credenciales presentes"

try { docker info 2>&1 | Out-Null } catch { throw "Docker no responde en el servidor." }
if ($LASTEXITCODE -ne 0) { throw "Docker no responde en el servidor." }
Ok "Docker responde"

# Puerto público de nginx, tal como lo resuelve el compose.
$nginxPort = (Select-String -Path ".env" -Pattern "^NGINX_HOST_PORT=(.+)$").Matches.Groups[1].Value
if (-not $nginxPort) { $nginxPort = "8082" }
Write-Host "  nginx:   127.0.0.1:$nginxPort"

# ── Qué se va a desplegar ───────────────────────────────────────────────────
Step "Cambios a desplegar"
$isGit = Test-Path ".git"
if ($isGit -and -not $SkipPull) {
    git fetch --quiet
    $current = (git rev-parse --short HEAD)
    $branch  = (git rev-parse --abbrev-ref HEAD)
    Write-Host "  Rama actual: $branch @ $current"
    $incoming = git log --oneline "HEAD..origin/$branch"
    if ($incoming) {
        Write-Host "  Commits entrantes:" -ForegroundColor White
        $incoming | ForEach-Object { Write-Host "    $_" }
    } else {
        Ok "Ya está al día con origin/$branch"
    }
} elseif (-not $isGit) {
    Warn "No es un repositorio git: se desplegará lo que ya está en disco."
} else {
    Warn "-SkipPull: se desplegará lo que ya está en disco."
}

if ($DryRun) {
    Step "DryRun"
    Write-Host "  Se ejecutaría:"
    if ($isGit -and -not $SkipPull) { Write-Host "    git pull" }
    Write-Host "    docker compose -f $compose build"
    Write-Host "    docker compose -f $compose up -d"
    Write-Host "    health check en http://127.0.0.1:$nginxPort/health"
    if ($Reindex -or $ReindexAll) { Write-Host "    python reindex_all.py" }
    Write-Host "`n  Nada fue modificado." -ForegroundColor DarkGray
    return
}

if (-not $Force) {
    Write-Host ""
    $answer = Read-Host "¿Continuar con el despliegue? (escribe 'si' para confirmar)"
    if ($answer -ne "si") { Write-Host "Cancelado."; return }
}

# ── Pull ────────────────────────────────────────────────────────────────────
if ($isGit -and -not $SkipPull) {
    Step "git pull"
    git pull --ff-only
    if ($LASTEXITCODE -ne 0) {
        throw "git pull falló (¿cambios locales en el servidor?). Resuélvelo a mano antes de continuar."
    }
    Ok "Código actualizado a $(git rev-parse --short HEAD)"
}

# ── Build ───────────────────────────────────────────────────────────────────
# El backend copia el código dentro de la imagen: sin build, el contenedor
# seguiría corriendo la versión anterior aunque los archivos en disco cambien.
Step "Construyendo imágenes (puede tardar bastante en este servidor)"
docker compose -f $compose build
if ($LASTEXITCODE -ne 0) { throw "Falló el build. No se reinició nada; el servicio anterior sigue en pie." }
Ok "Imágenes construidas"

# ── Up ──────────────────────────────────────────────────────────────────────
Step "Levantando servicios"
docker compose -f $compose up -d
if ($LASTEXITCODE -ne 0) { throw "Falló `docker compose up`." }

Step "Health check"
$healthy = $false
foreach ($i in 1..60) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$nginxPort/health" -TimeoutSec 3 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $healthy = $true; break }
    } catch { Start-Sleep -Seconds 3 }
}
if (-not $healthy) {
    Fail "El backend no respondió a través de nginx en ~3 min."
    docker compose -f $compose ps
    docker compose -f $compose logs --tail 60 backend
    throw "Despliegue incompleto: health check fallido. NO se ejecutó el re-indexado."
}
Ok "http://127.0.0.1:$nginxPort/health responde"

try {
    $db = Invoke-WebRequest -Uri "http://127.0.0.1:$nginxPort/health/db" -TimeoutSec 10 -UseBasicParsing
    if ($db.StatusCode -eq 200) { Ok "Base de datos alcanzable" }
} catch { Warn "/health/db falló: $_" }

Step "Verificando OCR"
$tess = docker compose -f $compose exec -T backend tesseract --version 2>&1 | Select-Object -First 1
if ($LASTEXITCODE -eq 0 -and $tess) {
    Ok "$tess"
    $langs = docker compose -f $compose exec -T backend tesseract --list-langs 2>&1 | Select-String "^spa$"
    if ($langs) { Ok "paquete de idioma 'spa' presente" }
    else { Warn "Falta el paquete 'spa' — el OCR leerá el español con el modelo inglés." }
} else {
    Warn "Tesseract no está en la imagen: el OCR se desactivará solo y los PDF"
    Warn "escaneados se volverán a indexar vacíos. Revisa que el build haya usado"
    Warn "el Dockerfile actualizado."
}

# ── Re-indexado ─────────────────────────────────────────────────────────────
if ($Reindex -or $ReindexAll) {
    $rargs = @("reindex_all.py")
    if (-not $ReindexAll) { $rargs += @("--only", "pdf") }
    if ($IncludeMedia)    { $rargs += "--include-media" }
    Step "Re-indexando documentos almacenados"
    Warn "Reemplaza los chunks archivo por archivo. Si se interrumpe, cada archivo"
    Warn "conserva su indexado anterior — se puede volver a ejecutar sin riesgo."
    docker compose -f $compose exec -T backend python @rargs
    if ($LASTEXITCODE -ne 0) { Warn "El re-indexado terminó con errores — revisa la salida de arriba." }
    else { Ok "Re-indexado completo" }
}

Step "Despliegue terminado"
docker compose -f $compose ps
Write-Host ""
Write-Host "  Verifica en el navegador a través de IIS antes de darlo por bueno." -ForegroundColor DarkGray
Write-Host "  Para medir la recuperación:" -ForegroundColor DarkGray
Write-Host "    docker compose -f $compose exec backend python rag_eval.py --sweep" -ForegroundColor DarkGray
