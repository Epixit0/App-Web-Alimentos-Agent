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

let cachedConsoleHwnd = undefined;

let cachedMessageHwnd = undefined;
let messagePumpStarted = false;

function ensureMessagePumpAndWindow() {
  if (cachedMessageHwnd !== undefined) return cachedMessageHwnd;
  cachedMessageHwnd = null;

  if (process.platform !== "win32") return cachedMessageHwnd;
  if (!nativeAvailable || !koffi) return cachedMessageHwnd;

  const enabled = String(process.env.FTR_MESSAGE_PUMP || "1").trim() === "1";
  if (!enabled) return cachedMessageHwnd;

  const debug = String(process.env.DEBUG_FINGERPRINT || "").trim() === "1";

  try {
    const user32 = koffi.load("user32.dll");
    const k32 = koffi.load("kernel32.dll");

    const GetLastError = k32.func("__stdcall", "GetLastError", "uint32", []);

    const GetModuleHandleA = k32.func(
      "__stdcall",
      "GetModuleHandleA",
      "void *",
      ["char *"],
    );

    const CreateWindowExA = user32.func(
      "__stdcall",
      "CreateWindowExA",
      "void *",
      [
        "uint32", // dwExStyle
        "char *", // lpClassName
        "char *", // lpWindowName
        "uint32", // dwStyle
        "int", // X
        "int", // Y
        "int", // nWidth
        "int", // nHeight
        "void *", // hWndParent
        "void *", // hMenu
        "void *", // hInstance
        "void *", // lpParam
      ],
    );

    const MSG = koffi.struct("MSG", {
      hwnd: "void *",
      message: "uint32",
      _pad0: "uint32",
      wParam: "uint64",
      lParam: "int64",
      time: "uint32",
      _pad1: "uint32",
      pt_x: "int32",
      pt_y: "int32",
    });

    const PeekMessageA = user32.func("__stdcall", "PeekMessageA", "int", [
      "MSG *",
      "void *",
      "uint32",
      "uint32",
      "uint32",
    ]);
    const TranslateMessage = user32.func(
      "__stdcall",
      "TranslateMessage",
      "int",
      ["MSG *"],
    );
    const DispatchMessageA = user32.func(
      "__stdcall",
      "DispatchMessageA",
      "int64",
      ["MSG *"],
    );

    const hInstance = GetModuleHandleA(null);

    // Usamos una clase existente (STATIC) para evitar RegisterClass/WndProc.
    const hwnd = CreateWindowExA(
      0,
      "STATIC",
      "MarCaribeFutronicMsgWindow",
      0,
      0,
      0,
      0,
      0,
      null,
      null,
      hInstance,
      null,
    );

    cachedMessageHwnd = hwnd || null;
    if (debug) {
      if (cachedMessageHwnd) {
        console.log("[DEBUG] message-hwnd creado exitosamente");
      } else {
        const code = GetLastError();
        console.log(
          `[DEBUG] message-hwnd NO se pudo crear (CreateWindowExA retornó NULL). GetLastError=${code}`,
        );
      }
    }

    if (cachedMessageHwnd && !messagePumpStarted) {
      messagePumpStarted = true;
      const pumpIntervalMsRaw = Number(
        process.env.FTR_MESSAGE_PUMP_INTERVAL_MS || 20,
      );
      const pumpIntervalMs =
        Number.isFinite(pumpIntervalMsRaw) && pumpIntervalMsRaw > 0
          ? Math.min(pumpIntervalMsRaw, 1000)
          : 20;
      const pumpMaxMessagesRaw = Number(
        process.env.FTR_MESSAGE_PUMP_MAX_MESSAGES || 200,
      );
      const pumpMaxMessages =
        Number.isFinite(pumpMaxMessagesRaw) && pumpMaxMessagesRaw > 0
          ? Math.min(pumpMaxMessagesRaw, 5000)
          : 200;

      const PM_REMOVE = 0x0001;

      setInterval(() => {
        try {
          // Drenar la cola de mensajes sin bloquear el event-loop.
          const msg = new MSG();
          let n = 0;
          while (
            n < pumpMaxMessages &&
            PeekMessageA(msg, null, 0, 0, PM_REMOVE)
          ) {
            TranslateMessage(msg);
            DispatchMessageA(msg);
            n += 1;
          }
        } catch {
          // ignore
        }
      }, pumpIntervalMs).unref?.();

      if (debug) {
        console.log(
          `[DEBUG] message pump iniciado intervalMs=${pumpIntervalMs} maxMessages=${pumpMaxMessages}`,
        );
      }
    }
  } catch {
    cachedMessageHwnd = null;
    if (debug) {
      console.log(
        "[DEBUG] message-hwnd: excepción creando ventana/message pump",
      );
    }
  }

  return cachedMessageHwnd;
}

function getConsoleHwnd() {
  if (cachedConsoleHwnd !== undefined) return cachedConsoleHwnd;
  cachedConsoleHwnd = null;
  if (process.platform !== "win32") return cachedConsoleHwnd;
  if (!nativeAvailable || !koffi) return cachedConsoleHwnd;
  try {
    const k32 = koffi.load("kernel32.dll");
    const GetConsoleWindow = k32.func(
      "__stdcall",
      "GetConsoleWindow",
      "void *",
      [],
    );
    const hwnd = GetConsoleWindow();
    cachedConsoleHwnd = hwnd || null;
  } catch {
    cachedConsoleHwnd = null;
  }
  return cachedConsoleHwnd;
}

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

function ensureWindowsDllDirInPath(dllPath) {
  if (process.platform !== "win32") return;
  if (typeof dllPath !== "string" || !dllPath.trim()) return;

  const dir = path.dirname(dllPath);
  if (!dir) return;

  const key =
    Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  const current = String(process.env[key] || "");
  const parts = current.split(";").filter(Boolean);

  const dirLower = dir.toLowerCase();
  const has = parts.some((p) => String(p).toLowerCase() === dirLower);
  if (!has) {
    process.env[key] = [dir, current].filter(Boolean).join(";");
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
      // Algunas funciones (p.ej. FTREnroll) pueden cargar dependencias por delay-load.
      // Meter la carpeta al PATH ayuda a que Windows resuelva ftrMathAPI/ftrWSQ/livefinger2.
      ensureWindowsDllDirInPath(candidate);
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

  const initialize = resolveFunction(
    lib,
    "FTRInitialize",
    [
      "FTRInitialize",
      "FTR_Initialize",
      "FTRInitializeA",
      "FTR_InitializeA",
      "_FTRInitialize@0",
      "FTRInitialize@0",
      "_FTR_Initialize@0",
      "FTR_Initialize@0",
    ],
    (loadedLib, name) => loadedLib.func("__stdcall", name, "int", []),
  );

  const terminate = resolveFunction(
    lib,
    "FTRTerminate",
    [
      "FTRTerminate",
      "FTR_Terminate",
      "FTRTerminateA",
      "FTR_TerminateA",
      "_FTRTerminate@0",
      "FTRTerminate@0",
      "_FTR_Terminate@0",
      "FTR_Terminate@0",
    ],
    (loadedLib, name) => loadedLib.func("__stdcall", name, "void", []),
  );

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
      "_FTRSetBaseTemplate@4",
      "FTRSetBaseTemplate@4",
      "_FTR_SetBaseTemplate@4",
      "FTR_SetBaseTemplate@4",
    ],
    (loadedLib, name) =>
      loadedLib.func("__stdcall", name, "int", ["FTR_DATA *"]),
  );

  const identify = resolveFunction(
    lib,
    "FTRIdentify",
    [
      "FTRIdentify",
      "FTR_Identify",
      "FTRIdentifyA",
      "FTR_IdentifyA",
      "_FTRIdentify@12",
      "FTRIdentify@12",
      "_FTR_Identify@12",
      "FTR_Identify@12",
    ],
    (loadedLib, name) =>
      loadedLib.func("__stdcall", name, "int", [
        "FTR_DATA *",
        "int *",
        "int *",
      ]),
  );

  const identifyN = resolveFunction(
    lib,
    "FTRIdentifyN",
    [
      "FTRIdentifyN",
      "FTR_IdentifyN",
      "FTRIdentifyNA",
      "FTR_IdentifyNA",
      "_FTRIdentifyN@12",
      "FTRIdentifyN@12",
      "_FTR_IdentifyN@12",
      "FTR_IdentifyN@12",
    ],
    (loadedLib, name) =>
      loadedLib.func("__stdcall", name, "int", [
        "FTR_DATA *",
        "int *",
        "int *",
      ]),
  );

  const captureFrame = resolveFunction(
    lib,
    "FTRCaptureFrame",
    [
      "FTRCaptureFrame",
      "FTR_CaptureFrame",
      "FTRCaptureFrameA",
      "FTR_CaptureFrameA",
      "_FTRCaptureFrame@8",
      "FTRCaptureFrame@8",
      "_FTR_CaptureFrame@8",
      "FTR_CaptureFrame@8",
    ],
    (loadedLib, name) =>
      // Por dump actual: stdcallArgBytes=8 (2 args).
      // No hay headers, pero lo más probable es (handle, purpose/timeout).
      loadedLib.func("__stdcall", name, "int", ["void *", "int"]),
  );

  const setParam = resolveFunction(
    lib,
    "FTRSetParam",
    [
      "FTRSetParam",
      "FTR_SetParam",
      "FTRSetParamA",
      "FTR_SetParamA",
      "_FTRSetParam@8",
      "FTRSetParam@8",
      "_FTR_SetParam@8",
      "FTR_SetParam@8",
    ],
    (loadedLib, name) =>
      loadedLib.func("__stdcall", name, "int", ["int", "int"]),
  );

  const getParam = resolveFunction(
    lib,
    "FTRGetParam",
    [
      "FTRGetParam",
      "FTR_GetParam",
      "FTRGetParamA",
      "FTR_GetParamA",
      "_FTRGetParam@8",
      "FTRGetParam@8",
      "_FTR_GetParam@8",
      "FTR_GetParam@8",
    ],
    (loadedLib, name) =>
      loadedLib.func("__stdcall", name, "int", ["int", "int *"]),
  );

  // Algunos SDKs exportan también las funciones de escaneo dentro de FTRAPI.dll.
  // Esto nos permite abrir un handle compatible con FTREnroll en caso de que el handle
  // proveniente de ftrScanAPI.dll no sea aceptado por FTREnroll.
  const scanOpen = resolveFunction(
    lib,
    "ftrScanOpenDevice",
    [
      // nombres comunes (SDK scan)
      "ftrScanOpenDevice",
      "_ftrScanOpenDevice@0",
      "ftrScanOpenDevice@0",

      // variantes vistas en algunos paquetes/SDKs
      "FTRScanOpenDevice",
      "FTRScanOpenDeviceA",
      "FTRScanOpenDeviceW",
      "_FTRScanOpenDevice@0",
      "FTRScanOpenDevice@0",
      "_FTRScanOpenDeviceA@0",
      "FTRScanOpenDeviceA@0",
      "_FTRScanOpenDeviceW@0",
      "FTRScanOpenDeviceW@0",
    ],
    (loadedLib, name) => loadedLib.func("__stdcall", name, "void *", []),
  );

  const scanClose = resolveFunction(
    lib,
    "ftrScanCloseDevice",
    [
      // nombres comunes (SDK scan)
      "ftrScanCloseDevice",
      "_ftrScanCloseDevice@4",
      "ftrScanCloseDevice@4",

      // variantes vistas en algunos paquetes/SDKs
      "FTRScanCloseDevice",
      "FTRScanCloseDeviceA",
      "FTRScanCloseDeviceW",
      "_FTRScanCloseDevice@4",
      "FTRScanCloseDevice@4",
      "_FTRScanCloseDeviceA@4",
      "FTRScanCloseDeviceA@4",
      "_FTRScanCloseDeviceW@4",
      "FTRScanCloseDeviceW@4",
    ],
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

  const enrollXPtr = resolveFunction(
    lib,
    "FTREnrollX",
    [
      "FTREnrollX",
      "FTR_EnrollX",
      "FTREnrollXA",
      "FTR_EnrollXA",
      "_FTREnrollX@16",
      "FTREnrollX@16",
      "_FTR_EnrollX@16",
      "FTR_EnrollX@16",
    ],
    (loadedLib, name) =>
      // Según el dump actual: stdcallArgBytes=16 (4 args).
      // En la práctica, este 4º argumento suele ser un puntero de salida (quality/flags).
      loadedLib.func("__stdcall", name, "int", [
        "void *",
        "int",
        "FTR_DATA *",
        "int *",
      ]),
  );

  const enrollXInt = enrollXPtr
    ? {
        name: enrollXPtr.name,
        fn: tryDeclare(() =>
          lib.func("__stdcall", enrollXPtr.name, "int", [
            "void *",
            "int",
            "FTR_DATA *",
            "int",
          ]),
        ),
      }
    : null;

  const debug =
    String(process.env.FINGERPRINT_AGENT_DEBUG_MATCH || "").trim() === "1";

  const logParamsOkOnly =
    String(process.env.FTR_DUMP_PARAMS_OK_ONLY || "1").trim() !== "0";

  let initResult = null;
  let initError = null;
  if (initialize?.fn) {
    try {
      initResult = initialize.fn();
      if (debug) {
        console.log(
          `[DEBUG] FTRInitialize() result=${initResult} name=${initialize.name} dll=${dllPath}`,
        );
      }
      if (typeof initResult === "number" && initResult !== 0) {
        initError = `FTRInitialize retornó ${initResult}`;
      }
    } catch (e) {
      initError = e?.message || String(e);
    }
  } else {
    // Si no existe, asumimos que no es requerida en esta build.
    initResult = 0;
  }

  // Intentar terminar cuando el proceso salga (best-effort)
  if (terminate?.fn) {
    const onceKey = "__marcaribe_ftr_terminate_hook";
    if (!globalThis[onceKey]) {
      globalThis[onceKey] = true;
      process.once("exit", () => {
        try {
          terminate.fn();
        } catch {
          // ignore
        }
      });
    }
  }

  return {
    dllPath,
    available: Boolean(setBase && identify) && !initError,
    FTR_DATA,
    FTRInitialize: initialize?.fn || null,
    FTRTerminate: terminate?.fn || null,
    FTRSetParam: setParam?.fn || null,
    FTRGetParam: getParam?.fn || null,
    FTRSetBaseTemplate: setBase?.fn || null,
    FTRIdentify: identify?.fn || null,
    FTRIdentifyN: identifyN?.fn || null,
    FTRCaptureFrame: captureFrame?.fn || null,
    FTREnroll: enroll?.fn || null,
    FTREnrollX: enrollXPtr?.fn || null,
    FTREnrollX_Int: enrollXInt?.fn || null,
    ftrScanOpenDevice: scanOpen?.fn || null,
    ftrScanCloseDevice: scanClose?.fn || null,
    names: {
      FTRInitialize: initialize?.name || null,
      FTRTerminate: terminate?.name || null,
      FTRSetParam: setParam?.name || null,
      FTRGetParam: getParam?.name || null,
      FTRSetBaseTemplate: setBase?.name || null,
      FTRIdentify: identify?.name || null,
      FTRIdentifyN: identifyN?.name || null,
      FTRCaptureFrame: captureFrame?.name || null,
      FTREnroll: enroll?.name || null,
      FTREnrollX: enrollXPtr?.name || null,
      ftrScanOpenDevice: scanOpen?.name || null,
      ftrScanCloseDevice: scanClose?.name || null,
    },
    loadError: null,
    initResult,
    initError,
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
  return Boolean(cached && (cached.FTREnroll || cached.FTREnrollX));
}

export function getMatcherInfo() {
  if (!cached) cached = loadMatcher();
  return cached
    ? {
        available: Boolean(cached.available),
        dllPath: cached.dllPath,
        names: cached.names,
        loadError: cached.loadError || null,
        initResult: cached.initResult ?? null,
        initError: cached.initError || null,
        triedPaths: Array.isArray(cached.triedPaths) ? cached.triedPaths : null,
      }
    : {
        available: false,
        dllPath: defaultDllPath,
        names: null,
        loadError: nativeAvailable ? "unknown" : "koffi_not_available",
        initResult: null,
        initError: null,
        triedPaths: null,
      };
}

export async function createTemplateFromDevice(
  deviceHandle,
  purpose,
  options = {},
) {
  if (!cached) cached = loadMatcher();

  if (!cached || (!cached.FTREnroll && !cached.FTREnrollX)) {
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

  function normalizeSetParams(raw) {
    if (!raw || typeof raw !== "string") return [];
    const parsed = safeJsonParse(raw);
    if (!parsed) return [];
    if (Array.isArray(parsed)) {
      return parsed
        .map((x) => ({
          id: Number(x?.id),
          value: Number(x?.value),
        }))
        .filter((x) => Number.isFinite(x.id) && Number.isFinite(x.value));
    }
    if (parsed && typeof parsed === "object") {
      return Object.entries(parsed)
        .map(([k, v]) => ({ id: Number(k), value: Number(v) }))
        .filter((x) => Number.isFinite(x.id) && Number.isFinite(x.value));
    }
    return [];
  }

  function applyParamsOnce() {
    const getRaw = process.env.FTR_GET_PARAMS_JSON;
    const getIds = (() => {
      if (!getRaw || typeof getRaw !== "string") return [];
      const parsed = safeJsonParse(getRaw);
      if (!parsed) return [];
      if (Array.isArray(parsed)) {
        return parsed.map((x) => Number(x)).filter((n) => Number.isFinite(n));
      }
      if (parsed && typeof parsed === "object") {
        return Object.keys(parsed)
          .map((k) => Number(k))
          .filter((n) => Number.isFinite(n));
      }
      return [];
    })();

    if (getIds.length && cached?.FTRGetParam) {
      for (const id of getIds) {
        try {
          const out = [0];
          const r = cached.FTRGetParam(id, out);
          if (debug) {
            console.log(
              `[DEBUG] FTRGetParam(${id}) result=${r} value=${out[0]}`,
            );
          } else if (r === 0 && (!logParamsOkOnly || out[0] !== 0)) {
            console.log(`[INFO] FTRGetParam(${id}) value=${out[0]}`);
          } else if (r === 0 && !logParamsOkOnly) {
            console.log(`[INFO] FTRGetParam(${id}) value=${out[0]}`);
          }
        } catch (e) {
          if (debug) {
            console.log(
              `[DEBUG] FTRGetParam(${id}) lanzó error: ${e?.message || String(e)}`,
            );
          }
        }
      }
    } else if (getIds.length && debug) {
      console.log(
        "[DEBUG] FTR_GET_PARAMS_JSON provisto pero FTRGetParam no está disponible en la DLL",
      );
    }

    const rangeRaw = String(process.env.FTR_DUMP_PARAMS_RANGE || "").trim();
    const rangeMatch = rangeRaw.match(/^\s*(\d+)\s*[-\.]{1,2}\s*(\d+)\s*$/);
    if (rangeMatch && cached?.FTRGetParam) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      const maxCountRaw = Number(process.env.FTR_DUMP_PARAMS_MAX || 200);
      const maxCount =
        Number.isFinite(maxCountRaw) && maxCountRaw > 0
          ? Math.min(maxCountRaw, 500)
          : 200;

      let count = 0;
      for (let id = lo; id <= hi; id += 1) {
        if (count >= maxCount) break;
        try {
          const out = [0];
          const r = cached.FTRGetParam(id, out);
          if (debug) {
            console.log(
              `[DEBUG] FTRGetParam(${id}) result=${r} value=${out[0]}`,
            );
          } else if (r === 0 && (!logParamsOkOnly || out[0] !== 0)) {
            console.log(`[INFO] FTRGetParam(${id}) value=${out[0]}`);
          } else if (r === 0 && !logParamsOkOnly) {
            console.log(`[INFO] FTRGetParam(${id}) value=${out[0]}`);
          }
        } catch (e) {
          if (debug) {
            console.log(
              `[DEBUG] FTRGetParam(${id}) lanzó error: ${e?.message || String(e)}`,
            );
          }
        }
        count += 1;
      }
    } else if (rangeMatch && debug && !cached?.FTRGetParam) {
      console.log(
        "[DEBUG] FTR_DUMP_PARAMS_RANGE provisto pero FTRGetParam no está disponible en la DLL",
      );
    }

    const raw = process.env.FTR_SET_PARAMS_JSON;
    const params = normalizeSetParams(raw);
    if (!params.length) return;
    if (!cached?.FTRSetParam) {
      if (debug) {
        console.log(
          "[DEBUG] FTR_SET_PARAMS_JSON provisto pero FTRSetParam no está disponible en la DLL",
        );
      }
      return;
    }
    for (const { id, value } of params) {
      try {
        const r = cached.FTRSetParam(id, value);
        if (debug) {
          console.log(`[DEBUG] FTRSetParam(${id}, ${value}) result=${r}`);
        }
      } catch (e) {
        if (debug) {
          console.log(
            `[DEBUG] FTRSetParam(${id}, ${value}) lanzó error: ${e?.message || String(e)}`,
          );
        }
      }
    }
  }

  // Imitar WorkedEx: suele setear parámetros antes de capturar/enrolar.
  // Permitimos configurar esos params desde config.json.env sin tocar código.
  applyParamsOnce();

  const handleMode = String(process.env.FTR_HANDLE_MODE || "auto").trim();
  const tryHwnd =
    handleMode === "hwnd" ||
    (handleMode === "auto" && process.platform === "win32");
  const messageHwnd = tryHwnd ? ensureMessagePumpAndWindow() : null;
  const consoleHwnd = tryHwnd ? getConsoleHwnd() : null;

  const probeOn201 =
    String(process.env.FTR_PARAM_PROBE_ON_201 || "0").trim() === "1";
  const keepProbeChanges =
    String(process.env.FTR_PARAM_PROBE_KEEP || "0").trim() === "1";
  let didProbeOnce = false;

  function parseJsonArrayEnv(envName, fallback) {
    const raw = process.env[envName];
    if (!raw || typeof raw !== "string") return fallback;
    const parsed = safeJsonParse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  }

  function getProbeParamIds() {
    const fallbackIds = [4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16];
    const arr = parseJsonArrayEnv("FTR_PARAM_PROBE_IDS_JSON", fallbackIds);
    return arr
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n >= 0);
  }

  function getProbeValues() {
    const fallbackValues = [1, 2, 3, 5, 10];
    const arr = parseJsonArrayEnv(
      "FTR_PARAM_PROBE_VALUES_JSON",
      fallbackValues,
    );
    return arr.map((x) => Number(x)).filter((n) => Number.isFinite(n));
  }

  function tryProbeParams(handle, label, purposeValue) {
    if (!probeOn201) return;
    if (didProbeOnce) return;
    if (!cached?.FTRSetParam || !cached?.FTRGetParam) return;
    if (!cached?.FTRCaptureFrame) return;

    didProbeOnce = true;

    const ids = getProbeParamIds();
    const values = getProbeValues();
    if (!ids.length || !values.length) return;

    const original = new Map();
    for (const id of ids) {
      try {
        const out = [0];
        const r = cached.FTRGetParam(id, out);
        if (r === 0) original.set(id, out[0]);
      } catch {
        // ignore
      }
    }

    console.log(
      `[INFO] Probe FTRSetParam iniciado (ids=${ids.length}, values=${values.length})`,
    );

    let best = null;
    for (const id of ids) {
      for (const v of values) {
        const prev = original.has(id) ? original.get(id) : null;
        if (prev !== null && prev === v) continue;
        try {
          const setR = cached.FTRSetParam(id, v);
          const capR = cached.FTRCaptureFrame(handle, purposeValue);
          if (debug) {
            console.log(
              `[DEBUG] Probe: SetParam(${id},${v}) setResult=${setR} CaptureFrame(${label})=${capR}`,
            );
          }

          // Heurística: cualquier cosa distinta de 201 ya es una señal.
          if (capR !== 201) {
            best = { id, value: v, setResult: setR, captureResult: capR };
            break;
          }
        } catch (e) {
          if (debug) {
            console.log(
              `[DEBUG] Probe: SetParam(${id},${v}) lanzó error: ${e?.message || String(e)}`,
            );
          }
        }
      }
      if (best) break;
    }

    if (best) {
      console.log(
        `[INFO] Probe encontró candidato: id=${best.id} value=${best.value} (CaptureFrame result=${best.captureResult})`,
      );
    } else {
      console.log(
        "[INFO] Probe no encontró cambios (CaptureFrame siguió en 201)",
      );
    }

    if (!keepProbeChanges) {
      for (const [id, prev] of original.entries()) {
        try {
          cached.FTRSetParam(id, prev);
        } catch {
          // ignore
        }
      }
      if (best) {
        console.log("[INFO] Probe revirtió FTRSetParam a valores originales");
      }
    }
  }

  let lastResult = null;
  let lastDwSize = null;

  function allocFtrData(templateBufferSize, outBuffer) {
    // Koffi puede representar structs de distintas maneras según versión.
    // Intentamos varias estrategias para obtener un FTR_DATA escribible.
    try {
      const a = koffi.alloc(cached.FTR_DATA, 1);
      if (a && typeof a === "object") {
        if (Object.prototype.hasOwnProperty.call(a, "dwSize")) {
          a.dwSize = templateBufferSize;
          a.pData = outBuffer;
          return { outObj: a, outPtr: koffi.as(a, "FTR_DATA *") };
        }
        if (a[0] && typeof a[0] === "object") {
          a[0].dwSize = templateBufferSize;
          a[0].pData = outBuffer;
          return { outObj: a[0], outPtr: koffi.as(a[0], "FTR_DATA *") };
        }
      }
    } catch {
      // ignore
    }

    try {
      if (typeof cached.FTR_DATA === "function") {
        const o = cached.FTR_DATA();
        if (o && typeof o === "object") {
          o.dwSize = templateBufferSize;
          o.pData = outBuffer;
          return { outObj: o, outPtr: koffi.as(o, "FTR_DATA *") };
        }
      }
    } catch {
      // ignore
    }

    const o = { dwSize: templateBufferSize, pData: outBuffer };
    return { outObj: o, outPtr: koffi.as(o, "FTR_DATA *") };
  }

  async function attemptEnroll(handle, attemptNo, label, purposeValue) {
    if (debug) {
      console.log(
        `[DEBUG] attemptEnroll:start label=${label} attempt=${attemptNo} purpose=${purposeValue} handle=${handle ? "non-null" : "null"}`,
      );
    }
    if (typeof options?.preCapture === "function") {
      try {
        await options.preCapture();
      } catch {
        // ignore
      }
    }

    // Algunos builds (como WorkedEx) parecen operar sin ftrScanAPI.dll.
    // En esos casos, FTREnroll/FTREnrollX pueden requerir que la captura se haga
    // vía FTRAPI.dll para poblar estado interno.
    const tryCaptureFrame =
      String(process.env.FTR_TRY_CAPTUREFRAME || "1").trim() === "1";
    if (tryCaptureFrame && cached.FTRCaptureFrame) {
      try {
        const capHandle =
          String(process.env.FTR_CAPTUREFRAME_TRY_NULL_HANDLE || "0").trim() ===
          "1"
            ? null
            : handle;
        const capRetriesRaw = Number(
          process.env.FTR_CAPTUREFRAME_RETRIES || 12,
        );
        const capRetries =
          Number.isFinite(capRetriesRaw) && capRetriesRaw >= 0
            ? Math.min(capRetriesRaw, 50)
            : 12;
        const capDelayRaw = Number(
          process.env.FTR_CAPTUREFRAME_DELAY_MS || 150,
        );
        const capDelayMs =
          Number.isFinite(capDelayRaw) && capDelayRaw >= 0
            ? Math.min(capDelayRaw, 2000)
            : 150;
        const requireOk =
          String(process.env.FTR_CAPTUREFRAME_REQUIRE_OK || "0").trim() !== "0";
        const blockEnrollOnNonZero =
          String(
            process.env.FTR_CAPTUREFRAME_BLOCK_ENROLL_ON_NONZERO || "0",
          ).trim() === "1";

        const capArg2Mode = String(
          process.env.FTR_CAPTUREFRAME_ARG2_MODE || "timeout",
        ).trim();
        const timeoutRaw = Number(
          process.env.FTR_CAPTUREFRAME_TIMEOUT_MS || 5000,
        );
        const timeoutMs =
          Number.isFinite(timeoutRaw) && timeoutRaw > 0
            ? Math.min(timeoutRaw, 60_000)
            : 5000;
        const capArg2 = capArg2Mode === "purpose" ? purposeValue : timeoutMs;

        let capResult = null;
        for (let i = 0; i <= capRetries; i += 1) {
          capResult = cached.FTRCaptureFrame(capHandle, capArg2);
          if (debug) {
            console.log(
              `[DEBUG] FTRCaptureFrame(${capHandle ? label : "null"}) arg2=${capArg2} mode=${capArg2Mode} try=${i + 1}/${capRetries + 1} result=${capResult}`,
            );
          }

          if (capResult === 201) {
            tryProbeParams(capHandle, capHandle ? label : "null", purposeValue);
          }

          // 0 = OK (captura completada). Cualquier otro código: reintentar.
          if (capResult === 0) break;
          if (i < capRetries && capDelayMs > 0) {
            await new Promise((r) => setTimeout(r, capDelayMs));
          }
        }

        if (requireOk && capResult !== 0) {
          if (debug) {
            console.log(
              `[DEBUG] FTRCaptureFrame no retornó 0 (result=${capResult}); requireOk=1`,
            );
          }
          if (blockEnrollOnNonZero) {
            // Modo estricto: si la captura previa no se completó, evitamos FTREnroll.
            return null;
          }
          // Modo no estricto (default): continuar a FTREnroll/FTREnrollX.
        }
      } catch (e) {
        if (debug) {
          console.log(
            `[DEBUG] FTRCaptureFrame lanzó error: ${e?.message || String(e)}`,
          );
        }
      }
    }

    const outBuffer = Buffer.alloc(templateBufferSize);
    const { outObj: out, outPtr } = allocFtrData(templateBufferSize, outBuffer);

    const forceEnrollX =
      String(process.env.FTR_ENROLL_FORCE_X || "").trim() === "1";
    const hasEnroll = Boolean(cached.FTREnroll);
    const hasEnrollX = Boolean(cached.FTREnrollX);
    const useEnrollXFirst = hasEnrollX && (forceEnrollX || !hasEnroll);

    const callEnroll = () => cached.FTREnroll(handle, purposeValue, outPtr);
    const callEnrollX = () => {
      if (!cached.FTREnrollX) {
        throw new Error("FTREnrollX no está disponible");
      }

      const mode = String(process.env.FTR_ENROLLX_ARG4_MODE || "ptr").trim();

      if (mode === "null") {
        return cached.FTREnrollX(handle, purposeValue, outPtr, null);
      }

      if (mode === "int") {
        if (!cached.FTREnrollX_Int) {
          throw new Error("FTREnrollX_Int no está disponible");
        }
        const arg4Raw = process.env.FTR_ENROLLX_ARG4;
        const arg4Num = Number(arg4Raw);
        const arg4 = Number.isFinite(arg4Num) ? arg4Num : 0;
        return cached.FTREnrollX_Int(handle, purposeValue, outPtr, arg4);
      }

      // default: ptr (int*)
      const outArg = [0];
      return cached.FTREnrollX(handle, purposeValue, outPtr, outArg);
    };

    // IMPORTANT: FTREnroll/FTREnrollX reciben FTR_DATA*; hay que pasar un puntero real.
    let result = null;
    let used = null;
    if (useEnrollXFirst) {
      used = "FTREnrollX";
      if (debug) {
        console.log(
          `[DEBUG] llamando ${used}(${label}) purpose=${purposeValue}...`,
        );
      }
      result = callEnrollX();
    } else {
      used = "FTREnroll";
      if (debug) {
        console.log(
          `[DEBUG] llamando ${used}(${label}) purpose=${purposeValue}...`,
        );
      }
      result = callEnroll();
    }

    // Fallback automático: si FTREnroll devuelve 201 y existe FTREnrollX, probar EnrollX.
    if (
      used === "FTREnroll" &&
      result === 201 &&
      cached.FTREnrollX &&
      String(process.env.FTR_ENROLL_NO_X_FALLBACK || "").trim() !== "1"
    ) {
      try {
        const resultX = callEnrollX();
        if (debug) {
          console.log(
            `[DEBUG] FTREnroll -> 201; fallback a FTREnrollX result=${resultX}`,
          );
        }
        used = "FTREnrollX";
        result = resultX;
      } catch (e) {
        if (debug) {
          console.log(
            `[DEBUG] fallback FTREnrollX lanzó error: ${e?.message || String(e)}`,
          );
        }
      }
    }
    lastResult = result;
    lastDwSize = out.dwSize;

    if (debug) {
      console.log(
        `[DEBUG] ${used}(${label}) attempt=${attemptNo} purpose=${purposeValue} result=${result} dwSize=${out.dwSize}`,
      );
    }

    if (result === 0 && out.dwSize > 0 && out.dwSize <= templateBufferSize) {
      const tpl = outBuffer.slice(0, out.dwSize);
      const hasData = tpl.some((b) => b !== 0);
      if (hasData) return tpl;
    }
    if (debug) {
      console.log(
        `[DEBUG] attemptEnroll:end label=${label} attempt=${attemptNo} purpose=${purposeValue} tpl=null lastResult=${lastResult} dwSize=${lastDwSize}`,
      );
    }
    return null;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    for (const purposeValue of purposeCandidates) {
      // Selección de handle:
      // - WorkedEx es GUI; es común que Futronic use HWND (GetConsoleWindow sirve en consola).
      // - Algunos builds aceptan NULL.
      // - Si el caller provee deviceHandle (scanAPI), se intenta primero en modo auto.
      const tryNullHandle =
        String(process.env.FTR_ENROLL_TRY_NULL_HANDLE || "1").trim() === "1";

      const candidates = [];
      if (handleMode === "scan" || handleMode === "auto") {
        if (deviceHandle)
          candidates.push({ h: deviceHandle, label: "scanner-handle" });
      }
      if (tryHwnd && messageHwnd) {
        candidates.push({ h: messageHwnd, label: "message-hwnd" });
      }
      if (tryHwnd && consoleHwnd) {
        candidates.push({ h: consoleHwnd, label: "console-hwnd" });
      }
      if (tryNullHandle) {
        candidates.push({ h: null, label: "null-handle" });
      }

      for (const c of candidates) {
        const tpl = await attemptEnroll(c.h, attempt, c.label, purposeValue);
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

  const baseBuf = baseTemplate;
  const probeBuf = probeTemplate;

  const base = { dwSize: baseBuf.length, pData: baseBuf };
  const setResult = cached.FTRSetBaseTemplate(koffi.as(base, "FTR_DATA *"));
  if (setResult !== 0) {
    return {
      matched: false,
      error: `Error en FTRSetBaseTemplate: ${setResult}`,
      code: setResult,
      details: { baseLen: baseBuf.length, rawBaseLen: baseTemplate.length },
    };
  }

  const probe = { dwSize: probeBuf.length, pData: probeBuf };
  // Importante: inicializar en -1 para evitar que 0 (match) sea el valor por defecto
  // si la DLL no llega a escribir el resultado por algún motivo.
  const matchedIndex = [-1];
  const score = [0];

  const identifyResult = cached.FTRIdentify(
    koffi.as(probe, "FTR_DATA *"),
    matchedIndex,
    score,
  );

  // Algunas builds del SDK funcionan mejor con FTRIdentifyN.
  // Si Identify falla y tenemos IdentifyN, reintentamos ahí.
  let identifyNResult = null;
  if (identifyResult !== 0 && typeof cached.FTRIdentifyN === "function") {
    const matchedIndexN = [-1];
    const scoreN = [0];
    identifyNResult = cached.FTRIdentifyN(
      koffi.as(probe, "FTR_DATA *"),
      matchedIndexN,
      scoreN,
    );
    if (identifyNResult === 0) {
      matchedIndex[0] = matchedIndexN[0];
      score[0] = scoreN[0];
    }
  }

  if (identifyResult !== 0 && identifyNResult !== 0) {
    const used =
      identifyNResult == null ? "FTRIdentify" : "FTRIdentify+FTRIdentifyN";
    return {
      matched: false,
      error:
        identifyNResult == null
          ? `Error en FTRIdentify: ${identifyResult}`
          : `Error en FTRIdentify: ${identifyResult} (también FTRIdentifyN: ${identifyNResult})`,
      code: identifyNResult == null ? identifyResult : identifyNResult,
      details: {
        used,
        identifyResult,
        identifyNResult,
        baseLen: baseBuf.length,
        probeLen: probeBuf.length,
        rawBaseLen: baseTemplate.length,
        rawProbeLen: probeTemplate.length,
        normalized: false,
      },
    };
  }

  const idx = matchedIndex[0];
  const sc = score[0];

  // Semántica esperada (según implementación previa): index 0 => coincide con base.
  // Algunas builds podrían usar índice 1-based cuando solo hay un template.
  const matched = idx === 0 || idx === 1;

  return { matched, score: sc, index: idx };
}
