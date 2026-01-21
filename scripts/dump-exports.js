#!/usr/bin/env node
/*
  Dump simple de exports PE (Windows DLL/EXE) sin dumpbin.
  Además intenta inferir bytes de argumentos stdcall buscando "ret N" (C2 imm16).

  Uso:
    node scripts/dump-exports.js "C:\\ruta\\FTRAPI.dll"

  Full:
    set DUMP_EXPORTS_FULL=1
*/

import fs from "fs";
import path from "path";

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function readU16(buf, off) {
  if (off < 0 || off + 2 > buf.length) return null;
  return buf.readUInt16LE(off);
}

function readU32(buf, off) {
  if (off < 0 || off + 4 > buf.length) return null;
  return buf.readUInt32LE(off);
}

function readCString(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end += 1;
  if (end >= buf.length) return null;
  return buf.slice(off, end).toString("ascii");
}

function rvaToFileOffset(buf, peOffset, rva) {
  const numberOfSections = readU16(buf, peOffset + 6);
  const sizeOfOptionalHeader = readU16(buf, peOffset + 20);
  if (numberOfSections == null || sizeOfOptionalHeader == null) return null;

  const sectionTable = peOffset + 24 + sizeOfOptionalHeader;
  for (let i = 0; i < numberOfSections; i += 1) {
    const secOff = sectionTable + i * 40;
    const virtualSize = readU32(buf, secOff + 8);
    const virtualAddress = readU32(buf, secOff + 12);
    const sizeOfRawData = readU32(buf, secOff + 16);
    const pointerToRawData = readU32(buf, secOff + 20);
    if (
      virtualAddress == null ||
      virtualSize == null ||
      sizeOfRawData == null ||
      pointerToRawData == null
    ) {
      return null;
    }
    const maxSize = Math.max(virtualSize, sizeOfRawData);
    if (rva >= virtualAddress && rva < virtualAddress + maxSize) {
      return pointerToRawData + (rva - virtualAddress);
    }
  }
  return null;
}

function getPeInfo(buf) {
  if (buf.length < 0x40) return { ok: false, error: "Archivo muy pequeño" };
  if (buf[0] !== 0x4d || buf[1] !== 0x5a)
    return { ok: false, error: "No es PE (sin MZ)" };

  const e_lfanew = readU32(buf, 0x3c);
  if (e_lfanew == null) return { ok: false, error: "No e_lfanew" };
  if (e_lfanew + 4 > buf.length)
    return { ok: false, error: "PE offset fuera de rango" };

  if (
    buf[e_lfanew] !== 0x50 ||
    buf[e_lfanew + 1] !== 0x45 ||
    buf[e_lfanew + 2] !== 0x00 ||
    buf[e_lfanew + 3] !== 0x00
  ) {
    return { ok: false, error: "No es PE (sin firma PE\\0\\0)" };
  }

  const sizeOfOptionalHeader = readU16(buf, e_lfanew + 20);
  if (sizeOfOptionalHeader == null)
    return { ok: false, error: "Header PE incompleto" };

  const optOff = e_lfanew + 24;
  const magic = readU16(buf, optOff);
  if (magic == null) return { ok: false, error: "Optional header incompleto" };

  const arch = magic === 0x10b ? "x86" : magic === 0x20b ? "x64" : "unknown";
  const dataDirBase = magic === 0x10b ? optOff + 96 : optOff + 112;
  const exportRva = readU32(buf, dataDirBase + 0) || 0;
  const exportSize = readU32(buf, dataDirBase + 4) || 0;

  return { ok: true, peOffset: e_lfanew, arch, exportRva, exportSize };
}

function guessStdcallArgBytesAt(buf, fileOffset, maxScan = 2048) {
  if (fileOffset == null) return null;
  if (fileOffset < 0 || fileOffset >= buf.length) return null;
  const end = Math.min(buf.length, fileOffset + maxScan);
  let last = null;
  for (let i = fileOffset; i + 2 < end; i += 1) {
    if (buf[i] === 0xc2) {
      last = buf.readUInt16LE(i + 1);
    }
  }
  return last;
}

function guessStdcallArgBytesInRange(buf, startOff, endOff) {
  if (startOff == null || endOff == null) return null;
  if (startOff < 0 || startOff >= buf.length) return null;
  const end = Math.min(buf.length, Math.max(startOff, endOff));
  let last = null;
  // Busca el último "ret imm16" (C2 xx xx) dentro del rango.
  for (let i = startOff; i + 2 < end; i += 1) {
    if (buf[i] === 0xc2) {
      last = buf.readUInt16LE(i + 1);
    }
  }
  // Filtra valores absurdos (falsos positivos). En x86 stdcall suele ser múltiplo de 4.
  if (last == null) return null;
  if (last > 128) return null;
  if (last % 4 !== 0) return null;
  return last;
}

function listExports(buf) {
  const info = getPeInfo(buf);
  if (!info.ok) return { ok: false, error: info.error };
  if (!info.exportRva) return { ok: true, arch: info.arch, exports: [] };

  const exportDirOff = rvaToFileOffset(buf, info.peOffset, info.exportRva);
  if (exportDirOff == null)
    return { ok: false, error: "No se pudo mapear export directory RVA" };

  const numberOfFunctions = readU32(buf, exportDirOff + 20);
  const numberOfNames = readU32(buf, exportDirOff + 24);
  const addressOfFunctionsRva = readU32(buf, exportDirOff + 28);
  const addressOfNamesRva = readU32(buf, exportDirOff + 32);
  const addressOfNameOrdinalsRva = readU32(buf, exportDirOff + 36);

  if (
    numberOfFunctions == null ||
    numberOfNames == null ||
    addressOfFunctionsRva == null ||
    addressOfNamesRva == null ||
    addressOfNameOrdinalsRva == null
  ) {
    return { ok: false, error: "Export directory incompleto" };
  }

  const namesOff = rvaToFileOffset(buf, info.peOffset, addressOfNamesRva);
  const ordOff = rvaToFileOffset(buf, info.peOffset, addressOfNameOrdinalsRva);
  const funcsOff = rvaToFileOffset(buf, info.peOffset, addressOfFunctionsRva);

  if (namesOff == null) return { ok: false, error: "No AddressOfNames" };
  if (ordOff == null) return { ok: false, error: "No AddressOfNameOrdinals" };
  if (funcsOff == null) return { ok: false, error: "No AddressOfFunctions" };

  // Lista de RVAs de todas las funciones exportadas (por índice de ordinal)
  const allFuncRvas = [];
  for (let i = 0; i < numberOfFunctions; i += 1) {
    const rva = readU32(buf, funcsOff + i * 4);
    if (typeof rva === "number" && rva > 0) allFuncRvas.push(rva);
  }
  // Ordena y de-dup
  allFuncRvas.sort((a, b) => a - b);
  const uniqueFuncRvas = [];
  for (const rva of allFuncRvas) {
    if (uniqueFuncRvas.length === 0 || uniqueFuncRvas[uniqueFuncRvas.length - 1] !== rva) {
      uniqueFuncRvas.push(rva);
    }
  }

  const exports = [];
  for (let i = 0; i < numberOfNames; i += 1) {
    const nameRva = readU32(buf, namesOff + i * 4);
    if (nameRva == null) continue;
    const nameOff = rvaToFileOffset(buf, info.peOffset, nameRva);
    if (nameOff == null) continue;
    const name = readCString(buf, nameOff);
    if (!name) continue;

    const ordinalIndex = readU16(buf, ordOff + i * 2);
    const funcRva =
      ordinalIndex != null && ordinalIndex < numberOfFunctions
        ? readU32(buf, funcsOff + ordinalIndex * 4)
        : null;
    const funcOff =
      funcRva != null ? rvaToFileOffset(buf, info.peOffset, funcRva) : null;

    // Rango aproximado de la función: hasta el siguiente RVA exportado.
    let nextRva = null;
    if (funcRva != null) {
      // búsqueda lineal es OK (solo 31 exports en este caso)
      for (const candidate of uniqueFuncRvas) {
        if (candidate > funcRva) {
          nextRva = candidate;
          break;
        }
      }
    }
    const nextOff =
      nextRva != null ? rvaToFileOffset(buf, info.peOffset, nextRva) : null;
    const rangeEndOff =
      nextOff != null && funcOff != null && nextOff > funcOff
        ? nextOff
        : funcOff != null
          ? Math.min(buf.length, funcOff + 4096)
          : null;

    exports.push({
      name,
      ordinalIndex: ordinalIndex ?? null,
      rva: funcRva ?? null,
      fileOffset: funcOff ?? null,
      stdcallArgBytes: guessStdcallArgBytesInRange(buf, funcOff, rangeEndOff),
    });
  }

  exports.sort((a, b) => a.name.localeCompare(b.name));
  return {
    ok: true,
    arch: info.arch,
    exports,
  };
}

const dllPath = process.argv[2];
if (!dllPath) {
  die('Uso: node scripts/dump-exports.js "C:\\ruta\\archivo.dll"');
}

let data;
try {
  data = fs.readFileSync(dllPath);
} catch (e) {
  die(`No se pudo leer: ${dllPath} (${e?.message || String(e)})`);
}

const res = listExports(data);
if (!res.ok) {
  die(`Error leyendo exports: ${res.error}`);
}

const interesting = [
  "FTREnroll",
  "FTREnrollX",
  "Enroll3S",
  "FTRCaptureFrame",
  "FTRSetBaseTemplate",
  "FTRIdentify",
  "FTRIdentifyN",
  "FTRVerify",
  "FTRVerifyN",
  "FTRInitialize",
  "FTRTerminate",
  "FTRSetParam",
  "FTRGetParam",
  "FTRGetOptConvParam",
  "MTInitialize",
  "MTTerminate",
  "MTEnrollX",
  "MTCaptureFrame",
];

const foundInteresting = res.exports
  .filter((e) => interesting.some((k) => e.name.toLowerCase() === k.toLowerCase()))
  .map((e) => ({
    name: e.name,
    stdcallArgBytes: e.stdcallArgBytes,
    rva: e.rva,
  }));

console.log(
  JSON.stringify(
    {
      file: path.resolve(dllPath),
      arch: res.arch,
      exportCount: res.exports.length,
      interesting: foundInteresting,
    },
    null,
    2,
  ),
);

if (String(process.env.DUMP_EXPORTS_FULL || "").trim() === "1") {
  for (const e of res.exports) {
    const bytes = e.stdcallArgBytes == null ? "?" : String(e.stdcallArgBytes);
    console.log(`${e.name}\tstdcallArgBytes=${bytes}`);
  }
}
