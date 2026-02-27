import { describe, it, expect } from "vitest";
import { parseTar, concatUint8Arrays } from "../src/tar-parser.js";

/**
 * Create a minimal tar archive with one file.
 * This builds a valid POSIX tar from scratch.
 */
function createTestTar(files: Array<{ name: string; content: string }>): Uint8Array {
  const blocks: Uint8Array[] = [];

  for (const file of files) {
    const content = new TextEncoder().encode(file.content);
    const header = new Uint8Array(512);

    // Name (bytes 0-99)
    const nameBytes = new TextEncoder().encode(file.name);
    header.set(nameBytes.subarray(0, 100), 0);

    // Mode (bytes 100-107)
    const modeBytes = new TextEncoder().encode("0000644\0");
    header.set(modeBytes, 100);

    // UID (bytes 108-115)
    header.set(new TextEncoder().encode("0001000\0"), 108);

    // GID (bytes 116-123)
    header.set(new TextEncoder().encode("0001000\0"), 116);

    // Size (bytes 124-135)
    const sizeOctal = content.length.toString(8).padStart(11, "0") + "\0";
    header.set(new TextEncoder().encode(sizeOctal), 124);

    // Mtime (bytes 136-147)
    const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0";
    header.set(new TextEncoder().encode(mtime), 136);

    // Type flag (byte 156): '0' = regular file
    header[156] = 48; // '0'

    // Compute checksum (bytes 148-155)
    // First fill with spaces
    header.set(new TextEncoder().encode("        "), 148);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i];
    const checksumStr = checksum.toString(8).padStart(6, "0") + "\0 ";
    header.set(new TextEncoder().encode(checksumStr), 148);

    blocks.push(header);

    // Content blocks (padded to 512 bytes)
    const paddedSize = Math.ceil(content.length / 512) * 512;
    const contentBlock = new Uint8Array(paddedSize);
    contentBlock.set(content);
    blocks.push(contentBlock);
  }

  // End-of-archive: two 512-byte blocks of zeros
  blocks.push(new Uint8Array(1024));

  return concatUint8Arrays(blocks);
}

describe("parseTar", () => {
  it("parses a tar with one file", () => {
    const tar = createTestTar([{ name: "package/hello.txt", content: "Hello World" }]);
    const entries = [...parseTar(tar)];

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("hello.txt"); // "package/" prefix stripped
    expect(entries[0].type).toBe("file");
    expect(entries[0].size).toBe(11);
    expect(new TextDecoder().decode(entries[0].content)).toBe("Hello World");
  });

  it("parses multiple files", () => {
    const tar = createTestTar([
      { name: "package/a.txt", content: "aaa" },
      { name: "package/b.txt", content: "bbb" },
      { name: "package/sub/c.txt", content: "ccc" },
    ]);
    const entries = [...parseTar(tar)];

    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "b.txt", "sub/c.txt"]);
  });

  it("handles empty archive", () => {
    const tar = new Uint8Array(1024); // Two zero blocks
    const entries = [...parseTar(tar)];
    expect(entries).toHaveLength(0);
  });
});

describe("concatUint8Arrays", () => {
  it("concatenates multiple arrays", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4, 5]);
    const c = new Uint8Array([6]);
    const result = concatUint8Arrays([a, b, c]);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("handles empty input", () => {
    const result = concatUint8Arrays([]);
    expect(result.length).toBe(0);
  });
});
