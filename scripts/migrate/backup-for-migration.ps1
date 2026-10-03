<#
.SYNOPSIS
  Snapshot everything stateful (Postgres + uploaded files) from the CURRENT prod
  stack into one folder, with a manifest of row counts and checksums.
  Read-only against the stack: it only runs pg_dump and tar inside containers.

.EXAMPLE
  .\scripts\migrate\backup-for-migration.ps1
  .\scripts\migrate\backup-for-migration.ps1 -OutDir D:\respaldos\nexus-2026-10-05
#>
param(
    [string]$OutDir = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) ("migration-backup-" + (Get-Date -Format "yyyyMMdd-HHmm"))),
    [string]$ComposeFile = "docker-compose.prod.yml"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
New-Item -ItemType Directory -Force $OutDir | Out-Null

function Dc { & docker compose -f $ComposeFile @args; if ($LASTEXITCODE -ne 0) { throw "docker compose $args failed" } }

Write-Host "== 1/4 pg_dump (custom format)"
# Dump inside the container and docker cp it out: piping binary through
# PowerShell 5.1 re-encodes it and corrupts the file.
Dc exec -T db pg_dump -U nexus -d nexus_agent -Fc -f /tmp/nexus_agent.dump
Dc cp db:/tmp/nexus_agent.dump (Join-Path $OutDir "nexus_agent.dump")
Dc exec -T db rm -f /tmp/nexus_agent.dump

Write-Host "== 2/4 uploaded files (/data)"
Dc exec -T backend tar czf /tmp/nexus_data.tgz -C /data .
Dc cp backend:/tmp/nexus_data.tgz (Join-Path $OutDir "nexus_data.tgz")
Dc exec -T backend rm -f /tmp/nexus_data.tgz

Write-Host "== 3/4 manifest (row counts + file count)"
$tables = "users","document_chunks","chat_sessions","chat_messages","response_cache","message_feedback","escalation_requests","status_banners"
$lines = @()
foreach ($t in $tables) {
    $n = (Dc exec -T db psql -U nexus -d nexus_agent -tAc "SELECT count(*) FROM $t").Trim()
    $lines += "table:$t=$n"
}
$files = (Dc exec -T backend sh -c "find /data -type f | wc -l").Trim()
$lines += "files:data=$files"
$lines | Set-Content -Encoding ascii (Join-Path $OutDir "manifest.txt")

Write-Host "== 4/4 checksums + sanity"
$sums = foreach ($f in "nexus_agent.dump","nexus_data.tgz") {
    $p = Join-Path $OutDir $f
    if ((Get-Item $p).Length -lt 1024) { throw "$f is suspiciously small" }
    "$((Get-FileHash $p -Algorithm SHA256).Hash.ToLower())  $f"
}
$sums | Set-Content -Encoding ascii (Join-Path $OutDir "SHA256SUMS")
# The dump must be a readable archive, not just a non-empty file.
Dc cp (Join-Path $OutDir "nexus_agent.dump") db:/tmp/check.dump
Dc exec -T db sh -c "pg_restore --list /tmp/check.dump > /dev/null && rm /tmp/check.dump"

Write-Host ""
Write-Host "OK -> $OutDir" -ForegroundColor Green
Get-Content (Join-Path $OutDir "manifest.txt")
Write-Host "Copy this folder OFF this server and keep it until the migration is verified."
