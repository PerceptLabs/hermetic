// @hermetic/pm — Pure JS tar parser
// Implements POSIX.1-2001 tar format parsing

import type { TarEntry } from "./types.js";

function readString(buf: Uint8Array, offset: number, length: number): string {
  const end = buf.indexOf(0, offset);
  const actualEnd = end === -1 || end > offset + length ? offset + length : end;
  return new TextDecoder().decode(buf.subarray(offset, actualEnd));
}

function readOctal(buf: Uint8Array, offset: number, length: number): number {
  const str = readString(buf, offset, length).trim();
  return parseInt(str, 8) || 0;
}

/**
 * Parse a tar archive and yield entries.
 * Strips "package/" prefix from names (npm tarballs always have this).
 */
export function* parseTar(data: Uint8Array): Generator<TarEntry> {
  let offset = 0;
  while (offset < data.length - 512) {
    const header = data.subarray(offset, offset + 512);

    // Empty block = end of archive
    if (header.every((b) => b === 0)) break;

    const name = readString(header, 0, 100);
    const mode = readOctal(header, 100, 8);
    const size = readOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156]);

    // Check for UStar prefix (bytes 345-500)
    const prefix = readString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;

    offset += 512; // Past header

    // File content follows header, padded to 512-byte boundary
    const content = data.slice(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    // Strip "package/" prefix (npm tarballs always have this)
    const cleanName = fullName.replace(/^package\//, "");
    if (!cleanName) continue;

    if (typeFlag === "0" || typeFlag === "\0") {
      yield { name: cleanName, mode, size, type: "file", content: new Uint8Array(content) };
    } else if (typeFlag === "5") {
      yield { name: cleanName, mode, size, type: "directory", content: new Uint8Array(0) };
    }
  }
}

/**
 * Concatenate multiple Uint8Arrays into one.
 */
export function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
