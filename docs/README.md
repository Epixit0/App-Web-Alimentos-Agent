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

## DLLs

Para capturar, el agente necesita las DLLs de Futronic en:

- `App-Web-Alimentos-Agent\\lib\\FTRAPI.dll`
- `App-Web-Alimentos-Agent\\lib\\ftrScanAPI.dll`

El instalador final debe copiar estas DLLs al directorio del agente.
