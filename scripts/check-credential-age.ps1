<#
.SYNOPSIS
    Avisa cuando una credencial registrada en ops/credentials.json se acerca a
    su vida máxima (90 días) o ya la pasó.

.DESCRIPTION
    Lee ops/credentials.json (fecha de creación + max_age_days). No necesita
    acceso a GCP: la fecha la actualiza a mano quien rota la clave (ver
    ops/ROTATE_GCP_KEY.md). Lo usan el workflow semanal de GitHub Actions y
    deploy-prod.ps1, y se puede correr en local.

    Códigos de salida: 0 = vigente, 2 = vence en <= warn_days, 1 = vencida.

.EXAMPLE
    .\scripts\check-credential-age.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$file = Join-Path (Join-Path $root "ops") "credentials.json"
if (-not (Test-Path $file)) { Write-Host "No existe $file"; exit 1 }

$cfg   = Get-Content $file -Raw | ConvertFrom-Json
$today = (Get-Date).ToUniversalTime().Date
$inv   = [System.Globalization.CultureInfo]::InvariantCulture
$code  = 0

foreach ($c in $cfg.credentials) {
    $created = [datetime]::ParseExact($c.created, "yyyy-MM-dd", $inv)
    $due     = $created.AddDays([int]$cfg.max_age_days)
    $left    = [int]($due - $today).TotalDays
    $msg = "$($c.name): creada $($c.created), rotar antes de $($due.ToString('yyyy-MM-dd')) (quedan $left días). Guía: $($c.runbook)"
    $ci  = [bool]$env:GITHUB_ACTIONS
    if ($left -lt 0) {
        if ($ci) { Write-Host "::error::VENCIDA - $msg" } else { Write-Host "  X VENCIDA - $msg" -ForegroundColor Red }
        $code = 1
    } elseif ($left -le [int]$cfg.warn_days) {
        if ($ci) { Write-Host "::warning::Por vencer - $msg" } else { Write-Host "  ! Por vencer - $msg" -ForegroundColor Yellow }
        if ($code -eq 0) { $code = 2 }
    } else {
        Write-Host "  OK $msg"
    }
}
exit $code
