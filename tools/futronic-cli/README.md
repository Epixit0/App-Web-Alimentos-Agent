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

El exe queda en:

- `bin/Release/net8.0-windows/win-x64/publish/futronic-cli.exe`

## Ejecutar

```powershell
$ftr = "C:\FutronicSDK\FTRAPI.dll"
./bin/Release/net8.0-windows/win-x64/publish/futronic-cli.exe enroll --dll $ftr --purpose 3
```

Salida (stdout):

- JSON con `ok`, `code`, y si `ok=true`, `templateBase64`.

## Nota

Este helper usa P/Invoke directo a `FTRAPI.dll`. Si tu SDK incluye wrappers .NET oficiales, es mejor usarlos aquí.
