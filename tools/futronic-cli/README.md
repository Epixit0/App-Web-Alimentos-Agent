# futronic-cli

CLI Windows para generar templates Futronic (enroll) en un proceso separado del agente Node.

## Requisitos

- Windows
- .NET SDK 8 (o Visual Studio Build Tools con .NET)
- Futronic SDK instalado (para tener `FTRAPI.dll` y dependencias)

## Build

Desde esta carpeta:

```powershell
# x64
 dotnet publish -c Release -r win-x64 /p:PublishSingleFile=true
```

Si tu SDK es **x86 (32-bit)**, publica así:

```powershell
dotnet publish -c Release -r win-x86 /p:PublishSingleFile=true
```

Si al ejecutar el exe x86 te sale:

> The framework 'Microsoft.NETCore.App', version '8.0.0' (x86) was not found

entonces tienes 2 opciones:

1. Publicar **self-contained** (recomendado, no depende del runtime instalado):

```powershell
dotnet publish .\FutronicCli.csproj -c Release -r win-x86 /p:PublishSingleFile=true --self-contained true -o .\dist-x86
```

2. Instalar el runtime .NET 8 x86 en esa PC.

Si quieres evitar rutas largas y asegurar dónde queda el exe, usa `-o`:

```powershell
dotnet publish .\FutronicCli.csproj -c Release -r win-x64 /p:PublishSingleFile=true -o .\dist
```

Para x86 con salida clara:

```powershell
dotnet publish .\FutronicCli.csproj -c Release -r win-x86 /p:PublishSingleFile=true -o .\dist-x86
```

El exe queda en:

- `bin/Release/net8.0-windows/win-x64/publish/futronic-cli.exe`

Verificar que el exe existe:

```powershell
Test-Path .\bin\Release\net8.0-windows\win-x64\publish\futronic-cli.exe
Get-ChildItem -Recurse -Filter futronic-cli.exe | Select-Object -ExpandProperty FullName
```

## Ejecutar

```powershell
$ftr = "C:\FutronicSDK\FTRAPI.dll"
./bin/Release/net8.0-windows/win-x64/publish/futronic-cli.exe enroll --dll $ftr --purpose 3
```

Si publicaste con `-o .\dist`, entonces:

```powershell
$ftr = "C:\FutronicSDK\FTRAPI.dll"
.\dist\futronic-cli.exe enroll --dll $ftr --purpose 3
```

Para x86:

```powershell
$ftr = "C:\FutronicSDK\FTRAPI.dll"
.\dist-x86\futronic-cli.exe enroll --dll $ftr --purpose 3
```

Nota: el CLI ajusta `CurrentDirectory` al folder de `--dll` y hace `LoadLibrary` por ruta completa para reducir problemas de dependencias.

### Error `win32=193`

Si ves:

- `{"stage":"loadLibrary", "win32":193, ...}`

normalmente es **mismatch x86/x64** (por ejemplo, exe x64 intentando cargar `FTRAPI.dll` x86).

Opciones:

1. Publica el exe en `win-x86` y vuelve a intentar.

2. Ubica un `FTRAPI.dll` x64 (a veces está en otra carpeta del SDK) y apunta `--dll` a ese:

```powershell
Get-ChildItem -Recurse C:\FutronicSDK -Filter FTRAPI.dll | Select-Object -ExpandProperty FullName
```

3. Solo para diagnosticar (fallback al comportamiento sin forzar ruta completa):

```powershell
.\dist\futronic-cli.exe enroll --dll $ftr --purpose 3 --noLoadLibrary 1
```

## Opciones útiles (debug)

- Elegir API (algunos SDKs traen también `MT*` y el demo usa ese motor):

```powershell
# forzar MT*
.\dist-x86\futronic-cli.exe enroll --dll $ftr --purpose 3 --api mt

# forzar FTR*
.\dist-x86\futronic-cli.exe enroll --dll $ftr --purpose 3 --api ftr
```

Notas MT\*:

- Este SDK exporta `MTInitialize@4`, `MTTerminate@4`, `MTCaptureFrame@12`, `MTEnrollX@20` (según `scripts/dump-exports.js`).
- Por eso el CLI expone knobs por si el SDK espera flags extra:

```powershell
.\dist-x86\futronic-cli.exe enroll --dll $ftr --purpose 3 --api mt --mtInitArg 0 --mtTermArg 0 --mtEnrollArg5 0
```

- Elegir método:

```powershell
.\dist\futronic-cli.exe enroll --dll $ftr --purpose 3 --method enrollx
.\dist\futronic-cli.exe enroll --dll $ftr --purpose 3 --method enroll
```

- Pre-capture antes de enroll (algunos SDKs lo agradecen). `captureArg2` depende del SDK, pero puedes probar valores:

```powershell
.\dist\futronic-cli.exe enroll --dll $ftr --purpose 3 --preCapture 1 --captureArg2 1000
```

- `CaptureFrame` devuelve 201 siempre (tu caso): usa probe para descubrir qué `FTRSetParam` cambia el resultado.

```powershell
# Probar con arg2 como timeout
.\dist-x86\futronic-cli.exe enroll --dll $ftr --purpose 3 --probeCapture 1 --captureArg2Mode timeout --captureArg2 5000

# Probar abriendo scan device pero pasando HWND (si tienes ftrScanAPI.dll)
$scan = "C:\FutronicSDK\ftrScanAPI.dll"
.\dist-x86\futronic-cli.exe enroll --dll $ftr --scanDll $scan --handle hwnd+scan --purpose 3 --probeCapture 1 --captureArg2Mode timeout --captureArg2 5000

# Puedes acotar ids/valores
.\dist-x86\futronic-cli.exe enroll --dll $ftr --probeCapture 1 --probeId 4 --probeId 5 --probeVal 0 --probeVal 1 --probeVal 2 --captureArg2Mode timeout --captureArg2 5000
```

### Receta que ya dio señal (201 -> 203)

En tu máquina, `FTRSetParam(4,1)` + `CaptureFrame(arg2=5000)` cambió de `201` a `203`.
El paso siguiente es hacer loop hasta que devuelva `0` (captura OK) y recién ahí intentar `EnrollX`:

```powershell
$ftr = "C:\FutronicSDK\FTRAPI.dll"
.\dist-x86\futronic-cli.exe enroll --dll $ftr --purpose 3 --method enrollx --param 4=1 --captureLoop 1 --captureArg2Mode timeout --captureArg2 5000 --captureLoopMax 80 --captureLoopDelayMs 150 --captureRequireOk 1
```

- SetParam (puedes repetirlo):

```powershell
.\dist\futronic-cli.exe enroll --dll $ftr --purpose 3 --param 4=1 --param 5=0
```

- Probar HWND nulo (solo para diagnosticar):

```powershell
.\dist\futronic-cli.exe enroll --dll $ftr --purpose 3 --nullHwnd 1
```

- Abrir dispositivo vía `ftrScanAPI.dll` y usar ese handle (útil si `FTREnroll` falla con `201` usando HWND):

```powershell
$scan = "C:\FutronicSDK\ftrScanAPI.dll"  # ajusta la ruta real
.\dist-x86\futronic-cli.exe enroll --dll $ftr --scanDll $scan --handle scan --purpose 3 --method enrollx
```

Salida (stdout):

- JSON con `ok`, `code`, y si `ok=true`, `templateBase64`.
- En modo debug también incluye `setParams` (resultado de cada `FTRSetParam`) y `preCaptureCode`.

## Nota

Este helper usa P/Invoke directo a `FTRAPI.dll`. Si tu SDK incluye wrappers .NET oficiales, es mejor usarlos aquí.
