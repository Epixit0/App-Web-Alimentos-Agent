import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import fs from "fs";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let koffi = null;
let lib = null;

try {
  koffi = require("koffi");
  // Ajusta esta ruta a donde tengas realmente tu FTRAPI.dll
  const dllPath = join(
    "C:",
    "ProgramData",
    "MarCaribeFingerprintAgent",
    "App-Web-Alimentos-Agent",
    "lib",
    "FTRAPI.dll",
  );
  lib = koffi.load(dllPath);
  console.log("[OK] Motor FTRAPI cargado correctamente.");
} catch (error) {
  console.error("Error cargando dependencias nativas:", error.message);
}

// --- DEFINICIÓN DE ESTRUCTURAS FUTRONIC ---
// Es vital definir FTR_DATA para que Koffi sepa cómo enviar buffers a la DLL
const FTR_DATA = koffi.struct("FTR_DATA", {
  dwSize: "uint32",
  pData: "pointer",
});

// --- VINCULACIÓN DE FUNCIONES ---
const FTRInitialize = lib ? lib.func("int FTRInitialize()") : null;
const FTRTerminate = lib ? lib.func("int FTRTerminate()") : null;
const FTREnroll = lib
  ? lib.func("int FTREnroll(int nSlot, pointer pTemplate)")
  : null;
// FTRSetParam ayuda a configurar el tiempo de espera y otros detalles
const FTRSetParam = lib
  ? lib.func("int FTRSetParam(int nParam, int nValue)")
  : null;

// Inicializamos el motor nada más cargar el módulo
if (FTRInitialize) FTRInitialize();

function getExpectedWindowsDllArch() {
  // Node en Windows suele ser x64 en Win10; si fuera x86, process.arch será ia32.
  if (process.arch === "x64") return "x64";
  if (process.arch === "ia32") return "x86";
  return process.arch;
}

function readUInt16LESafe(buffer, offset) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (offset < 0 || offset + 2 > buffer.length) return null;
  return buffer.readUInt16LE(offset);
}

function readUInt32LESafe(buffer, offset) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (offset < 0 || offset + 4 > buffer.length) return null;
  return buffer.readUInt32LE(offset);
}

function detectPeMachine(filePath) {
  // Detecta arquitectura (x86/x64) leyendo header PE.
  // Retorna: { arch: 'x86'|'x64'|null, machine: number|null, error?: string }
  try {
    const data = fs.readFileSync(filePath);
    if (data.length < 0x40)
      return { arch: null, machine: null, error: "Archivo muy pequeño" };
    // DOS header debe iniciar con 'MZ'
    if (data[0] !== 0x4d || data[1] !== 0x5a) {
      return {
        arch: null,
        machine: null,
        error: "No es un PE válido (sin MZ)",
      };
    }
    const e_lfanew = readUInt32LESafe(data, 0x3c);
    if (e_lfanew == null)
      return { arch: null, machine: null, error: "No se pudo leer e_lfanew" };
    if (e_lfanew + 6 > data.length)
      return { arch: null, machine: null, error: "Header PE fuera de rango" };
    // Firma PE = 'PE\0\0'
    if (
      data[e_lfanew] !== 0x50 ||
      data[e_lfanew + 1] !== 0x45 ||
      data[e_lfanew + 2] !== 0x00 ||
      data[e_lfanew + 3] !== 0x00
    ) {
      return {
        arch: null,
        machine: null,
        error: "No es un PE válido (sin firma PE)",
      };
    }
    const machine = readUInt16LESafe(data, e_lfanew + 4);
    if (machine == null)
      return { arch: null, machine: null, error: "No se pudo leer machine" };

    // Valores comunes:
    // 0x014c = IMAGE_FILE_MACHINE_I386 (x86)
    // 0x8664 = IMAGE_FILE_MACHINE_AMD64 (x64)
    let arch = null;
    if (machine === 0x014c) arch = "x86";
    if (machine === 0x8664) arch = "x64";
    return { arch, machine };
  } catch (error) {
    return {
      arch: null,
      machine: null,
      error: error?.message || String(error),
    };
  }
}

const FTRSCAN_FRAME_PARAMETERS = nativeDepsAvailable
  ? koffi.struct("FTRSCAN_FRAME_PARAMETERS", {
      nWidth: "int",
      nHeight: "int",
      nImageSize: "int",
      nResolution: "int",
    })
  : null;

let ftrScanAPI = null;
let lastLoadedScanDll = null;
let lastLoadedScanDllName = null;

// En el agente, las DLL deben estar en App-Web-Alimentos-Agent/lib
const ftrAPIPathDefault = path.join(__dirname, "../lib/FTRAPI.dll");
const ftrScanAPIPathDefault = path.join(__dirname, "../lib/ftrScanAPI.dll");

const ftrAPIPath =
  typeof process.env.FTRSCAN_FALLBACK_DLL_PATH === "string" &&
  process.env.FTRSCAN_FALLBACK_DLL_PATH.trim()
    ? process.env.FTRSCAN_FALLBACK_DLL_PATH.trim()
    : ftrAPIPathDefault;

const ftrScanAPIPath =
  typeof process.env.FTRSCAN_DLL_PATH === "string" &&
  process.env.FTRSCAN_DLL_PATH.trim()
    ? process.env.FTRSCAN_DLL_PATH.trim()
    : ftrScanAPIPathDefault;

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
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

  // Comparación case-insensitive en Windows
  const dirLower = dir.toLowerCase();
  const has = parts.some((p) => String(p).toLowerCase() === dirLower);
  if (!has) {
    process.env[key] = [dir, current].filter(Boolean).join(";");
  }
}

function loadScanDLL(dllPath, dllName) {
  try {
    if (!nativeDepsAvailable) {
      return null;
    }

    if (typeof dllPath !== "string") {
      console.warn(`[WARN] Ruta inválida para ${dllName} (no es string)`);
      return null;
    }

    if (!fileExists(dllPath)) {
      console.warn(`[WARN] ${dllName} no encontrada en: ${dllPath}`);
      return null;
    }

    // Validar arquitectura de la DLL vs arquitectura del proceso
    const expected = getExpectedWindowsDllArch();
    const detected = detectPeMachine(dllPath);
    if (detected.arch && detected.arch !== expected) {
      const suggestedNodeArch = detected.arch === "x86" ? "x86 (ia32)" : "x64";
      console.error(
        `[ERROR] ${dllName} parece ser ${detected.arch} pero tu Node es ${expected}.\n` +
          `  Esto causa el error Win32 193 (Bad EXE format).\n` +
          `  Soluciones posibles:\n` +
          `  - Usar DLLs ${expected} (por ejemplo, carpeta ${expected} del SDK/driver de Futronic).\n` +
          `  - O correr el agente con Node ${suggestedNodeArch} para que coincida con tus DLLs.`,
      );
      return null;
    }

    // Importante: algunas DLLs de Futronic cargan dependencias (ftrMathAPI, ftrWSQ,
    // livefinger2) en tiempo de ejecución. Asegurar el PATH evita fallos misteriosos.
    ensureWindowsDllDirInPath(dllPath);

    const lib = koffi.load(dllPath);

    // En x86 Windows normalmente Futronic usa stdcall.
    // La sintaxis clásica hace explícita la convención y evita ambigüedades.
    const library = {
      ftrScanOpenDevice: lib.func(
        "__stdcall",
        "ftrScanOpenDevice",
        "void *",
        [],
      ),
      ftrScanGetFrame: lib.func("__stdcall", "ftrScanGetFrame", "int", [
        "void *",
        "void *",
        "FTRSCAN_FRAME_PARAMETERS *",
      ]),
      ftrScanCloseDevice: lib.func("__stdcall", "ftrScanCloseDevice", "void", [
        "void *",
      ]),
    };

    console.log(`[OK] ${dllName} cargada exitosamente (funciones de escaneo)`);
    lastLoadedScanDll = dllPath;
    lastLoadedScanDllName = dllName;
    return library;
  } catch (error) {
    const msg = error?.message || String(error);
    console.warn(`[WARN] Error al cargar ${dllName}:`, msg);
    console.warn(`  Ruta intentada: ${dllPath}`);

    // Mensaje más claro para el error típico de arquitectura
    if (/Win32 error 193/i.test(msg) || /error 193/i.test(msg)) {
      console.warn(
        `  Suele significar DLL de 32 bits en Node 64 bits (o viceversa).\n` +
          `  Tu Node: ${getExpectedWindowsDllArch()}`,
      );
    }

    if (error.stack) {
      console.warn(
        `  Stack: ${error.stack.split("\n").slice(0, 3).join("\n")}`,
      );
    }
    return null;
  }
}

// Para captura, normalmente se usa ftrScanAPI.dll. FTRAPI.dll puede existir
// pero no es necesaria para obtener frames en esta versión del agente.
let scannerLibInitAttempted = false;

function ensureScannerLibraryLoaded() {
  if (scannerLibInitAttempted) return;
  scannerLibInitAttempted = true;

  // Re-evalúa paths desde env (puede venir de config.json)
  const ftrAPIPathRuntime =
    typeof process.env.FTRSCAN_FALLBACK_DLL_PATH === "string" &&
    process.env.FTRSCAN_FALLBACK_DLL_PATH.trim()
      ? process.env.FTRSCAN_FALLBACK_DLL_PATH.trim()
      : ftrAPIPathDefault;

  const ftrScanAPIPathRuntime =
    typeof process.env.FTRSCAN_DLL_PATH === "string" &&
    process.env.FTRSCAN_DLL_PATH.trim()
      ? process.env.FTRSCAN_DLL_PATH.trim()
      : ftrScanAPIPathDefault;

  ftrScanAPI = loadScanDLL(ftrScanAPIPathRuntime, "ftrScanAPI.dll");

  if (!ftrScanAPI) {
    console.log("  Intentando cargar desde FTRAPI.dll...");
    ftrScanAPI = loadScanDLL(ftrAPIPathRuntime, "FTRAPI.dll");
  } else if (fileExists(ftrAPIPathRuntime)) {
    // Si ftrScanAPI.dll ya cargó, reporta incompatibilidad de FTRAPI.dll como warning
    // (en vez de error) para evitar confusión cuando hay DLLs mezcladas.
    const expected = getExpectedWindowsDllArch();
    const detected = detectPeMachine(ftrAPIPathRuntime);
    if (detected.arch && detected.arch !== expected) {
      console.warn(
        `[WARN] FTRAPI.dll parece ser ${detected.arch} pero tu Node es ${expected}. ` +
          `Si ftrScanAPI.dll ya cargó, la captura puede funcionar igual. ` +
          `Evita mezclar DLLs x86/x64 y usa el mismo paquete (x86 o x64) para ambas.`,
      );
    }
  }

  if (!ftrScanAPI) {
    console.error("[ERROR] No se pudo cargar ninguna DLL de escaneo");
    console.error(
      "[WARN] El lector de huellas no estará disponible en el agente",
    );
  }
}

const FTR_TRUE = 1;

class FingerprintScanner {
  constructor() {
    this.handle = null;
    this.isOpen = false;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  isNullHandle(handle) {
    if (handle == null) return true;
    if (typeof handle === "number") return handle === 0;

    if (nativeDepsAvailable && koffi && typeof koffi.address === "function") {
      try {
        const addr = koffi.address(handle);
        if (typeof addr === "bigint") return addr === 0n;
        if (typeof addr === "number") return addr === 0;
      } catch {
        // ignore
      }
    }

    if (Buffer.isBuffer(handle)) {
      return handle.length === 0;
    }

    if (typeof handle.isNull === "function") {
      try {
        return handle.isNull();
      } catch {
        return false;
      }
    }

    return false;
  }

  openDevice() {
    try {
      ensureScannerLibraryLoaded();
      if (!ftrScanAPI) {
        this.isOpen = false;
        return false;
      }

      if (this.isOpen) {
        return true;
      }

      const retriesRaw = Number(process.env.FTRSCAN_OPEN_RETRIES || 5);
      const retries =
        Number.isFinite(retriesRaw) && retriesRaw >= 0
          ? Math.min(retriesRaw, 20)
          : 5;
      const delayRaw = Number(process.env.FTRSCAN_OPEN_DELAY_MS || 300);
      const delayMs =
        Number.isFinite(delayRaw) && delayRaw >= 0
          ? Math.min(delayRaw, 2000)
          : 300;
      const debug = String(process.env.DEBUG_FINGERPRINT || "").trim() === "1";

      for (let attempt = 0; attempt <= retries; attempt += 1) {
        this.handle = ftrScanAPI.ftrScanOpenDevice();
        if (!this.isNullHandle(this.handle)) {
          this.isOpen = true;
          return true;
        }

        if (debug) {
          console.log(
            `[DEBUG_FINGERPRINT] ftrScanOpenDevice devolvió NULL (try=${attempt + 1}/${retries + 1}) dll=${lastLoadedScanDllName || "?"} path=${lastLoadedScanDll || "?"}`,
          );
        }

        if (attempt < retries && delayMs > 0) {
          // Espera corta: si el device está ocupado por otro proceso, a veces se libera.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
        }
      }

      this.isOpen = false;
      if (debug) {
        console.log(
          "[DEBUG_FINGERPRINT] No se pudo abrir el dispositivo del escáner (handle NULL). Sugerencias: cerrar WorkedEx/otras instancias del agente, desconectar/reconectar el lector.",
        );
      }
      return false;
    } catch {
      this.isOpen = false;
      return false;
    }
  }

  isDeviceAvailable() {
    try {
      ensureScannerLibraryLoaded();
      if (!ftrScanAPI) {
        return false;
      }
      const testHandle = ftrScanAPI.ftrScanOpenDevice();
      if (this.isNullHandle(testHandle)) {
        return false;
      }
      ftrScanAPI.ftrScanCloseDevice(testHandle);
      return true;
    } catch {
      return false;
    }
  }

  getFrame(bufferSize = 153600) {
    try {
      ensureScannerLibraryLoaded();
      if (!ftrScanAPI) {
        return null;
      }

      if (!FTRSCAN_FRAME_PARAMETERS) {
        return null;
      }

      if (!this.isOpen || !this.handle || this.isNullHandle(this.handle)) {
        return null;
      }

      const imageBuffer = Buffer.alloc(bufferSize);

      // Con Koffi, para argumentos `Struct *` es más confiable pasar un objeto
      // (Koffi maneja la memoria y escribe de vuelta los campos).
      const frameParams = {
        nWidth: 0,
        nHeight: 0,
        nImageSize: bufferSize,
        nResolution: 0,
      };

      const result = ftrScanAPI.ftrScanGetFrame(
        this.handle,
        imageBuffer,
        frameParams,
      );

      if (process.env.DEBUG_FINGERPRINT === "1") {
        console.log(
          `[DEBUG_FINGERPRINT] ftrScanGetFrame result=${result} size=${frameParams.nImageSize} w=${frameParams.nWidth} h=${frameParams.nHeight} res=${frameParams.nResolution}`,
        );
      }

      if (result !== FTR_TRUE) {
        return null;
      }

      const actualSize =
        frameParams.nImageSize > 0 ? frameParams.nImageSize : bufferSize;

      return imageBuffer.slice(0, actualSize);
    } catch {
      return null;
    }
  }

  async getFrameAsync(bufferSize = 153600) {
    try {
      ensureScannerLibraryLoaded();
      if (!ftrScanAPI) return null;
      if (!FTRSCAN_FRAME_PARAMETERS) return null;
      if (!this.isOpen || !this.handle || this.isNullHandle(this.handle))
        return null;

      const fn = ftrScanAPI.ftrScanGetFrame;
      if (!fn || typeof fn.async !== "function") {
        // Fallback: si por alguna razón no existe .async
        return this.getFrame(bufferSize);
      }

      const imageBuffer = Buffer.alloc(bufferSize);

      const frameParams = {
        nWidth: 0,
        nHeight: 0,
        nImageSize: bufferSize,
        nResolution: 0,
      };

      const result = await new Promise((resolve, reject) => {
        fn.async(this.handle, imageBuffer, frameParams, (err, res) => {
          if (err) reject(err);
          else resolve(res);
        });
      });

      if (process.env.DEBUG_FINGERPRINT === "1") {
        console.log(
          `[DEBUG_FINGERPRINT] ftrScanGetFrame.async result=${result} size=${frameParams.nImageSize} w=${frameParams.nWidth} h=${frameParams.nHeight} res=${frameParams.nResolution}`,
        );
      }

      if (result !== FTR_TRUE) {
        return null;
      }

      const actualSize =
        frameParams.nImageSize > 0 ? frameParams.nImageSize : bufferSize;

      return imageBuffer.slice(0, actualSize);
    } catch {
      return null;
    }
  }

  async captureFingerprint(maxAttempts = 3, bufferSize = 153600) {
    for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
      const frame = await this.getFrameAsync(bufferSize);
      if (frame && frame.length > 0) {
        return frame;
      }
      if (attempts < maxAttempts) {
        await this.sleep(250);
      }
    }
    return null;
  }

  closeDevice() {
    try {
      if (!ftrScanAPI) {
        return;
      }
      if (this.isOpen && this.handle && !this.isNullHandle(this.handle)) {
        ftrScanAPI.ftrScanCloseDevice(this.handle);
        this.handle = null;
        this.isOpen = false;
      }
    } catch {
      // ignore
    }
  }
}

let scannerInstance = null;

export const getScanner = () => {
  if (!scannerInstance) {
    scannerInstance = new FingerprintScanner();
  }
  return scannerInstance;
};

export default FingerprintScanner;
