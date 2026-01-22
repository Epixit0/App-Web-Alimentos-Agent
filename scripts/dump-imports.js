#!/usr/bin/env node
/*
  Dump PE imports (DLL -> functions) without dumpbin.
  Usage:
    node scripts/dump-imports.js "C:\\Path\\To\\WorkedEx.exe"
*/

import fs from "fs";
import path from "path";

function readU16(buf, off) {
  if (off < 0 || off + 2 > buf.length) return null;
  return buf.readUInt16LE(off);
}

function readU32(buf, off) {
  if (off < 0 || off + 4 > buf.length) return null;
  return buf.readUInt32LE(off);
}

function readAsciiZ(buf, off, max = 4096) {
  if (off == null || off < 0 || off >= buf.length) return null;
  const end = Math.min(buf.length, off + max);
  let i = off;
  while (i < end && buf[i] !== 0x00) i += 1;
  return buf.toString("ascii", off, i);
}

function getPeInfo(buf) {
  if (buf.length < 0x40) return { ok: false, error: "Archivo muy pequeño" };
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) {
    return { ok: false, error: "No es PE (sin MZ)" };
  }
  const peOffset = readU32(buf, 0x3c);
  if (peOffset == null || peOffset + 4 > buf.length) {
    return { ok: false, error: "PE offset fuera de rango" };
  }
  if (
    buf[peOffset] !== 0x50 ||
    buf[peOffset + 1] !== 0x45 ||
    buf[peOffset + 2] !== 0x00 ||
    buf[peOffset + 3] !== 0x00
  ) {
    return { ok: false, error: "No es PE (sin firma PE)" };
  }

  const machine = readU16(buf, peOffset + 4);
  const numberOfSections = readU16(buf, peOffset + 6);
  const sizeOfOptionalHeader = readU16(buf, peOffset + 20);

  const optOffset = peOffset + 24;
  const magic = readU16(buf, optOffset);
  const isPE32 = magic === 0x10b;
  const isPE32Plus = magic === 0x20b;
  if (!isPE32 && !isPE32Plus) {
    return { ok: false, error: `OptionalHeader magic desconocido: ${magic}` };
  }

  const arch = machine === 0x014c ? "x86" : machine === 0x8664 ? "x64" : null;

  const dataDirOffset = optOffset + (isPE32Plus ? 112 : 96);
  const importTableRva = readU32(buf, dataDirOffset + 8); // directory[1]
  const importTableSize = readU32(buf, dataDirOffset + 12);

  const sectionTableOffset = optOffset + sizeOfOptionalHeader;

  return {
    ok: true,
    arch,
    peOffset,
    numberOfSections,
    sectionTableOffset,
    importTableRva,
    importTableSize,
  };
}

function getSections(buf, info) {
  const sections = [];
  const base = info.sectionTableOffset;
  for (let i = 0; i < info.numberOfSections; i += 1) {
    const off = base + i * 40;
    if (off + 40 > buf.length) break;
    const name = buf.toString("ascii", off, off + 8).replace(/\0+$/, "");
    const virtualSize = readU32(buf, off + 8) ?? 0;
    const virtualAddress = readU32(buf, off + 12) ?? 0;
    const sizeOfRawData = readU32(buf, off + 16) ?? 0;
    const pointerToRawData = readU32(buf, off + 20) ?? 0;
    sections.push({
      name,
      virtualSize,
      virtualAddress,
      sizeOfRawData,
      pointerToRawData,
    });
  }
  return sections;
}

function rvaToFileOffset(sections, rva) {
  for (const s of sections) {
    const start = s.virtualAddress;
    const end = start + Math.max(s.virtualSize, s.sizeOfRawData);
    if (rva >= start && rva < end) {
      return s.pointerToRawData + (rva - start);
    }
  }
  return null;
}

function parseImports(buf) {
  const info = getPeInfo(buf);
  if (!info.ok) return { ok: false, error: info.error };

  const sections = getSections(buf, info);
  if (!info.importTableRva) {
    return { ok: true, arch: info.arch, imports: [] };
  }

  const importDirOff = rvaToFileOffset(sections, info.importTableRva);
  if (importDirOff == null) {
    return { ok: false, error: "No se pudo mapear ImportTable RVA" };
  }

  const importsByDll = new Map();

  // IMAGE_IMPORT_DESCRIPTOR: 20 bytes until null descriptor
  for (let i = 0; ; i += 1) {
    const descOff = importDirOff + i * 20;
    if (descOff + 20 > buf.length) break;

    const originalFirstThunkRva = readU32(buf, descOff + 0) ?? 0;
    const timeDateStamp = readU32(buf, descOff + 4) ?? 0;
    const forwarderChain = readU32(buf, descOff + 8) ?? 0;
    const nameRva = readU32(buf, descOff + 12) ?? 0;
    const firstThunkRva = readU32(buf, descOff + 16) ?? 0;

    if (
      originalFirstThunkRva === 0 &&
      timeDateStamp === 0 &&
      forwarderChain === 0 &&
      nameRva === 0 &&
      firstThunkRva === 0
    ) {
      break;
    }

    const nameOff = rvaToFileOffset(sections, nameRva);
    const dllName = nameOff != null ? readAsciiZ(buf, nameOff, 512) : null;
    const dllKey = (dllName || "<unknown>").toLowerCase();

    const thunkRva = originalFirstThunkRva || firstThunkRva;
    const thunkOff = rvaToFileOffset(sections, thunkRva);
    if (thunkOff == null) continue;

    const funcs = [];
    // x86 thunk is 4 bytes; for PE32+ is 8 bytes. We only need x86 here.
    for (let j = 0; ; j += 1) {
      const entryOff = thunkOff + j * 4;
      const entry = readU32(buf, entryOff);
      if (entry == null || entry === 0) break;

      // Ordinal import if high bit set
      const isOrdinal = (entry & 0x80000000) !== 0;
      if (isOrdinal) {
        funcs.push({ ordinal: entry & 0xffff, name: null });
        continue;
      }

      const hintNameRva = entry;
      const hintNameOff = rvaToFileOffset(sections, hintNameRva);
      if (hintNameOff == null) continue;
      const name = readAsciiZ(buf, hintNameOff + 2, 512); // skip hint
      funcs.push({ ordinal: null, name });
    }

    if (!importsByDll.has(dllKey)) {
      importsByDll.set(dllKey, { dll: dllName || dllKey, functions: [] });
    }

    const bucket = importsByDll.get(dllKey);
    bucket.functions.push(...funcs);
  }

  const imports = Array.from(importsByDll.values()).map((x) => {
    const names = x.functions
      .map((f) => (f.name ? f.name : `#${f.ordinal}`))
      .filter(Boolean);
    names.sort();
    // de-dup
    const uniq = [];
    for (const n of names) {
      if (uniq.length === 0 || uniq[uniq.length - 1] !== n) uniq.push(n);
    }
    return { dll: x.dll, functions: uniq };
  });

  imports.sort((a, b) => a.dll.localeCompare(b.dll));

  return { ok: true, arch: info.arch, imports };
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Uso: node scripts/dump-imports.js <archivo.exe|dll>");
    process.exit(2);
  }

  const full = path.resolve(file);
  const buf = fs.readFileSync(full);
  const result = parseImports(buf);
  if (!result.ok) {
    console.error(`[ERROR] ${result.error}`);
    process.exit(1);
  }

  const simplified = {
    file,
    arch: result.arch,
    imports: result.imports,
  };

  console.log(JSON.stringify(simplified, null, 2));

  // También imprime un resumen humano
  for (const imp of result.imports) {
    const interesting = imp.functions.filter((n) => /ftr|scan|mt/i.test(n));
    if (interesting.length) {
      console.log(`\n${imp.dll}`);
      for (const n of interesting) console.log(`  ${n}`);
    }
  }
}

main();
