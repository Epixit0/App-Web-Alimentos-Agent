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

  // Algunos SDKs exportan también las funciones de escaneo dentro de FTRAPI.dll.
  // Esto nos permite abrir un handle compatible con FTREnroll en caso de que el handle
  // proveniente de ftrScanAPI.dll no sea aceptado por FTREnroll.
  const scanOpen = resolveFunction(
    lib,
    "ftrScanOpenDevice",
    ["ftrScanOpenDevice", "_ftrScanOpenDevice@0", "ftrScanOpenDevice@0"],
    (loadedLib, name) => loadedLib.func("__stdcall", name, "void *", []),
  );

  const scanClose = resolveFunction(
    lib,
    "ftrScanCloseDevice",
    ["ftrScanCloseDevice", "_ftrScanCloseDevice@4", "ftrScanCloseDevice@4"],
    (loadedLib, name) => loadedLib.func("__stdcall", name, "void", ["void *"]),
  );

  const enroll = resolveFunction(
    lib,
    "FTREnroll",
    [
      "FTREnroll",
      "FTR_Enroll",
      "FTREnrollA",
      "FTR_EnrollA",
      "_FTREnroll@12",
      "FTREnroll@12",
      "_FTR_Enroll@12",
      "FTR_Enroll@12",
    ],
    (loadedLib, name) =>
      loadedLib.func("__stdcall", name, "int", ["void *", "int", "FTR_DATA *"]),
  );

  return {
    dllPath,
    available: Boolean(setBase && identify),
    FTR_DATA,
    FTRSetBaseTemplate: setBase?.fn || null,
    FTRIdentify: identify?.fn || null,
    FTREnroll: enroll?.fn || null,
    ftrScanOpenDevice: scanOpen?.fn || null,
    ftrScanCloseDevice: scanClose?.fn || null,
    names: {
      FTRSetBaseTemplate: setBase?.name || null,
      FTRIdentify: identify?.name || null,
      FTREnroll: enroll?.name || null,
      ftrScanOpenDevice: scanOpen?.name || null,
      ftrScanCloseDevice: scanClose?.name || null,
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

export function isEnrollAvailable() {
  if (!cached) cached = loadMatcher();
  return Boolean(cached && cached.FTREnroll);
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

export async function createTemplateFromDevice(
  deviceHandle,
  purpose,
  options = {},
) {
  if (!cached) cached = loadMatcher();

  if (!cached || !cached.FTREnroll) {
    const info = getMatcherInfo();
    const err = new Error(
      "No está disponible FTREnroll en la DLL (no se puede generar template).",
    );
    err.code = "AGENT_ENROLL_UNAVAILABLE";
    err.details = info;
    throw err;
  }

  // Algunos SDKs usan valores distintos; permite override.
  const PURPOSE_ENROLL_DEFAULT = 3;
  const PURPOSE_VERIFY_DEFAULT = 1;

  const enrollPurposeOverrideRaw = Number(process.env.FTR_ENROLL_PURPOSE);
  const verifyPurposeOverrideRaw = Number(process.env.FTR_VERIFY_PURPOSE);

  const enrollPurpose =
    Number.isFinite(enrollPurposeOverrideRaw) && enrollPurposeOverrideRaw >= 0
      ? enrollPurposeOverrideRaw
      : PURPOSE_ENROLL_DEFAULT;
  const verifyPurpose =
    Number.isFinite(verifyPurposeOverrideRaw) && verifyPurposeOverrideRaw >= 0
      ? verifyPurposeOverrideRaw
      : PURPOSE_VERIFY_DEFAULT;

  // Orden de prueba: por defecto intentamos el esperado y luego el alternativo.
  const purposeCandidates =
    purpose === "verify"
      ? Array.from(new Set([verifyPurpose, enrollPurpose]))
      : Array.from(new Set([enrollPurpose, verifyPurpose]));

  // Tamaño típico de template: 3-6KB. Permitimos override por env si tu SDK usa más.
  const bufSizeRaw = Number(process.env.FTR_TEMPLATE_BUFFER_SIZE || 6144);
  const templateBufferSize =
    Number.isFinite(bufSizeRaw) && bufSizeRaw > 512 ? bufSizeRaw : 6144;

  const maxAttemptsRaw = Number(process.env.FTR_ENROLL_ATTEMPTS || 8);
  const maxAttempts =
    Number.isFinite(maxAttemptsRaw) && maxAttemptsRaw > 0
      ? Math.min(maxAttemptsRaw, 10)
      : 3;

  const debug =
    String(process.env.FINGERPRINT_AGENT_DEBUG_MATCH || "").trim() === "1";

  let lastResult = null;
  let lastDwSize = null;

  async function attemptEnroll(handle, attemptNo, label, purposeValue) {
    if (typeof options?.preCapture === "function") {
      try {
        await options.preCapture();
      } catch {
        // ignore
      }
    }

    const outBuffer = Buffer.alloc(templateBufferSize);
    const out = { dwSize: templateBufferSize, pData: outBuffer };

    // IMPORTANT: FTREnroll recibe FTR_DATA*; hay que pasar un puntero real.
    const result = cached.FTREnroll(
      handle,
      purposeValue,
      koffi.as(out, "FTR_DATA *"),
    );
    lastResult = result;
    lastDwSize = out.dwSize;

    if (debug) {
      console.log(
        `[DEBUG] FTREnroll(${label}) attempt=${attemptNo} purpose=${purposeValue} result=${result} dwSize=${out.dwSize}`,
      );
    }

    if (result === 0 && out.dwSize > 0 && out.dwSize <= templateBufferSize) {
      const tpl = outBuffer.slice(0, out.dwSize);
      const hasData = tpl.some((b) => b !== 0);
      if (hasData) return tpl;
    }
    return null;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    for (const purposeValue of purposeCandidates) {
      // 1) Intento con el handle entregado por el scanner actual
      if (deviceHandle) {
        const tpl = await attemptEnroll(
          deviceHandle,
          attempt,
          "scanner-handle",
          purposeValue,
        );
        if (tpl) return tpl;
      }

      // 2) Si falla, reintenta abriendo el device desde este mismo DLL (FTRAPI.dll)
      if (cached.ftrScanOpenDevice && cached.ftrScanCloseDevice) {
        let tmpHandle = null;
        try {
          tmpHandle = cached.ftrScanOpenDevice();
          if (tmpHandle) {
            const tpl2 = await attemptEnroll(
              tmpHandle,
              attempt,
              "ftrapi-scan-handle",
              purposeValue,
            );
            if (tpl2) return tpl2;
          }
        } finally {
          try {
            if (tmpHandle) cached.ftrScanCloseDevice(tmpHandle);
          } catch {
            // ignore
          }
        }
      }
    }

    // Pequeña espera para reintentar si el usuario aún está colocando el dedo.
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const err = new Error(
    `No se pudo generar template con FTREnroll (último código=${lastResult}, dwSize=${lastDwSize}).`,
  );
  err.code = "AGENT_ENROLL_FAILED";
  err.details = {
    dllPath: cached.dllPath,
    triedPaths: cached.triedPaths,
    exports: cached.names,
    lastResult,
    lastDwSize,
    purposeCandidates,
  };
  throw err;
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
