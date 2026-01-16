import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import fs from "fs";

const require = createRequire(import.meta.url);

let ffi = null;
let ref = null;
let StructType = null;
let nativeDepsAvailable = false;

try {
  ffi = require("ffi-napi");
  ref = require("ref-napi");
  StructType = require("ref-struct-napi");
  nativeDepsAvailable = true;
} catch (error) {
  const message = error?.message || String(error);
  console.error(
    "Dependencias nativas del lector (ffi-napi/ref-napi) no disponibles en el agente.",
    message
  );
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
    if (data.length < 0x40) return { arch: null, machine: null, error: "Archivo muy pequeño" };
    // DOS header debe iniciar con 'MZ'
    if (data[0] !== 0x4d || data[1] !== 0x5a) {
      return { arch: null, machine: null, error: "No es un PE válido (sin MZ)" };
    }
    const e_lfanew = readUInt32LESafe(data, 0x3c);
    if (e_lfanew == null) return { arch: null, machine: null, error: "No se pudo leer e_lfanew" };
    if (e_lfanew + 6 > data.length) return { arch: null, machine: null, error: "Header PE fuera de rango" };
    // Firma PE = 'PE\0\0'
    if (
      data[e_lfanew] !== 0x50 ||
      data[e_lfanew + 1] !== 0x45 ||
      data[e_lfanew + 2] !== 0x00 ||
      data[e_lfanew + 3] !== 0x00
    ) {
      return { arch: null, machine: null, error: "No es un PE válido (sin firma PE)" };
    }
    const machine = readUInt16LESafe(data, e_lfanew + 4);
    if (machine == null) return { arch: null, machine: null, error: "No se pudo leer machine" };

    // Valores comunes:
    // 0x014c = IMAGE_FILE_MACHINE_I386 (x86)
    // 0x8664 = IMAGE_FILE_MACHINE_AMD64 (x64)
    let arch = null;
    if (machine === 0x014c) arch = "x86";
    if (machine === 0x8664) arch = "x64";
    return { arch, machine };
  } catch (error) {
    return { arch: null, machine: null, error: error?.message || String(error) };
  }
}

// Definir tipos para FFI (solo si están disponibles)
const FTRHANDLE = nativeDepsAvailable ? ref.refType(ref.types.void) : null;
const FTR_PVOID = nativeDepsAvailable ? ref.refType(ref.types.void) : null;
const FTR_BOOL = nativeDepsAvailable ? ref.types.int32 : null; // TRUE = 1, FALSE = 0

const FTRSCAN_FRAME_PARAMETERS = nativeDepsAvailable
  ? StructType({
      nWidth: ref.types.int32,
      nHeight: ref.types.int32,
      nImageSize: ref.types.int32,
      nResolution: ref.types.int32,
    })
  : null;

let ftrScanAPI = null;

// En el agente, las DLL deben estar en App-Web-Alimentos-Agent/lib
const ftrAPIPath = path.join(__dirname, "../lib/FTRAPI.dll");
const ftrScanAPIPath = path.join(__dirname, "../lib/ftrScanAPI.dll");

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function loadScanDLL(dllPath, dllName) {
  try {
    if (!nativeDepsAvailable) {
      return null;
    }

    if (typeof dllPath !== "string") {
      console.warn(`⚠ Ruta inválida para ${dllName} (no es string)`);
      return null;
    }

    if (!fileExists(dllPath)) {
      console.warn(`⚠ ${dllName} no encontrada en: ${dllPath}`);
      return null;
    }

    // Validar arquitectura de la DLL vs arquitectura del proceso
    const expected = getExpectedWindowsDllArch();
    const detected = detectPeMachine(dllPath);
    if (detected.arch && detected.arch !== expected) {
      console.error(
        `✗ ${dllName} parece ser ${detected.arch} pero tu Node es ${expected}.\n` +
          `  Esto causa el error Win32 193 (Bad EXE format).\n` +
          `  Solución: copia las DLLs de la carpeta x64 del SDK/driver de Futronic.`
      );
      return null;
    }

    const library = ffi.Library(dllPath, {
      ftrScanOpenDevice: [FTRHANDLE, []],
      ftrScanGetFrame: [
        FTR_BOOL,
        [FTRHANDLE, FTR_PVOID, FTRSCAN_FRAME_PARAMETERS],
      ],
      ftrScanCloseDevice: ["void", [FTRHANDLE]],
    });

    console.log(`✓ ${dllName} cargada exitosamente (funciones de escaneo)`);
    return library;
  } catch (error) {
    const msg = error?.message || String(error);
    console.warn(`⚠ Error al cargar ${dllName}:`, msg);
    console.warn(`  Ruta intentada: ${dllPath}`);

    // Mensaje más claro para el error típico de arquitectura
    if (/Win32 error 193/i.test(msg) || /error 193/i.test(msg)) {
      console.warn(
        `  Suele significar DLL de 32 bits en Node 64 bits (o viceversa).\n` +
          `  Tu Node: ${getExpectedWindowsDllArch()}`
      );
    }

    if (error.stack) {
      console.warn(
        `  Stack: ${error.stack.split("\n").slice(0, 3).join("\n")}`
      );
    }
    return null;
  }
}

ftrScanAPI = loadScanDLL(ftrAPIPath, "FTRAPI.dll");

if (!ftrScanAPI) {
  console.log("  Intentando cargar desde ftrScanAPI.dll...");
  ftrScanAPI = loadScanDLL(ftrScanAPIPath, "ftrScanAPI.dll");
}

if (!ftrScanAPI) {
  console.error("✗ No se pudo cargar ninguna DLL de escaneo");
  console.error("⚠ El lector de huellas no estará disponible en el agente");
}

const FTR_TRUE = 1;

class FingerprintScanner {
  constructor() {
    this.handle = null;
    this.isOpen = false;
  }

  openDevice() {
    try {
      if (!ftrScanAPI) {
        this.isOpen = false;
        return false;
      }

      if (this.isOpen) {
        return true;
      }

      this.handle = ftrScanAPI.ftrScanOpenDevice();

      if (this.handle.isNull()) {
        this.isOpen = false;
        return false;
      }

      this.isOpen = true;
      return true;
    } catch {
      this.isOpen = false;
      return false;
    }
  }

  isDeviceAvailable() {
    try {
      if (!ftrScanAPI) {
        return false;
      }
      const testHandle = ftrScanAPI.ftrScanOpenDevice();
      if (testHandle.isNull()) {
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
      if (!ftrScanAPI) {
        return null;
      }

      if (
        !this.isOpen ||
        !this.handle ||
        (typeof this.handle.isNull === "function" && this.handle.isNull())
      ) {
        return null;
      }

      const imageBuffer = Buffer.alloc(bufferSize);

      const frameParams = new FTRSCAN_FRAME_PARAMETERS();
      frameParams.nWidth = 0;
      frameParams.nHeight = 0;
      frameParams.nImageSize = 0;
      frameParams.nResolution = 0;

      const result = ftrScanAPI.ftrScanGetFrame(
        this.handle,
        imageBuffer,
        frameParams
      );

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
    return new Promise((resolve) => {
      let attempts = 0;

      const tryCapture = () => {
        attempts++;
        const frame = this.getFrame(bufferSize);

        if (frame && frame.length > 0) {
          resolve(frame);
        } else if (attempts < maxAttempts) {
          setTimeout(tryCapture, 2000);
        } else {
          resolve(null);
        }
      };

      tryCapture();
    });
  }

  closeDevice() {
    try {
      if (!ftrScanAPI) {
        return;
      }
      if (
        this.isOpen &&
        this.handle &&
        (typeof this.handle.isNull !== "function" || !this.handle.isNull())
      ) {
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
