# MSI (Windows) – MarCaribe Fingerprint Agent

Objetivo: generar un instalador **MSI** para Windows que:

- Copie el agente (JS + node_modules + DLLs Futronic) a `Program Files`.
- Cree/instale un **Windows Service** que arranque con Windows.
- Cree el config en `C:\ProgramData\MarCaribeFingerprintAgent\config.json` (solo si no existe).

> Nota importante (Win7/Win8): el MSI puede correr, pero el **runtime de Node** que empaques debe ser compatible con tu Windows. Node reciente no soporta Win7. Si necesitas Win7, hay que validar qué versión de Node + Koffi funciona para ese SO.

## Requisitos (solo en la PC donde compilas el MSI)

1. Windows 10/11 (recomendado) para compilar.
2. **WiX Toolset v3.x** instalado (incluye `candle.exe`, `light.exe`, `heat.exe`).
   - WiX v3 es lo más compatible para generar MSIs que instalen en Win7.

## Qué se instala

- Carpeta: `C:\Program Files\MarCaribe\FingerprintAgent\`
  - `node\node.exe` (runtime Node embebido)
  - `app\` (repo del agente + `node_modules` + `lib\*.dll`)
- Config: `C:\ProgramData\MarCaribeFingerprintAgent\config.json`
- Servicio: `MarCaribeFingerprintAgent`
  - Ejecuta: `node.exe app\\src\\agent.js --config C:\\ProgramData\\MarCaribeFingerprintAgent\\config.json`

## Paso 1 – Preparar el “staging” (archivos a empacar)

En Windows (PowerShell), desde la raíz del repo del agente:

```powershell
cd App-Web-Alimentos-Agent

# Instala dependencias del agente (en esa misma máquina)
npm install

# Crea staging en installer\\dist\\payload
powershell -ExecutionPolicy Bypass -File .\\installer\\scripts\\stage.ps1
```

Qué hace `stage.ps1`:

- Copia tu código a `installer\dist\payload\app`
- Copia `node_modules`
- Copia las DLLs de `lib\`.
- Espera encontrar Node embebido en `installer\assets\node\`.

## Paso 2 – Poner Node embebido

Debes colocar un Node portable en:

`installer\assets\node\node.exe`

Estructura esperada:

```
installer/
  assets/
    node/
      node.exe
  dist/
    payload/
      node/
      app/
```

Recomendación: usa el mismo `arch` que tus DLLs Futronic (x86 vs x64).

## Paso 3 – Compilar MSI

```powershell
powershell -ExecutionPolicy Bypass -File .\\installer\\wix\\build.ps1
```

Salida:

- `installer\dist\MarCaribeFingerprintAgent.msi`

## Instalación / Desinstalación

- Instala: doble click al MSI (o `msiexec /i MarCaribeFingerprintAgent.msi`)
- Desinstala: “Apps & Features” o `msiexec /x {PRODUCT-GUID}`

## Configuración por estación

Edita:

- `C:\ProgramData\MarCaribeFingerprintAgent\config.json`

Campos típicos:

- `apiUrl`
- `stationId` (pc-1..pc-6)
- `agentKey`

### Instalar en varias PCs sin editar `stationId`

Opción recomendada (sin tocar archivos):

- Renombra cada PC con el formato `PC-1`, `PC-2`, `PC-3`, etc.
- No pongas `stationId` en el config.

El agente detecta automáticamente:

- `PC-2` / `PC2` / `PC_2` / `PC 2` → `pc-2`

Si la PC no está nombrada con ese patrón, entonces sí debes definir `stationId` manualmente en el config.
