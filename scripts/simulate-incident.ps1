<#
.SYNOPSIS
    Simula un monitor externo: abre o resuelve un incidente en Nexus vía webhook.

.DESCRIPTION
    Envía exactamente la petición que mandaría una herramienta de monitoreo real
    (Uptime Kuma, una tarea programada, etc.):

        POST /api/status/incidents      cabecera X-Status-Key: <clave>

    El aviso aparece para todos los usuarios en su siguiente consulta de estado
    (máximo ~1 minuto, o al instante al recargar la página). Sirve para la demo y
    como referencia para conectar un monitor real después.

    La clave se toma, en este orden, de -Key, de la variable de entorno
    STATUS_WEBHOOK_KEY o de la línea STATUS_WEBHOOK_KEY del .env en la raíz del
    repo. Contra localhost, si no hay ninguna, usa "dev-status-key" (el valor por
    defecto de docker-compose.yml).

.PARAMETER Open
    Abre el incidente. Si ya estaba abierto con la misma clave, lo actualiza.

.PARAMETER Resolve
    Resuelve el incidente abierto con esa clave.

.PARAMETER Message
    Texto que verán los usuarios (solo con -Open).

.PARAMETER Update
    Agrega una noticia al incidente, p. ej. "Encontramos el error y trabajamos en ello".

.PARAMETER EtaMinutes
    Tiempo estimado de solución en minutos (solo con -Open).

.PARAMETER Contact
    Teléfono u otro contacto que se muestra mientras dura el incidente.

.PARAMETER NoBlockChat
    No bloquear el envío de mensajes (por defecto sí se bloquea).

.EXAMPLE
    .\scripts\simulate-incident.ps1 -Open -EtaMinutes 45 -Contact "45454545"

.EXAMPLE
    .\scripts\simulate-incident.ps1 -Open -Update "Encontramos el error y trabajamos en ello"

.EXAMPLE
    .\scripts\simulate-incident.ps1 -Resolve
#>
[CmdletBinding()]
param(
    [switch]$Open,
    [switch]$Resolve,
    [string]$Message = "Detectamos una falla en el servicio. Estamos trabajando para restablecerlo.",
    [string]$Update,
    [int]$EtaMinutes = 0,
    [string]$Contact,
    [ValidateSet("info", "warning", "critical")]
    [string]$Severity = "critical",
    [switch]$NoBlockChat,
    [string]$IncidentKey = "monitor-externo-demo",
    [string]$BaseUrl = "http://localhost:8000",
    [string]$Key
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

if ($Open -eq $Resolve) {
    Write-Host "Indica exactamente una acción: -Open o -Resolve." -ForegroundColor Red
    exit 1
}

if (-not $Key) { $Key = $env:STATUS_WEBHOOK_KEY }
if (-not $Key) {
    $envFile = Join-Path $repo ".env"
    if (Test-Path $envFile) {
        $line = Get-Content $envFile | Where-Object { $_ -match '^\s*STATUS_WEBHOOK_KEY\s*=' } | Select-Object -First 1
        if ($line) { $Key = ($line -split '=', 2)[1].Trim() }
    }
}
if (-not $Key -and $BaseUrl -match 'localhost|127\.0\.0\.1') { $Key = "dev-status-key" }
if (-not $Key) {
    Write-Host "No encontré la clave del webhook. Usa -Key o define STATUS_WEBHOOK_KEY." -ForegroundColor Red
    exit 1
}

$action = "resolve"
if ($Open) { $action = "open" }

$body = [ordered]@{ incident_key = $IncidentKey; action = $action }
if ($Open) {
    $body["message"] = $Message
    $body["severity"] = $Severity
    $body["blocks_chat"] = -not $NoBlockChat
    if ($EtaMinutes -gt 0) { $body["eta_minutes"] = $EtaMinutes }
    if ($Contact) { $body["contact"] = $Contact }
}
if ($Update) { $body["update"] = $Update }

$json = $body | ConvertTo-Json -Compress
# Windows PowerShell 5.1 would send a string body as ISO-8859-1 and mangle the accents.
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
$uri = "$($BaseUrl.TrimEnd('/'))/api/status/incidents"

try {
    $resp = Invoke-RestMethod -Method Post -Uri $uri -Body $bytes `
        -ContentType "application/json; charset=utf-8" -Headers @{ "X-Status-Key" = $Key }
} catch {
    $code = $null
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    switch ($code) {
        401 { Write-Host "Clave rechazada (401). Revisa STATUS_WEBHOOK_KEY." -ForegroundColor Red }
        404 { Write-Host "Webhook deshabilitado (404): STATUS_WEBHOOK_KEY está vacío en el backend." -ForegroundColor Red }
        422 { Write-Host "Petición inválida (422): $($_.ErrorDetails.Message)" -ForegroundColor Red }
        default { Write-Host "No se pudo contactar $uri : $($_.Exception.Message)" -ForegroundColor Red }
    }
    exit 1
}

$labels = @{
    opened   = "Incidente abierto"
    updated  = "Incidente actualizado"
    resolved = "Incidente resuelto"
    not_open = "No había un incidente abierto con esa clave"
}
Write-Host "$($labels[$resp.state]) ($IncidentKey)" -ForegroundColor Green
if ($resp.id) { Write-Host "  id: $($resp.id)" }
