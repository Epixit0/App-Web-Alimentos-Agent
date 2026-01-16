param(
  [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
)

$ErrorActionPreference = "Stop"

$wixBin = ${env:WIX}
if (-not $wixBin) {
  # Rutas comunes de WiX v3
  $candidates = @(
    "C:\Program Files (x86)\WiX Toolset v3.14\bin",
    "C:\Program Files (x86)\WiX Toolset v3.11\bin"
  )
  $wixBin = ($candidates | Where-Object { Test-Path $_ } | Select-Object -First 1)
}

if (-not $wixBin) {
  throw "No se encontró WiX bin. Instala WiX Toolset v3.x o setea env:WIX al path bin."
}

$candle = Join-Path $wixBin "candle.exe"
$light = Join-Path $wixBin "light.exe"
$heat  = Join-Path $wixBin "heat.exe"

if (!(Test-Path $candle) -or !(Test-Path $light) -or !(Test-Path $heat)) {
  throw "No se encontró WiX. Instala WiX Toolset v3.x y/o setea env:WIX al path bin."
}

function Invoke-Tool {
  param(
    [Parameter(Mandatory=$true)][string]$Exe,
    [Parameter(Mandatory=$true)][string[]]$Args
  )
  & $Exe @Args
  if ($LASTEXITCODE -ne 0) {
    throw "Falló: $Exe (exit=$LASTEXITCODE)"
  }
}

function Normalize-HeatOutput {
  param(
    [Parameter(Mandatory=$true)][string]$Path
  )
  if (!(Test-Path $Path)) { return }

  $content = Get-Content -Raw -LiteralPath $Path

  # En algunos entornos, heat puede emitir $(PayloadDir) (sin prefijo). Candle espera $(var.PayloadDir).
  if ($content -match '\$\(PayloadDir\)') {
    $content = $content -replace '\$\(PayloadDir\)', '$(var.PayloadDir)'
  }

  # heat a veces deja Guid placeholders; Guid="*" es válido y permite compilar.
  if ($content -match 'Guid="PUT-GUID-HERE"') {
    $content = $content -replace 'Guid="PUT-GUID-HERE"', 'Guid="*"'
  }

  Set-Content -LiteralPath $Path -Value $content -Encoding UTF8
}

$payloadRoot = Join-Path $RepoRoot "installer\dist\payload"
$payloadApp = Join-Path $payloadRoot "app"
$payloadNode = Join-Path $payloadRoot "node"
if (!(Test-Path $payloadRoot)) {
  throw "No existe payload. Ejecuta primero: installer\\scripts\\stage.ps1"
}
if (!(Test-Path $payloadApp)) { throw "No existe payload\\app" }
if (!(Test-Path $payloadNode)) { throw "No existe payload\\node" }

$outDir = Join-Path $RepoRoot "installer\dist"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$harvestAppWxs = Join-Path $outDir "Harvest.App.wxs"
$harvestNodeWxs = Join-Path $outDir "Harvest.Node.wxs"
$productWxs = Join-Path $RepoRoot "installer\wix\Product.wxs"

Write-Host "Harvesting app/ with heat..." -ForegroundColor Cyan
Invoke-Tool $heat @(
  "dir", $payloadApp,
  "-nologo",
  "-cg", "AppComponentGroup",
  "-dr", "INSTALLFOLDER",
  "-gg",
  "-sreg", "-scom", "-sfrag",
  "-var", "var.PayloadDir",
  "-out", $harvestAppWxs
)
Normalize-HeatOutput -Path $harvestAppWxs

Write-Host "Harvesting node/ with heat..." -ForegroundColor Cyan
Invoke-Tool $heat @(
  "dir", $payloadNode,
  "-nologo",
  "-cg", "NodeComponentGroup",
  "-dr", "INSTALLFOLDER",
  "-gg",
  "-sreg", "-scom", "-sfrag",
  "-var", "var.PayloadDir",
  "-out", $harvestNodeWxs
)
Normalize-HeatOutput -Path $harvestNodeWxs

# Candle/Light
$obj1 = Join-Path $outDir "Product.wixobj"
$obj2 = Join-Path $outDir "Harvest.App.wixobj"
$obj3 = Join-Path $outDir "Harvest.Node.wixobj"

Write-Host "Compiling wixobj..." -ForegroundColor Cyan
Invoke-Tool $candle @(
  "-nologo",
  "-out", $obj1,
  $productWxs
)

# Cada harvest usa $(var.PayloadDir) apuntando a su raíz real
Invoke-Tool $candle @(
  "-nologo",
  "-dPayloadDir=$payloadApp",
  "-out", $obj2,
  $harvestAppWxs
)
Invoke-Tool $candle @(
  "-nologo",
  "-dPayloadDir=$payloadNode",
  "-out", $obj3,
  $harvestNodeWxs
)

$msi = Join-Path $outDir "MarCaribeFingerprintAgent.msi"
Write-Host "Linking MSI..." -ForegroundColor Cyan
Invoke-Tool $light @(
  "-nologo",
  "-ext", "WixUtilExtension",
  "-out", $msi,
  $obj1, $obj2, $obj3
)

if (!(Test-Path $msi)) {
  throw "No se generó el MSI esperado: $msi"
}

Write-Host "OK MSI generado -> $msi" -ForegroundColor Green
