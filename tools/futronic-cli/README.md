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

Si quieres evitar rutas largas y asegurar dónde queda el exe, usa `-o`:

```powershell
dotnet publish .\FutronicCli.csproj -c Release -r win-x64 /p:PublishSingleFile=true -o .\dist
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

- Elegir método:

```powershell
.\dist\futronic-cli.exe enroll --dll $ftr --purpose 3 --method enrollx
.\dist\futronic-cli.exe enroll --dll $ftr --purpose 3 --method enroll
```

- Pre-capture antes de enroll (algunos SDKs lo agradecen). `captureArg2` depende del SDK, pero puedes probar valores:

```powershell
.\dist\futronic-cli.exe enroll --dll $ftr --purpose 3 --preCapture 1 --captureArg2 1000
```

- SetParam (puedes repetirlo):

```powershell
.\dist\futronic-cli.exe enroll --dll $ftr --purpose 3 --param 4=1 --param 5=0
```

- Probar HWND nulo (solo para diagnosticar):

```powershell
.\dist\futronic-cli.exe enroll --dll $ftr --purpose 3 --nullHwnd 1
```

Salida (stdout):

- JSON con `ok`, `code`, y si `ok=true`, `templateBase64`.
- En modo debug también incluye `setParams` (resultado de cada `FTRSetParam`) y `preCaptureCode`.

## Nota

Este helper usa P/Invoke directo a `FTRAPI.dll`. Si tu SDK incluye wrappers .NET oficiales, es mejor usarlos aquí.
