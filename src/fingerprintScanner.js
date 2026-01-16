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

    if (!fileExists(dllPath)) {
      console.warn(`⚠ ${dllName} no encontrada en: ${dllPath}`);
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
    console.warn(`⚠ Error al cargar ${dllName}:`, error.message);
    console.warn(`  Ruta intentada: ${dllPath}`);
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
