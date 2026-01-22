import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import os from "os";
import { execFileSync } from "child_process";
import zlib from "zlib";
import { getScanner } from "./fingerprintScanner.js";
import {
  createTemplateFromDevice,
  getMatcherInfo,
  isMatcherAvailable,
  verifyTemplate,
} from "./fingerprintMatcher.js";

const require = createRequire(import.meta.url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const nodeFetch = (() => {
  if (typeof globalThis.fetch === "function") return globalThis.fetch;
  try {
    const fetched = require("node-fetch");
    return fetched?.default || fetched;
  } catch {
    return null;
  }
})();

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);

    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function safeReadJson(filePath) {
  try {
    if (!filePath) return null;
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv.slice(2));

const configPathFromArgs =
  typeof args.config === "string" && args.config.trim() ? args.config : null;
const configPathFromEnv =
  typeof process.env.FINGERPRINT_AGENT_CONFIG === "string" &&
  process.env.FINGERPRINT_AGENT_CONFIG.trim()
    ? process.env.FINGERPRINT_AGENT_CONFIG
    : null;

const programDataBase =
  typeof process.env.PROGRAMDATA === "string" && process.env.PROGRAMDATA.trim()
    ? process.env.PROGRAMDATA
    : null;
const defaultWindowsConfigPath = programDataBase
  ? path.join(programDataBase, "MarCaribeFingerprintAgent", "config.json")
  : null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultLocalConfigPath = path.join(__dirname, "agent.config.json");

const resolvedConfigPath =
  configPathFromArgs ||
  configPathFromEnv ||
  defaultWindowsConfigPath ||
  defaultLocalConfigPath;

function applyEnvFromConfigFile() {
  const fileConfig = safeReadJson(resolvedConfigPath);
  const cfg = fileConfig && typeof fileConfig === "object" ? fileConfig : null;
  const env = cfg?.env;
  if (!env || typeof env !== "object") return;

  const overrideExisting = cfg?.envOverrideExisting === true;
  const applied = [];

  for (const [key, raw] of Object.entries(env)) {
    if (typeof key !== "string" || !key.trim()) continue;
    if (
      raw == null ||
      (typeof raw !== "string" &&
        typeof raw !== "number" &&
        typeof raw !== "boolean")
    ) {
      continue;
    }

    const val = String(raw);
    const already = Object.prototype.hasOwnProperty.call(process.env, key);
    if (already && !overrideExisting) continue;
    process.env[key] = val;
    applied.push(key);
  }

  if (applied.length) {
    console.log(
      `[INFO] Variables env aplicadas desde config.json: ${applied.sort().join(", ")}`,
    );
  }
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

function parseRegQueryValue(output, valueName) {
  // Output típico:
  // HKEY_LOCAL_MACHINE\...\Cryptography
  //     MachineGuid    REG_SZ    xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  const lines = String(output).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.toLowerCase().startsWith(valueName.toLowerCase())) continue;
    const parts = trimmed.split(/\s+/);
    // [MachineGuid, REG_SZ, value...]
    if (parts.length >= 3) {
      return parts.slice(2).join(" ").trim();
    }
  }
  return null;
}

function getStableMachineId() {
  const fromEnv =
    typeof process.env.FINGERPRINT_AGENT_MACHINE_ID === "string" &&
    process.env.FINGERPRINT_AGENT_MACHINE_ID.trim()
      ? process.env.FINGERPRINT_AGENT_MACHINE_ID.trim()
      : null;
  if (fromEnv) return fromEnv;

  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "reg.exe",
        [
          "query",
          "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
          "/v",
          "MachineGuid",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 2000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const guid = parseRegQueryValue(out, "MachineGuid");
      if (guid) return `machineguid:${guid}`;
    } catch {
      // ignore
    }
  }

  const host = os.hostname();
  return host ? `hostname:${host}` : "unknown";
}

function readRuntimeConfig() {
  const fileConfig = safeReadJson(resolvedConfigPath);
  const cfg = fileConfig && typeof fileConfig === "object" ? fileConfig : {};

  const apiUrlRaw =
    (typeof args.apiUrl === "string" ? args.apiUrl : null) ||
    (typeof cfg.apiUrl === "string" ? cfg.apiUrl : null) ||
    process.env.API_URL;

  const stationIdRaw =
    (typeof args.stationId === "string" ? args.stationId : null) ||
    (typeof cfg.stationId === "string" ? cfg.stationId : null) ||
    process.env.STATION_ID;

  const agentKeyRaw =
    (typeof args.agentKey === "string" ? args.agentKey : null) ||
    (typeof cfg.agentKey === "string" ? cfg.agentKey : null) ||
    process.env.AGENT_KEY;

  const pollIntervalMs = Number(
    (typeof args.pollIntervalMs === "string" ? args.pollIntervalMs : null) ||
      (typeof cfg.pollIntervalMs === "number" ? cfg.pollIntervalMs : null) ||
      process.env.POLL_INTERVAL_MS ||
      2000,
  );

  const heartbeatIntervalMs = Number(
    (typeof args.heartbeatIntervalMs === "string"
      ? args.heartbeatIntervalMs
      : null) ||
      (typeof cfg.heartbeatIntervalMs === "number"
        ? cfg.heartbeatIntervalMs
        : null) ||
      process.env.HEARTBEAT_INTERVAL_MS ||
      10_000,
  );

  const stationIdFromInputs =
    typeof stationIdRaw === "string" && stationIdRaw.trim()
      ? stationIdRaw.trim()
      : null;

  return {
    configExists: Boolean(fileConfig),
    configPath: resolvedConfigPath,
    apiUrl: normalizeBaseUrl(apiUrlRaw),
    stationId: stationIdFromInputs,
    agentKey:
      typeof agentKeyRaw === "string" && agentKeyRaw.trim()
        ? agentKeyRaw.trim()
        : null,
    pollIntervalMs:
      Number.isFinite(pollIntervalMs) && pollIntervalMs > 0
        ? pollIntervalMs
        : 2000,
    heartbeatIntervalMs:
      Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0
        ? heartbeatIntervalMs
        : 10_000,
  };
}

if (!nodeFetch) {
  console.error("No hay fetch disponible. Use Node 18+ o incluya node-fetch.");
  process.exit(1);
}

console.log(
  `Fingerprint agent iniciado. Config esperado en: ${resolvedConfigPath}`,
);

// OJO: fingerprintScanner y fingerprintMatcher leen process.env para ubicar DLLs.
// Por eso aplicamos env del config ANTES de inicializarlos.
applyEnvFromConfigFile();

try {
  const info = getMatcherInfo();
  if (info.available) {
    console.log(
      `[OK] Motor de comparación disponible. dllPath=${info.dllPath} exports=${JSON.stringify(info.names)}`,
    );
  } else {
    console.warn(
      `[WARN] Motor de comparación NO disponible. dllPath=${info.dllPath} exports=${JSON.stringify(info.names)} loadError=${info.loadError}`,
    );
  }
} catch (e) {
  console.warn(
    `[WARN] No se pudo inicializar el motor de comparación: ${e?.message || String(e)}`,
  );
}

const MACHINE_ID = getStableMachineId();
const HOSTNAME = os.hostname();

console.log(`[INFO] hostname=${HOSTNAME}`);
console.log(`[INFO] machineId=${MACHINE_ID}`);

async function api(runtime, pathname, options = {}) {
  const url = `${runtime.apiUrl}${pathname}`;
  const res = await nodeFetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-fingerprint-agent-key": runtime.agentKey,
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg = data?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

async function heartbeat(runtime) {
  await api(runtime, `/fingerprint/agent/heartbeat`, {
    method: "POST",
    body: JSON.stringify({
      stationId: runtime.stationId,
      machineId: runtime.machineId,
      hostname: runtime.hostname,
    }),
  });
}

async function registerStation(runtime) {
  const data = await api(runtime, `/fingerprint/agent/register`, {
    method: "POST",
    body: JSON.stringify({
      machineId: runtime.machineId,
      hostname: runtime.hostname,
    }),
  });
  return typeof data?.stationId === "string" && data.stationId.trim()
    ? data.stationId.trim()
    : null;
}

async function nextJob(runtime) {
  const qs = new URLSearchParams({ stationId: runtime.stationId }).toString();
  const data = await api(runtime, `/fingerprint/agent/next?${qs}`);
  return data?.job || null;
}

async function submitCapture(runtime, jobId, buffer) {
  const payload = Buffer.isBuffer(buffer)
    ? { templateBase64: buffer.toString("base64") }
    : buffer;

  return api(runtime, `/fingerprint/agent/jobs/${jobId}/capture`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function failJob(runtime, jobId, error) {
  return api(runtime, `/fingerprint/agent/jobs/${jobId}/fail`, {
    method: "POST",
    body: JSON.stringify({ error }),
  });
}

async function listTemplates(runtime, params) {
  const qs = new URLSearchParams(params).toString();
  const pathname = qs
    ? `/fingerprint/agent/templates?${qs}`
    : `/fingerprint/agent/templates`;
  const data = await api(runtime, pathname);
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    nextCursor: typeof data?.nextCursor === "string" ? data.nextCursor : null,
  };
}

function decodeTemplateFromApi(item) {
  const b64 = item?.templateBase64Gzip;
  if (typeof b64 !== "string" || !b64) return null;
  const gz = Buffer.from(b64, "base64");
  if (gz.length >= 2 && gz[0] === 0x1f && gz[1] === 0x8b) {
    try {
      return zlib.gunzipSync(gz);
    } catch {
      return null;
    }
  }
  return gz;
}

async function findDuplicateForEnroll(runtime, workerId, capturedTemplate) {
  if (!isMatcherAvailable()) {
    const info = getMatcherInfo();
    return {
      duplicate: false,
      error:
        "El agente no tiene disponible el motor de comparación (FTRAPI.dll/exports). " +
        `dllPath=${info.dllPath} exports=${JSON.stringify(info.names)}`,
    };
  }

  const debug =
    String(process.env.FINGERPRINT_AGENT_DEBUG_MATCH || "").trim() === "1";
  let checked = 0;
  let bestScore = -Infinity;
  let bestIndex = null;

  let cursor = null;
  for (;;) {
    const { items, nextCursor } = await listTemplates(runtime, {
      excludeWorkerId: workerId,
      limit: "200",
      ...(cursor ? { cursor } : {}),
    });

    for (const item of items) {
      const base = decodeTemplateFromApi(item);
      if (!base) continue;

      const result = await verifyTemplate(base, capturedTemplate);
      checked += 1;

      if (
        result?.score != null &&
        Number.isFinite(Number(result.score)) &&
        Number(result.score) > bestScore
      ) {
        bestScore = Number(result.score);
        bestIndex = result?.index;
      }

      if (debug && checked <= 5) {
        console.log(
          `[DEBUG] match check #${checked} worker=${item?.workerId} idx=${result?.index} score=${result?.score} matched=${result?.matched}`,
        );
      }
      if (result?.matched) {
        const workerName = item?.workerName || item?.workerId || "desconocido";
        return {
          duplicate: true,
          message: `Esta huella ya ha sido registrada por otro trabajador (${workerName}).`,
          score: result?.score,
        };
      }
    }

    if (!nextCursor) break;
    cursor = nextCursor;
  }

  if (debug) {
    const bestScoreText = bestScore === -Infinity ? "n/a" : String(bestScore);
    console.log(
      `[DEBUG] duplicate-check complete: checked=${checked} bestScore=${bestScoreText} bestIndex=${bestIndex}`,
    );
  }

  return { duplicate: false };
}

async function verifyForWorker(runtime, workerId, capturedTemplate) {
  if (!isMatcherAvailable()) {
    const info = getMatcherInfo();
    return {
      matched: false,
      error:
        "El agente no tiene disponible el motor de comparación (FTRAPI.dll/exports). " +
        `dllPath=${info.dllPath} exports=${JSON.stringify(info.names)}`,
    };
  }

  let cursor = null;
  let best = { matched: false, score: -Infinity };

  for (;;) {
    const { items, nextCursor } = await listTemplates(runtime, {
      workerId,
      limit: "200",
      ...(cursor ? { cursor } : {}),
    });

    for (const item of items) {
      const base = decodeTemplateFromApi(item);
      if (!base) continue;

      const result = await verifyTemplate(base, capturedTemplate);
      if (result?.matched) {
        return { matched: true, score: result?.score };
      }
      if (result?.score != null && result.score > (best.score ?? -Infinity)) {
        best = { matched: false, score: result.score };
      }
    }

    if (!nextCursor) break;
    cursor = nextCursor;
  }

  if (best.score !== -Infinity) return best;
  return { matched: false };
}

async function capture(jobType) {
  const enrollProvider = String(
    process.env.FTR_ENROLL_PROVIDER || "native",
  ).trim();

  // Opción estable: usar un ejecutable externo (C#/.NET) para hablar con Futronic.
  // Esto evita FFI frágil en Node y replica mejor un flujo tipo WorkedEx.
  if (
    enrollProvider === "cli" &&
    (jobType === "enroll" || jobType === "verify")
  ) {
    const exePath = String(process.env.FTR_CLI_EXE || "").trim();
    const dllPath = String(process.env.FTRAPI_DLL_PATH || "").trim();
    const purpose = String(process.env.FTR_ENROLL_PURPOSE || "3").trim();
    if (!exePath)
      throw new Error(
        "FTR_ENROLL_PROVIDER=cli pero falta FTR_CLI_EXE (ruta al futronic-cli.exe)",
      );
    if (!dllPath)
      throw new Error(
        "FTR_ENROLL_PROVIDER=cli pero falta FTRAPI_DLL_PATH (ruta a FTRAPI.dll)",
      );

    try {
      const out = execFileSync(
        exePath,
        ["enroll", "--dll", dllPath, "--purpose", purpose],
        { encoding: "utf8", windowsHide: true, timeout: 120_000 },
      );
      const parsed = JSON.parse(out);
      if (!parsed?.ok || typeof parsed?.templateBase64 !== "string") {
        const code = parsed?.code;
        throw new Error(
          `futronic-cli falló: stage=${parsed?.stage || "?"} code=${code} error=${parsed?.error || "?"}`,
        );
      }
      return Buffer.from(parsed.templateBase64, "base64");
    } catch (e) {
      throw new Error(e?.message || String(e));
    }
  }

  const useScanApi = String(process.env.FTR_USE_SCANAPI || "1").trim() !== "0";
  const scanApiCaptureFrames =
    String(process.env.FTR_SCANAPI_CAPTURE_FRAMES || "1").trim() !== "0";

  // Modo estilo WorkedEx: no abrir ftrScanAPI.dll para evitar que el dispositivo quede
  // tomado por el driver de escaneo cuando FTRAPI.dll intenta capturar/enrolar.
  // Esto solo aplica a enroll/verify (templates del SDK).
  if (!useScanApi && (jobType === "enroll" || jobType === "verify")) {
    try {
      const tpl = await createTemplateFromDevice(null, jobType, {
        preCapture: null,
      });
      if (tpl && tpl.length > 0) return tpl;
      throw new Error("No se pudo generar template con FTREnroll.");
    } catch (e) {
      throw new Error(e?.message || String(e));
    }
  }

  const scanner = getScanner();

  if (!scanner.openDevice()) {
    throw new Error("No se pudo abrir el dispositivo del escáner");
  }

  try {
    // IMPORTANTE: para que FTRSetBaseTemplate/FTRIdentify funcionen, debemos guardar/usar
    // templates reales del SDK (no el frame crudo). Los frames crudos suelen causar
    // errores en el matcher y nunca detectan duplicados.

    if (jobType === "enroll" || jobType === "verify") {
      const debug =
        String(process.env.FINGERPRINT_AGENT_DEBUG_MATCH || "").trim() === "1";

      // Modo "open-only": obtenemos un handle válido, pero dejamos que FTRAPI.dll
      // haga la captura/enrolamiento. Esto evita contención (scanAPI suele tomar el device).
      if (!scanApiCaptureFrames) {
        try {
          const tpl = await createTemplateFromDevice(scanner.handle, jobType, {
            preCapture: null,
          });
          if (tpl && tpl.length > 0) {
            return tpl;
          }
          throw new Error("No se pudo generar template con FTREnroll.");
        } catch (e) {
          throw new Error(e?.message || String(e));
        }
      }

      // Warm-up: mantener el lector activo y asegurar que el frame tenga datos.
      // Con 1 solo intento a veces devuelve un frame vacío (todo ceros) sin que el
      // usuario perciba que el lector se encendió.
      const warmupAttemptsRaw = Number(process.env.FTR_WARMUP_ATTEMPTS || 8);
      const warmupAttempts =
        Number.isFinite(warmupAttemptsRaw) && warmupAttemptsRaw > 0
          ? Math.min(warmupAttemptsRaw, 20)
          : 8;

      let warm = null;
      for (let i = 0; i < warmupAttempts; i += 1) {
        warm = await scanner.captureFingerprint(1, 153600);
        if (warm && warm.length > 0 && warm.some((b) => b !== 0)) break;
        // pequeña pausa para que el usuario pueda colocar el dedo
        await new Promise((r) => setTimeout(r, 150));
      }

      if (!warm || warm.length === 0) {
        throw new Error(
          "No se pudo capturar un frame inicial (warm-up) antes de generar template. Verifica que el lector responda.",
        );
      }

      if (!warm.some((b) => b !== 0)) {
        throw new Error(
          "El lector devolvió frames vacíos (todo ceros). Asegúrate de poner el dedo y que el lector se encienda.",
        );
      }

      if (debug) {
        console.log(`[DEBUG] warm-up ok: bytes=${warm.length} nonZero=true`);
      }

      try {
        const tpl = await createTemplateFromDevice(scanner.handle, jobType, {
          // Mantener el lector activo entre reintentos de FTREnroll.
          // Esto ayuda a que el usuario vea el LED y a “despertar” el driver.
          preCapture: async () => {
            try {
              const frame = await scanner.captureFingerprint(1, 153600);
              if (debug) {
                const hasData = !!(
                  frame &&
                  frame.length &&
                  frame.some((b) => b !== 0)
                );
                console.log(
                  `[DEBUG] preCapture frame: ok=${!!frame} bytes=${frame?.length || 0} hasData=${hasData}`,
                );
              }
            } catch {
              // ignore
            }
          },
        });
        if (tpl && tpl.length > 0) {
          return tpl;
        }
      } catch (e) {
        // Propaga un mensaje útil (incluye código de FTREnroll)
        throw new Error(e?.message || String(e));
      }

      // Fallback opcional (solo para diagnóstico). No recomendado para producción.
      if (
        String(
          process.env.FINGERPRINT_AGENT_ALLOW_FRAME_FALLBACK || "",
        ).trim() === "1"
      ) {
        const frame = await scanner.captureFingerprint(5, 153600);
        if (!frame || frame.length === 0) {
          throw new Error("No se pudo capturar la huella");
        }
        const hasData = frame.some((b) => b !== 0);
        if (!hasData) {
          throw new Error("La huella capturada no contiene datos válidos");
        }
        return frame;
      }

      throw new Error(
        "No se pudo generar template con FTREnroll. Activa FINGERPRINT_AGENT_DEBUG_MATCH=1 para ver el código de error.",
      );
    }

    const frame = await scanner.captureFingerprint(5, 153600);
    if (!frame || frame.length === 0) {
      throw new Error("No se pudo capturar la huella");
    }

    const hasData = frame.some((b) => b !== 0);
    if (!hasData) {
      throw new Error("La huella capturada no contiene datos válidos");
    }

    return frame;
  } finally {
    try {
      scanner.closeDevice();
    } catch {
      // ignore
    }
  }
}

let lastHeartbeat = 0;
let loggedConfigPath = false;
let lastMissingConfigLogAt = 0;
let cachedStationId = null;
let lastRegisterAttemptAt = 0;

while (true) {
  const runtimeBase = readRuntimeConfig();
  const runtime = {
    ...runtimeBase,
    machineId: MACHINE_ID,
    hostname: HOSTNAME,
  };

  if (runtime.configExists && !loggedConfigPath) {
    console.log(`Config cargada desde: ${runtime.configPath}`);
    loggedConfigPath = true;
  }

  const missing = [];
  if (!runtime.apiUrl) missing.push("apiUrl/API_URL");
  if (!runtime.agentKey) missing.push("agentKey/AGENT_KEY");
  if (missing.length > 0) {
    const now = Date.now();
    if (now - lastMissingConfigLogAt > 10_000) {
      console.error(
        `Config incompleta. Falta: ${missing.join(", ")}. ` +
          `El servicio seguirá corriendo y reintentará. Path: ${runtime.configPath}`,
      );
      lastMissingConfigLogAt = now;
    }
    await sleep(2000);
    continue;
  }

  // Resolver stationId: del config/args o por auto-registro (machineId -> pc-1..pc-6)
  let stationId = runtime.stationId || cachedStationId;
  if (!stationId) {
    const now = Date.now();
    if (now - lastRegisterAttemptAt > 10_000) {
      lastRegisterAttemptAt = now;
      try {
        const assigned = await registerStation(runtime);
        if (assigned) {
          cachedStationId = assigned;
          stationId = assigned;
          console.log(`[INFO] Estacion asignada automaticamente: ${assigned}`);
        }
      } catch (e) {
        // Si el backend aún no tiene el endpoint, se verá aquí.
        console.warn("No se pudo auto-asignar estación:", e.message);
      }
    }
  }

  if (!stationId) {
    const now = Date.now();
    if (now - lastMissingConfigLogAt > 10_000) {
      console.error(
        `Config incompleta. Falta: stationId/STATION_ID (se intentó auto-asignación). ` +
          `El servicio seguirá corriendo y reintentará. Path: ${runtime.configPath}`,
      );
      lastMissingConfigLogAt = now;
    }
    await sleep(2000);
    continue;
  }

  const effectiveRuntime = { ...runtime, stationId };

  const now = Date.now();
  if (now - lastHeartbeat > effectiveRuntime.heartbeatIntervalMs) {
    try {
      await heartbeat(effectiveRuntime);
      lastHeartbeat = now;
    } catch (e) {
      console.warn("Heartbeat falló:", e.message);
    }
  }

  let job = null;
  try {
    job = await nextJob(effectiveRuntime);
  } catch (e) {
    console.warn("Error consultando jobs:", e.message);
    await sleep(effectiveRuntime.pollIntervalMs);
    continue;
  }

  if (!job) {
    await sleep(effectiveRuntime.pollIntervalMs);
    continue;
  }

  console.log(`Job recibido: ${job._id} tipo=${job.type}`);

  try {
    const template = await capture(job.type);

    if (job.type === "enroll") {
      const dupe = await findDuplicateForEnroll(
        effectiveRuntime,
        job.workerId,
        template,
      );

      if (dupe?.error) {
        await failJob(effectiveRuntime, job._id, dupe.error);
        console.error(`Job falló: ${job._id}: ${dupe.error}`);
      } else if (dupe?.duplicate) {
        await failJob(effectiveRuntime, job._id, dupe.message);
        console.error(`Job falló: ${job._id}: ${dupe.message}`);
      } else {
        await submitCapture(effectiveRuntime, job._id, {
          templateBase64: template.toString("base64"),
          agentCheckedDuplicates: true,
        });
        console.log(`Job completado: ${job._id}`);
      }
    } else if (job.type === "verify") {
      const result = await verifyForWorker(
        effectiveRuntime,
        job.workerId,
        template,
      );
      await submitCapture(effectiveRuntime, job._id, {
        agentVerified: true,
        verifyResult: result,
      });
      console.log(`Job completado: ${job._id}`);
    } else {
      await submitCapture(effectiveRuntime, job._id, template);
      console.log(`Job completado: ${job._id}`);
    }
  } catch (e) {
    console.error(`Job falló: ${job._id}: ${e.message}`);
    try {
      await failJob(effectiveRuntime, job._id, e.message);
    } catch (inner) {
      console.warn("No se pudo reportar fallo:", inner.message);
    }
  }

  await sleep(250);
}
