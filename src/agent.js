import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { getScanner } from "./fingerprintScanner.js";

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

function normalizeBaseUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
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
      2000
  );

  const heartbeatIntervalMs = Number(
    (typeof args.heartbeatIntervalMs === "string"
      ? args.heartbeatIntervalMs
      : null) ||
      (typeof cfg.heartbeatIntervalMs === "number"
        ? cfg.heartbeatIntervalMs
        : null) ||
      process.env.HEARTBEAT_INTERVAL_MS ||
      10_000
  );

  return {
    configExists: Boolean(fileConfig),
    configPath: resolvedConfigPath,
    apiUrl: normalizeBaseUrl(apiUrlRaw),
    stationId:
      typeof stationIdRaw === "string" && stationIdRaw.trim()
        ? stationIdRaw.trim()
        : null,
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
  `Fingerprint agent iniciado. Config esperado en: ${resolvedConfigPath}`
);

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
    body: JSON.stringify({ stationId: runtime.stationId }),
  });
}

async function nextJob(runtime) {
  const qs = new URLSearchParams({ stationId: runtime.stationId }).toString();
  const data = await api(runtime, `/fingerprint/agent/next?${qs}`);
  return data?.job || null;
}

async function submitCapture(runtime, jobId, buffer) {
  return api(runtime, `/fingerprint/agent/jobs/${jobId}/capture`, {
    method: "POST",
    body: JSON.stringify({ templateBase64: buffer.toString("base64") }),
  });
}

async function failJob(runtime, jobId, error) {
  return api(runtime, `/fingerprint/agent/jobs/${jobId}/fail`, {
    method: "POST",
    body: JSON.stringify({ error }),
  });
}

async function capture() {
  const scanner = getScanner();

  if (!scanner.openDevice()) {
    throw new Error("No se pudo abrir el dispositivo del escáner");
  }

  try {
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

while (true) {
  const runtime = readRuntimeConfig();

  if (runtime.configExists && !loggedConfigPath) {
    console.log(`Config cargada desde: ${runtime.configPath}`);
    loggedConfigPath = true;
  }

  const missing = [];
  if (!runtime.apiUrl) missing.push("apiUrl/API_URL");
  if (!runtime.stationId) missing.push("stationId/STATION_ID");
  if (!runtime.agentKey) missing.push("agentKey/AGENT_KEY");
  if (missing.length > 0) {
    const now = Date.now();
    if (now - lastMissingConfigLogAt > 10_000) {
      console.error(
        `Config incompleta. Falta: ${missing.join(", ")}. ` +
          `El servicio seguirá corriendo y reintentará. Path: ${runtime.configPath}`
      );
      lastMissingConfigLogAt = now;
    }
    await sleep(2000);
    continue;
  }

  const now = Date.now();
  if (now - lastHeartbeat > runtime.heartbeatIntervalMs) {
    try {
      await heartbeat(runtime);
      lastHeartbeat = now;
    } catch (e) {
      console.warn("Heartbeat falló:", e.message);
    }
  }

  let job = null;
  try {
    job = await nextJob(runtime);
  } catch (e) {
    console.warn("Error consultando jobs:", e.message);
    await sleep(runtime.pollIntervalMs);
    continue;
  }

  if (!job) {
    await sleep(runtime.pollIntervalMs);
    continue;
  }

  console.log(`Job recibido: ${job._id} tipo=${job.type}`);

  try {
    const template = await capture();
    await submitCapture(runtime, job._id, template);
    console.log(`Job completado: ${job._id}`);
  } catch (e) {
    console.error(`Job falló: ${job._id}: ${e.message}`);
    try {
      await failJob(runtime, job._id, e.message);
    } catch (inner) {
      console.warn("No se pudo reportar fallo:", inner.message);
    }
  }

  await sleep(250);
}
