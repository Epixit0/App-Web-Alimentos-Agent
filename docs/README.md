# MarCaribe Fingerprint Agent

## ¿Esto evita descargar el backend?

Sí. La idea es que en las PCs solo instales/ejecutes este agente (y los drivers del lector).
La web y el backend quedan en la nube.

## Configuración (recomendado)

Crear:

- `C:\\ProgramData\\MarCaribeFingerprintAgent\\config.json`

Usa como base:

- `agent.config.example.json`

Campos:

- `apiUrl`: `https://app-web-alimentos-backend.vercel.app/api`
- `stationId`: `pc-1` (o pc-2..pc-6)
- `agentKey`: igual a `FINGERPRINT_AGENT_KEY` en Vercel

## Ejecutar (prueba manual)

En la carpeta del agente:

- `npm install`
- `npm start`

Luego revisa:

- `https://app-web-alimentos-backend.vercel.app/api/fingerprint/stations`

## Errores comunes en Windows (npm / node-gyp)

Nota: el agente usa `koffi` para llamar DLLs y trae binarios precompilados en Windows x86/x64. Si `npm install` está intentando compilar cosas con `node-gyp`, normalmente es porque quedó un `node_modules` viejo o porque estás instalando en una carpeta con residuos de una instalación anterior.

### `"call" no se reconoce como un comando...` / aparece `call "call" ... preprocess_asm.cmd`

Si en el log de `npm install` ves algo como:

- `call "call" ".../preprocess_asm.cmd" ...`

Entonces casi seguro tu variable de entorno `ComSpec` está mal configurada.

Debe ser:

- `C:\Windows\System32\cmd.exe`

Verifica en PowerShell:

- `$env:ComSpec`

Si te devuelve `call` (u otra cosa distinta a `...\cmd.exe`), ahí está la causa.

Arreglo rápido (PowerShell):

- `setx ComSpec "%SystemRoot%\System32\cmd.exe"`

Importante: `setx` NO arregla la sesión actual. Para arreglar la consola actual (antes de reintentar), ejecuta también:

- `$env:ComSpec = "$env:SystemRoot\System32\cmd.exe"`

Luego cierra y abre la consola, y vuelve a ejecutar:

- `npm install`

### `npm WARN cleanup ... EPERM: operation not permitted, rmdir ...`

Suele pasar cuando algún proceso (o antivirus) está usando archivos dentro de `node_modules`.

Pasos recomendados:

- Cierra el agente si está ejecutándose.
- En PowerShell: `taskkill /f /im node.exe` (solo si no tienes otros Node corriendo)
- Borra `node_modules`:
  - PowerShell: `Remove-Item -Recurse -Force node_modules`
  - o CMD: `cmd /c rd /s /q node_modules`
  - Si sigue “bloqueado”, reinicia la PC y vuelve a intentar.

## DLLs

Para capturar, el agente necesita las DLLs de Futronic en:

- `App-Web-Alimentos-Agent\\lib\\FTRAPI.dll`
- `App-Web-Alimentos-Agent\\lib\\ftrScanAPI.dll`

Importante:

- Si tu Windows/Node es 64 bits, normalmente necesitas las DLLs **x64**. Si copias DLLs x86, verás errores como `Win32 error 193`.
- Si tu proveedor/SDK solo trae DLLs **x86 (32-bit)**, entonces la solución práctica es correr el agente con **Node x86 (ia32)** en esa PC.
- Estas DLLs normalmente vienen en el driver/SDK de Futronic (carpeta `x64`).

El instalador final debe copiar estas DLLs al directorio del agente.
