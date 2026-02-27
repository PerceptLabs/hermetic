// @hermetic/pm — Tarball fetch + gzip decompress + tar parse

import { dirname, joinPath } from "@hermetic/core";
import type { HermeticFS } from "@hermetic/fs";
import { parseTar, concatUint8Arrays } from "./tar-parser.js";

/**
 * Fetch a tarball, decompress with DecompressionStream, parse tar,
 * and write entries to HermeticFS.
 */
export async function extractPackage(
  tarballUrl: string,
  targetDir: string,
  fs: HermeticFS,
): Promise<void> {
  const response = await fetch(tarballUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch tarball: ${tarballUrl} (${response.status})`);
  }

  // Decompress gzip → tar bytes
  const decompressed = response.body!.pipeThrough(new DecompressionStream("gzip"));
  const reader = decompressed.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const tarData = concatUint8Arrays(chunks);

  // Parse tar and write to FS
  for (const entry of parseTar(tarData)) {
    const fullPath = joinPath(targetDir, entry.name);
    if (entry.type === "directory") {
      await fs.mkdir(fullPath, { recursive: true });
    } else {
      await fs.mkdir(dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, entry.content);
    }
  }
}
