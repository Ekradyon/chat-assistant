# ============================================================================
# build.ps1 -- Empaqueta la SPA chat-assistant para Models.WebPackage de Airflows.
# Genera ZIP con estructura plana bajo subcarpeta 'chat-assistant/' para no
# pisar el root del admin Airflows.
#
# Patron STATIC: index.html con paths relativos.
#
#     chat-assistant.zip
#       chat-assistant/
#         index.html
#         assets/{app.css, app.js, data.js}
#         lib/{alpine.min.js, vis-network.min.js}
#
# Uso:
#     .\build.ps1
# ============================================================================

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Output = Join-Path $Root 'chat-assistant.zip'
$Staging = Join-Path $env:TEMP "chat-assistant-build-$(Get-Random)"

$Mapping = @{
    'index.html'             = 'chat-assistant/index.html'
    'assets/app.css'         = 'chat-assistant/assets/app.css'
    'assets/app.js'          = 'chat-assistant/assets/app.js'
    'assets/data.js'         = 'chat-assistant/assets/data.js'
    'lib/alpine.min.js'      = 'chat-assistant/lib/alpine.min.js'
    'lib/vis-network.min.js' = 'chat-assistant/lib/vis-network.min.js'
}

Write-Host "Modo: STATIC (subcarpeta chat-assistant/)" -ForegroundColor Cyan

$missing = @()
foreach ($src in $Mapping.Keys) {
    $full = Join-Path $Root $src
    if (-not (Test-Path -LiteralPath $full)) { $missing += $src }
}
if ($missing.Count -gt 0) {
    Write-Host "[ERROR] Archivos faltantes:" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}

if (Test-Path -LiteralPath $Output) {
    Write-Host "Removiendo ZIP anterior $Output"
    Remove-Item -LiteralPath $Output -Force
}

if (Test-Path -LiteralPath $Staging) { Remove-Item -LiteralPath $Staging -Recurse -Force }
New-Item -ItemType Directory -Path $Staging | Out-Null

$totalBytes = 0
foreach ($src in $Mapping.Keys) {
    $dst = Join-Path $Staging $Mapping[$src]
    $dstDir = Split-Path -Parent $dst
    if (-not (Test-Path -LiteralPath $dstDir)) {
        New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
    }
    $srcFull = Join-Path $Root $src
    Copy-Item -LiteralPath $srcFull -Destination $dst -Force
    $totalBytes += (Get-Item -LiteralPath $srcFull).Length
}

Write-Host "Empaquetando $($Mapping.Count) archivos..." -ForegroundColor Cyan
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $Staging, $Output,
    [System.IO.Compression.CompressionLevel]::Optimal, $false
)

Remove-Item -LiteralPath $Staging -Recurse -Force

$zipInfo = Get-Item -LiteralPath $Output
$kb = [math]::Round($zipInfo.Length / 1KB, 1)
Write-Host ""
Write-Host "[OK] Build listo: $Output ($kb KB, $($Mapping.Count) archivos, total fuente=$([math]::Round($totalBytes/1KB,1)) KB)" -ForegroundColor Green
