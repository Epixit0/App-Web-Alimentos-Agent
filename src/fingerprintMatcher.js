import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);

let koffi = null;
let nativeAvailable = false;

try {
  koffi = require("koffi");
  nativeAvailable = true;
} catch {
  nativeAvailable = false;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultDllPath = path.join(__dirname, "../lib/FTRAPI.dll");

const fallbackScanDllPath = path.join(__dirname, "../lib/ftrScanAPI.dll");

function resolveDllPath() {
  const fromEnv =
    typeof process.env.FTRAPI_DLL_PATH === "string" &&
    process.env.FTRAPI_DLL_PATH.trim()
      ? process.env.FTRAPI_DLL_PATH.trim()
      : null;
  return fromEnv || defaultDllPath;
}

function getCandidateDllPaths() {
  const primary = resolveDllPath();
  const candidates = [primary];
  // Si el usuario no overrideó y el FTRAPI.dll no está, intenta con la DLL de escaneo
  // (algunos SDKs/instalaciones agrupan exports en un solo binario).
  if (primary === defaultDllPath) {
    candidates.push(fallbackScanDllPath);
  }
  // De-dup
  return Array.from(new Set(candidates.filter(Boolean)));
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readSymbolOverrides() {
  const raw = process.env.FTRAPI_SYMBOLS_JSON;
  if (!raw || typeof raw !== "string") return null;
  const parsed = safeJsonParse(raw);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function tryDeclare(buildFn) {
  try {
    return buildFn();
  } catch {
    return null;
  }
}

function resolveFunction(lib, logicalName, candidates, builder) {
  const overrides = readSymbolOverrides();
  const override =
    overrides && typeof overrides[logicalName] === "string"
      ? overrides[logicalName]
      : null;
  const ordered = [override, ...candidates].filter(Boolean);

  for (const name of ordered) {
    const fn = tryDeclare(() => builder(lib, name));
    if (fn) return { name, fn };
  }

  return null;
}

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function loadMatcher() {
  if (!nativeAvailable || !koffi) return null;
  const triedPaths = getCandidateDllPaths();

  let dllPath = triedPaths[0] || defaultDllPath;
  let lib = null;
  let lastLoadError = null;

  for (const candidate of triedPaths) {
    dllPath = candidate;
    if (!fileExists(candidate)) {
      lastLoadError = "dll_not_found";
      continue;
    }
    try {
      lib = koffi.load(candidate);
      lastLoadError = null;
      break;
    } catch (e) {
      lastLoadError = e?.message || String(e);
      lib = null;
    }
  }

  if (!lib) {
    return {
      dllPath,
      available: false,
      names: null,
      loadError: lastLoadError || "dll_load_failed",
      triedPaths,
    };
  }

  const FTR_DATA = koffi.struct("FTR_DATA", {
    dwSize: "uint32",
    pData: "void *",
  });

  // Nota: estos nombres pueden variar. Se pueden overridear con FTRAPI_SYMBOLS_JSON.
  // También hay DLLs que exportan símbolos decorados tipo stdcall: _Name@N o Name@N.
  const setBase = resolveFunction(
    lib,
    "FTRSetBaseTemplate",
    [
      "FTRSetBaseTemplate",
      "FTR_SetBaseTemplate",
      "FTRSetBaseTemplateA",
      "FTR_SetBaseTemplateA",
      "_FTRSetBaseTemplate@8",
      "FTRSetBaseTemplate@8",
      "_FTR_SetBaseTemplate@8",
      "FTR_SetBaseTemplate@8",
    ],
    (loadedLib, name) =>
      loadedLib.func("__stdcall", name, "int", ["void *", "FTR_DATA *"]),
  );

  const identify = resolveFunction(
    lib,
    "FTRIdentify",
    [
      "FTRIdentify",
      "FTR_Identify",
      "FTRIdentifyA",
      "FTR_IdentifyA",
      "_FTRIdentify@16",
      "FTRIdentify@16",
      "_FTR_Identify@16",
      "FTR_Identify@16",
    ],
    (loadedLib, name) =>
      loadedLib.func("__stdcall", name, "int", [
        "void *",
        "FTR_DATA *",
        "int *",
        "int *",
      ]),
  );

  return {
    dllPath,
    available: Boolean(setBase && identify),
    FTR_DATA,
    FTRSetBaseTemplate: setBase?.fn || null,
    FTRIdentify: identify?.fn || null,
    names: {
      FTRSetBaseTemplate: setBase?.name || null,
      FTRIdentify: identify?.name || null,
    },
    loadError: null,
    triedPaths,
  };
}

let cached = null;

export function isMatcherAvailable() {
  if (!cached) cached = loadMatcher();
  return Boolean(cached && cached.available);
}

export function getMatcherInfo() {
  if (!cached) cached = loadMatcher();
  return cached
    ? {
        available: Boolean(cached.available),
        dllPath: cached.dllPath,
        names: cached.names,
        loadError: cached.loadError || null,
        triedPaths: Array.isArray(cached.triedPaths) ? cached.triedPaths : null,
      }
    : {
        available: false,
        dllPath: defaultDllPath,
        names: null,
        loadError: nativeAvailable ? "unknown" : "koffi_not_available",
        triedPaths: null,
      };
}

export async function verifyTemplate(baseTemplate, probeTemplate) {
  if (!cached) cached = loadMatcher();
  if (!cached || !cached.available) {
    const info = getMatcherInfo();
    const err = new Error(
      "Motor nativo de comparación no disponible en el agente (FTRAPI.dll / exports).",
    );
    err.code = "AGENT_MATCH_UNAVAILABLE";
    err.details = info;
    throw err;
  }

  if (!Buffer.isBuffer(baseTemplate) || baseTemplate.length === 0) {
    return { matched: false, error: "Template base vacío" };
  }
  if (!Buffer.isBuffer(probeTemplate) || probeTemplate.length === 0) {
    return { matched: false, error: "Template a comparar vacío" };
  }

  const base = { dwSize: baseTemplate.length, pData: baseTemplate };
  const setResult = cached.FTRSetBaseTemplate(
    null,
    koffi.as(base, "FTR_DATA *"),
  );
  if (setResult !== 0) {
    return {
      matched: false,
      error: `Error en FTRSetBaseTemplate: ${setResult}`,
      code: setResult,
    };
  }

  const probe = { dwSize: probeTemplate.length, pData: probeTemplate };
  // Importante: inicializar en -1 para evitar que 0 (match) sea el valor por defecto
  // si la DLL no llega a escribir el resultado por algún motivo.
  const matchedIndex = [-1];
  const score = [0];

  const identifyResult = cached.FTRIdentify(
    null,
    koffi.as(probe, "FTR_DATA *"),
    matchedIndex,
    score,
  );

  if (identifyResult !== 0) {
    return {
      matched: false,
      error: `Error en FTRIdentify: ${identifyResult}`,
      code: identifyResult,
    };
  }

  const idx = matchedIndex[0];
  const sc = score[0];

  // Semántica esperada (según implementación previa): index 0 => coincide con base.
  // Algunas builds podrían usar índice 1-based cuando solo hay un template.
  const matched = idx === 0 || idx === 1;

  return { matched, score: sc, index: idx };
}
