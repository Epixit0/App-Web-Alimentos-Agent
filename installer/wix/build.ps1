param(
  [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
)

$ErrorActionPreference = "Stop"

$wixBin = ${env:WIX}
if (-not $wixBin) {
  # Default WiX v3 path (ajusta si aplica)
  $wixBin = "C:\Program Files (x86)\WiX Toolset v3.11\bin"
}

$candle = Join-Path $wixBin "candle.exe"
$light = Join-Path $wixBin "light.exe"
$heat  = Join-Path $wixBin "heat.exe"

if (!(Test-Path $candle) -or !(Test-Path $light) -or !(Test-Path $heat)) {
  throw "No se encontró WiX. Instala WiX Toolset v3.x y/o setea env:WIX al path bin."
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
& $heat dir $payloadApp -nologo -cg AppComponentGroup -dr INSTALLFOLDER -sreg -scom -sfrag -var var.PayloadDir -out $harvestAppWxs

Write-Host "Harvesting node/ with heat..." -ForegroundColor Cyan
& $heat dir $payloadNode -nologo -cg NodeComponentGroup -dr INSTALLFOLDER -sreg -scom -sfrag -var var.PayloadDir -out $harvestNodeWxs

# Candle/Light
$obj1 = Join-Path $outDir "Product.wixobj"
$obj2 = Join-Path $outDir "Harvest.App.wixobj"
$obj3 = Join-Path $outDir "Harvest.Node.wixobj"

Write-Host "Compiling wixobj..." -ForegroundColor Cyan
& $candle -nologo -dPayloadDir="$payloadRoot" -out $obj1 $productWxs
& $candle -nologo -dPayloadDir="$payloadRoot" -out $obj2 $harvestAppWxs
& $candle -nologo -dPayloadDir="$payloadRoot" -out $obj3 $harvestNodeWxs

$msi = Join-Path $outDir "MarCaribeFingerprintAgent.msi"
Write-Host "Linking MSI..." -ForegroundColor Cyan
& $light -nologo -ext WixUtilExtension -out $msi $obj1 $obj2 $obj3

Write-Host "OK MSI generado -> $msi" -ForegroundColor Green
