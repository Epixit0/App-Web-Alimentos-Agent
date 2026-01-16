param(
  [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
)

$ErrorActionPreference = "Stop"

$payload = Join-Path $RepoRoot "installer\dist\payload"
$payloadApp = Join-Path $payload "app"
$payloadNode = Join-Path $payload "node"
$payloadService = Join-Path $payload "service"

Write-Host "Staging payload -> $payload" -ForegroundColor Cyan

# Clean
if (Test-Path $payload) { Remove-Item -Recurse -Force $payload }
New-Item -ItemType Directory -Force -Path $payloadApp | Out-Null
New-Item -ItemType Directory -Force -Path $payloadNode | Out-Null
New-Item -ItemType Directory -Force -Path $payloadService | Out-Null

# Copy app sources (exclude installer/dist and .git)
$exclude = @("installer", "dist", ".git", "node_modules")

Get-ChildItem -LiteralPath $RepoRoot -Force | ForEach-Object {
  if ($exclude -contains $_.Name) { return }
  Copy-Item -Recurse -Force -LiteralPath $_.FullName -Destination $payloadApp
}

# Copy node_modules (must exist)
$nodeModules = Join-Path $RepoRoot "node_modules"
if (!(Test-Path $nodeModules)) {
  throw "node_modules no existe. Ejecuta 'npm install' primero."
}
Copy-Item -Recurse -Force -LiteralPath $nodeModules -Destination (Join-Path $payloadApp "node_modules")

# Copy embedded Node
$embeddedNode = Join-Path $RepoRoot "installer\assets\node"
$embeddedNodeExe = Join-Path $embeddedNode "node.exe"
if (!(Test-Path $embeddedNodeExe)) {
  Write-Host "No existe node.exe embebido en: $embeddedNodeExe" -ForegroundColor Yellow
  Write-Host "Intentando localizar node.exe en el PATH..." -ForegroundColor Yellow

  $found = $null
  try {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { $found = $cmd.Source }
  } catch {}

  if (-not $found) {
    try {
      $paths = & where.exe node 2>$null
      if ($LASTEXITCODE -eq 0 -and $paths) {
        $found = ($paths | Select-Object -First 1)
      }
    } catch {}
  }

  if (-not $found -or !(Test-Path $found)) {
    throw "Falta Node embebido en: $embeddedNodeExe. Copia node.exe ahí (o instala Node y asegúrate que 'node' funcione en PowerShell)."
  }

  New-Item -ItemType Directory -Force -Path $embeddedNode | Out-Null
  Copy-Item -Force -LiteralPath $found -Destination $embeddedNodeExe
  Write-Host "OK: copiado node.exe desde: $found" -ForegroundColor Green
}
Copy-Item -Recurse -Force -LiteralPath $embeddedNode\* -Destination $payloadNode

# Copy WinSW service wrapper
$winswDir = Join-Path $RepoRoot "installer\assets\winsw"
$winswExe = Join-Path $winswDir "MarCaribeFingerprintAgent.exe"
$winswXml = Join-Path $winswDir "MarCaribeFingerprintAgent.xml"
if (!(Test-Path $winswExe)) {
  throw "Falta WinSW wrapper en: $winswExe. Descarga WinSW y renómbralo a MarCaribeFingerprintAgent.exe"
}
if (!(Test-Path $winswXml)) {
  throw "Falta configuración WinSW en: $winswXml"
}
Copy-Item -Force -LiteralPath $winswExe -Destination $payloadService
Copy-Item -Force -LiteralPath $winswXml -Destination $payloadService

# Default config (only used by MSI on first install)
$cfgExample = Join-Path $RepoRoot "agent.config.example.json"
if (Test-Path $cfgExample) {
  Copy-Item -Force -LiteralPath $cfgExample -Destination (Join-Path $payload "config.example.json")
}

Write-Host "OK staging listo." -ForegroundColor Green
