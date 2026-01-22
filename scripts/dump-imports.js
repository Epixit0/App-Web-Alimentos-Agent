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

  const imageBase = isPE32Plus
    ? Number(buf.readBigUInt64LE(optOffset + 24))
    : readU32(buf, optOffset + 28);

  const dataDirOffset = optOffset + (isPE32Plus ? 112 : 96);
  const importTableRva = readU32(buf, dataDirOffset + 8); // directory[1]
  const importTableSize = readU32(buf, dataDirOffset + 12);

  const delayImportRva = readU32(buf, dataDirOffset + 13 * 8);
  const delayImportSize = readU32(buf, dataDirOffset + 13 * 8 + 4);

  const sectionTableOffset = optOffset + sizeOfOptionalHeader;

  return {
    ok: true,
    arch,
    peOffset,
    numberOfSections,
    sectionTableOffset,
    importTableRva,
    importTableSize,
    delayImportRva,
    delayImportSize,
    imageBase: typeof imageBase === "number" ? imageBase : null,
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

function parseExportOrdinalMap(buf) {
  const info = getPeInfo(buf);
  if (!info.ok) return { ok: false, error: info.error };
  const sections = getSections(buf, info);

  const peOffset = info.peOffset;
  const optOffset = peOffset + 24;
  const magic = readU16(buf, optOffset);
  const isPE32Plus = magic === 0x20b;
  const dataDirOffset = optOffset + (isPE32Plus ? 112 : 96);
  const exportRva = readU32(buf, dataDirOffset + 0);
  if (!exportRva) return { ok: true, arch: info.arch, ordinalMap: new Map() };

  const exportOff = rvaToFileOffset(sections, exportRva);
  if (exportOff == null) {
    return { ok: false, error: "No se pudo mapear ExportTable RVA" };
  }

  // IMAGE_EXPORT_DIRECTORY
  const ordinalBase = readU32(buf, exportOff + 16) ?? 0;
  const numberOfFunctions = readU32(buf, exportOff + 20) ?? 0;
  const numberOfNames = readU32(buf, exportOff + 24) ?? 0;
  const addressOfFunctionsRva = readU32(buf, exportOff + 28) ?? 0;
  const addressOfNamesRva = readU32(buf, exportOff + 32) ?? 0;
  const addressOfNameOrdinalsRva = readU32(buf, exportOff + 36) ?? 0;

  const funcsOff = rvaToFileOffset(sections, addressOfFunctionsRva);
  const namesOff = rvaToFileOffset(sections, addressOfNamesRva);
  const ordOff = rvaToFileOffset(sections, addressOfNameOrdinalsRva);
  if (funcsOff == null || namesOff == null || ordOff == null) {
    return { ok: false, error: "Tablas de export inválidas" };
  }

  // Prellenar: ordinal -> null
  const ordinalMap = new Map();
  for (let i = 0; i < numberOfFunctions; i += 1) {
    ordinalMap.set(ordinalBase + i, null);
  }

  // Mapear nombres a ordinales
  for (let i = 0; i < numberOfNames; i += 1) {
    const nameRva = readU32(buf, namesOff + i * 4);
    const nameOff = nameRva != null ? rvaToFileOffset(sections, nameRva) : null;
    const name = nameOff != null ? readAsciiZ(buf, nameOff, 1024) : null;

    const ordIndex = readU16(buf, ordOff + i * 2);
    if (ordIndex == null) continue;
    const ordinal = ordinalBase + ordIndex;
    if (name) ordinalMap.set(ordinal, name);
  }

  return { ok: true, arch: info.arch, ordinalMap };
}

function tryResolveImportsByOrdinal(imports, inputFilePath) {
  const baseDir = path.dirname(path.resolve(inputFilePath));
  const resolved = [];

  for (const imp of imports) {
    const hasOrdinal = Array.isArray(imp.functions)
      ? imp.functions.some((f) => typeof f === "string" && f.startsWith("#"))
      : false;
    if (!hasOrdinal) {
      resolved.push({ ...imp, resolvedFunctions: null });
      continue;
    }

    const dllNameRaw = String(imp.dll || "");
    const dllName = dllNameRaw.replace(/\s*\(delay\)\s*$/i, "");
    const candidate = path.join(baseDir, dllName);
    if (!fs.existsSync(candidate)) {
      resolved.push({ ...imp, resolvedFunctions: null });
      continue;
    }

    let dllBuf;
    try {
      dllBuf = fs.readFileSync(candidate);
    } catch {
      resolved.push({ ...imp, resolvedFunctions: null });
      continue;
    }

    const mapRes = parseExportOrdinalMap(dllBuf);
    if (!mapRes.ok) {
      resolved.push({ ...imp, resolvedFunctions: null });
      continue;
    }

    const ordinalMap = mapRes.ordinalMap;
    const resolvedFunctions = imp.functions.map((f) => {
      if (typeof f !== "string" || !f.startsWith("#")) return f;
      const n = Number(f.slice(1));
      if (!Number.isFinite(n)) return f;
      const name = ordinalMap.get(n);
      return name ? `${name} (${f})` : f;
    });

    resolved.push({ ...imp, resolvedFunctions });
  }

  return resolved;
}

function parseImports(buf) {
  const info = getPeInfo(buf);
  if (!info.ok) return { ok: false, error: info.error };

  const sections = getSections(buf, info);

  const importsByDll = new Map();

  function addImport(dllName, funcNames) {
    const dllKey = String(dllName || "<unknown>").toLowerCase();
    if (!importsByDll.has(dllKey)) {
      importsByDll.set(dllKey, { dll: dllName || dllKey, functions: [] });
    }
    const bucket = importsByDll.get(dllKey);
    bucket.functions.push(...funcNames);
  }

  function parseThunkList(thunkOff, ptrSize, isPe32Plus) {
    const funcs = [];
    const step = ptrSize;
    for (let j = 0; ; j += 1) {
      const entryOff = thunkOff + j * step;
      if (entryOff + step > buf.length) break;
      let entry = null;
      if (isPe32Plus) {
        try {
          const v = buf.readBigUInt64LE(entryOff);
          if (v === 0n) break;
          entry = v;
        } catch {
          break;
        }
      } else {
        const v = readU32(buf, entryOff);
        if (v == null || v === 0) break;
        entry = v;
      }

      if (!isPe32Plus) {
        const isOrdinal = (entry & 0x80000000) !== 0;
        if (isOrdinal) {
          funcs.push(`#${entry & 0xffff}`);
          continue;
        }
        const hintNameRva = entry;
        const hintNameOff = rvaToFileOffset(sections, hintNameRva);
        if (hintNameOff == null) continue;
        const name = readAsciiZ(buf, hintNameOff + 2, 512); // skip hint
        if (name) funcs.push(name);
        continue;
      }

      // PE32+: ordinal import if high bit set
      const isOrdinal = (entry & 0x8000000000000000n) !== 0n;
      if (isOrdinal) {
        funcs.push(`#${Number(entry & 0xffffn)}`);
        continue;
      }
      const hintNameRva = Number(entry);
      const hintNameOff = rvaToFileOffset(sections, hintNameRva);
      if (hintNameOff == null) continue;
      const name = readAsciiZ(buf, hintNameOff + 2, 512);
      if (name) funcs.push(name);
    }
    return funcs;
  }

  // ---------- Normal import table ----------
  if (info.importTableRva) {
    const importDirOff = rvaToFileOffset(sections, info.importTableRva);
    if (importDirOff == null) {
      return { ok: false, error: "No se pudo mapear ImportTable RVA" };
    }

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

      const thunkRva = originalFirstThunkRva || firstThunkRva;
      const thunkOff = rvaToFileOffset(sections, thunkRva);
      if (thunkOff == null) continue;

      const funcs = parseThunkList(thunkOff, 4, false);
      addImport(dllName, funcs);
    }
  }

  // ---------- Delay import table ----------
  // directory[13] IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT
  if (info.delayImportRva) {
    const delayOff = rvaToFileOffset(sections, info.delayImportRva);
    if (delayOff != null) {
      // IMAGE_DELAYLOAD_DESCRIPTOR: 32 bytes
      for (let i = 0; ; i += 1) {
        const descOff = delayOff + i * 32;
        if (descOff + 32 > buf.length) break;

        const grAttrs = readU32(buf, descOff + 0) ?? 0;
        const szName = readU32(buf, descOff + 4) ?? 0;
        const pIAT = readU32(buf, descOff + 12) ?? 0;
        const pINT = readU32(buf, descOff + 16) ?? 0;
        const pBoundIAT = readU32(buf, descOff + 20) ?? 0;
        const pUnloadIAT = readU32(buf, descOff + 24) ?? 0;
        const dwTimeStamp = readU32(buf, descOff + 28) ?? 0;

        if (
          grAttrs === 0 &&
          szName === 0 &&
          pIAT === 0 &&
          pINT === 0 &&
          pBoundIAT === 0 &&
          pUnloadIAT === 0 &&
          dwTimeStamp === 0
        ) {
          break;
        }

        // If grAttrs bit0 = 1 => RVAs, else VAs.
        const isRva = (grAttrs & 1) === 1;
        const nameRva = isRva
          ? szName
          : info.imageBase != null
            ? szName - info.imageBase
            : szName;
        const nameOff = rvaToFileOffset(sections, nameRva);
        const dllName = nameOff != null ? readAsciiZ(buf, nameOff, 512) : null;

        const intRva = isRva
          ? pINT
          : info.imageBase != null
            ? pINT - info.imageBase
            : pINT;
        const intOff = rvaToFileOffset(sections, intRva);
        if (intOff != null) {
          const funcs = parseThunkList(intOff, 4, false);
          addImport(
            dllName ? `${dllName} (delay)` : "<unknown> (delay)",
            funcs,
          );
        } else {
          addImport(dllName ? `${dllName} (delay)` : "<unknown> (delay)", []);
        }
      }
    }
  }

  const imports = Array.from(importsByDll.values()).map((x) => {
    const names = x.functions.filter(Boolean);
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

  const importsResolved = tryResolveImportsByOrdinal(result.imports, full);

  const simplified = {
    file,
    arch: result.arch,
    imports: importsResolved,
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
