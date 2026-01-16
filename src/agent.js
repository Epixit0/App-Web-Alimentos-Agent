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

const fileConfig = safeReadJson(resolvedConfigPath) || {};

const API_URL =
  (typeof args.apiUrl === "string" ? args.apiUrl : null) ||
  (typeof fileConfig.apiUrl === "string" ? fileConfig.apiUrl : null) ||
  process.env.API_URL;

const STATION_ID =
  (typeof args.stationId === "string" ? args.stationId : null) ||
  (typeof fileConfig.stationId === "string" ? fileConfig.stationId : null) ||
  process.env.STATION_ID;

const AGENT_KEY =
  (typeof args.agentKey === "string" ? args.agentKey : null) ||
  (typeof fileConfig.agentKey === "string" ? fileConfig.agentKey : null) ||
  process.env.AGENT_KEY;

const POLL_INTERVAL_MS = Number(
  (typeof args.pollIntervalMs === "string" ? args.pollIntervalMs : null) ||
    (typeof fileConfig.pollIntervalMs === "number"
      ? fileConfig.pollIntervalMs
      : null) ||
    process.env.POLL_INTERVAL_MS ||
    2000
);

const HEARTBEAT_INTERVAL_MS = Number(
  (typeof args.heartbeatIntervalMs === "string"
    ? args.heartbeatIntervalMs
    : null) ||
    (typeof fileConfig.heartbeatIntervalMs === "number"
      ? fileConfig.heartbeatIntervalMs
      : null) ||
    process.env.HEARTBEAT_INTERVAL_MS ||
    10_000
);

if (!nodeFetch) {
  console.error("No hay fetch disponible. Use Node 18+ o incluya node-fetch.");
  process.exit(1);
}

if (!API_URL) {
  console.error("Falta apiUrl/API_URL (ej: https://tu-backend.vercel.app/api)");
  process.exit(1);
}
if (!STATION_ID) {
  console.error("Falta stationId/STATION_ID (ej: pc-1)");
  process.exit(1);
}
if (!AGENT_KEY) {
  console.error(
    "Falta agentKey/AGENT_KEY (debe coincidir con FINGERPRINT_AGENT_KEY)"
  );
  process.exit(1);
}

if (safeReadJson(resolvedConfigPath)) {
  console.log(`Config cargada desde: ${resolvedConfigPath}`);
}

async function api(pathname, options = {}) {
  const url = `${API_URL}${pathname}`;
  const res = await nodeFetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-fingerprint-agent-key": AGENT_KEY,
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

async function heartbeat() {
  await api(`/fingerprint/agent/heartbeat`, {
    method: "POST",
    body: JSON.stringify({ stationId: STATION_ID }),
  });
}

async function nextJob() {
  const qs = new URLSearchParams({ stationId: STATION_ID }).toString();
  const data = await api(`/fingerprint/agent/next?${qs}`);
  return data?.job || null;
}

async function submitCapture(jobId, buffer) {
  return api(`/fingerprint/agent/jobs/${jobId}/capture`, {
    method: "POST",
    body: JSON.stringify({ templateBase64: buffer.toString("base64") }),
  });
}

async function failJob(jobId, error) {
  return api(`/fingerprint/agent/jobs/${jobId}/fail`, {
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

console.log(`Fingerprint agent iniciado. stationId=${STATION_ID}`);

let lastHeartbeat = 0;

while (true) {
  const now = Date.now();
  if (now - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
    try {
      await heartbeat();
      lastHeartbeat = now;
    } catch (e) {
      console.warn("Heartbeat falló:", e.message);
    }
  }

  let job = null;
  try {
    job = await nextJob();
  } catch (e) {
    console.warn("Error consultando jobs:", e.message);
    await sleep(POLL_INTERVAL_MS);
    continue;
  }

  if (!job) {
    await sleep(POLL_INTERVAL_MS);
    continue;
  }

  console.log(`Job recibido: ${job._id} tipo=${job.type}`);

  try {
    const template = await capture();
    await submitCapture(job._id, template);
    console.log(`Job completado: ${job._id}`);
  } catch (e) {
    console.error(`Job falló: ${job._id}: ${e.message}`);
    try {
      await failJob(job._id, e.message);
    } catch (inner) {
      console.warn("No se pudo reportar fallo:", inner.message);
    }
  }

  await sleep(250);
}
