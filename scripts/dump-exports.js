#!/usr/bin/env node
/*
  Dump simple de exports PE (Windows DLL/EXE) sin dumpbin.
  Uso:
    node scripts/dump-exports.js "C:\\ruta\\FTRAPI.dll"
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
    const virtualAddress = readU32(buf, secOff + 12);
    const sizeOfRawData = readU32(buf, secOff + 16);
    const pointerToRawData = readU32(buf, secOff + 20);
    const virtualSize = readU32(buf, secOff + 8);

    if (
      virtualAddress == null ||
      sizeOfRawData == null ||
      pointerToRawData == null ||
      virtualSize == null
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

  const machine = readU16(buf, e_lfanew + 4);
  const sizeOfOptionalHeader = readU16(buf, e_lfanew + 20);
  if (machine == null || sizeOfOptionalHeader == null)
    return { ok: false, error: "Header PE incompleto" };

  const optOff = e_lfanew + 24;
  const magic = readU16(buf, optOff);
  if (magic == null) return { ok: false, error: "Optional header incompleto" };

  // 0x10b = PE32, 0x20b = PE32+
  const arch = magic === 0x10b ? "x86" : magic === 0x20b ? "x64" : "unknown";

  // DataDirectory[0] = Export Table. Offset depende del tipo.
  // Para PE32, DataDirectory inicia en optOff+96
  // Para PE32+, inicia en optOff+112
  const dataDirBase = magic === 0x10b ? optOff + 96 : optOff + 112;
  const exportRva = readU32(buf, dataDirBase + 0);
  const exportSize = readU32(buf, dataDirBase + 4);

  return {
    ok: true,
    peOffset: e_lfanew,
    arch,
    machine,
    exportRva: exportRva || 0,
    exportSize: exportSize || 0,
  };
}

function listExports(buf) {
  const info = getPeInfo(buf);
  if (!info.ok) return { ok: false, error: info.error };
  if (!info.exportRva) {
    return { ok: true, arch: info.arch, exports: [] };
  }

  const exportDirOff = rvaToFileOffset(buf, info.peOffset, info.exportRva);
  if (exportDirOff == null) {
    return { ok: false, error: "No se pudo mapear export directory RVA" };
  }

  // IMAGE_EXPORT_DIRECTORY
  const numberOfNames = readU32(buf, exportDirOff + 24);
  const addressOfNamesRva = readU32(buf, exportDirOff + 32);
  if (numberOfNames == null || addressOfNamesRva == null) {
    return { ok: false, error: "Export directory corrupto" };
  }

  const namesOff = rvaToFileOffset(buf, info.peOffset, addressOfNamesRva);
  if (namesOff == null) {
    return { ok: false, error: "No se pudo mapear AddressOfNames" };
  }

  const exports = [];
  for (let i = 0; i < numberOfNames; i += 1) {
    const nameRva = readU32(buf, namesOff + i * 4);
    if (nameRva == null) continue;
    const nameOff = rvaToFileOffset(buf, info.peOffset, nameRva);
    if (nameOff == null) continue;
    const name = readCString(buf, nameOff);
    if (name) exports.push(name);
  }

  exports.sort((a, b) => a.localeCompare(b));
  return { ok: true, arch: info.arch, exports };
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
  "ftrScanOpenDevice",
  "FTRScanOpenDevice",
  "ftrScanCloseDevice",
  "FTRScanCloseDevice",
];

const foundInteresting = res.exports.filter((n) =>
  interesting.some((k) => n.toLowerCase() === k.toLowerCase()),
);

console.log(JSON.stringify({
  file: path.resolve(dllPath),
  arch: res.arch,
  exportCount: res.exports.length,
  interesting: foundInteresting,
}, null, 2));

// Imprime lista completa si se pide
if (String(process.env.DUMP_EXPORTS_FULL || "").trim() === "1") {
  for (const name of res.exports) console.log(name);
}
