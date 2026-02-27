// @hermetic/shell — Glob expansion
//
// Expands glob patterns (*, ?, **) against HermeticFS.

import type { HermeticFS } from "@hermetic/fs";
import { normalizePath, joinPath } from "@hermetic/core";

/**
 * Expand glob patterns against HermeticFS.
 * Supports: * (any chars), ? (single char), ** (recursive)
 */
export async function expandGlob(
  pattern: string,
  cwd: string,
  fs: HermeticFS,
): Promise<string[]> {
  // If no glob characters, return as-is
  if (!/[*?]/.test(pattern)) return [pattern];

  const resolved = pattern.startsWith("/") ? pattern : joinPath(cwd, pattern);
  const normalized = normalizePath(resolved);
  const parts = normalized.split("/").filter(Boolean);

  const results = await matchParts(parts, "/", fs);

  // Return relative paths if pattern was relative
  if (!pattern.startsWith("/")) {
    const prefix = cwd === "/" ? "/" : cwd + "/";
    return results.map((r) => (r.startsWith(prefix) ? r.slice(prefix.length) : r)).sort();
  }

  return results.sort();
}

async function matchParts(
  parts: string[],
  base: string,
  fs: HermeticFS,
): Promise<string[]> {
  if (parts.length === 0) return [base];

  const [current, ...rest] = parts;

  if (current === "**") {
    // Recursive: match current dir + all subdirs
    const results: string[] = [];
    results.push(...(await matchParts(rest, base, fs)));
    try {
      const entries = await fs.readdir(base);
      for (const entry of entries) {
        const full = joinPath(base, entry);
        const stat = await fs.stat(full);
        if (stat.type === "directory") {
          results.push(...(await matchParts(parts, full, fs))); // keep ** for recursion
          results.push(...(await matchParts(rest, full, fs)));   // skip ** for this level
        }
      }
    } catch { /* dir doesn't exist or not readable */ }
    return [...new Set(results)];
  }

  const regex = globPartToRegex(current);
  try {
    const entries = await fs.readdir(base);
    const matches = entries.filter((e) => regex.test(e));

    if (rest.length === 0) {
      return matches.map((m) => joinPath(base, m));
    }

    const results: string[] = [];
    for (const match of matches) {
      const full = joinPath(base, match);
      try {
        const stat = await fs.stat(full);
        if (stat.type === "directory") {
          results.push(...(await matchParts(rest, full, fs)));
        }
      } catch { /* skip */ }
    }
    return results;
  } catch {
    return [];
  }
}

function globPartToRegex(pattern: string): RegExp {
  let regex = "^";
  for (const char of pattern) {
    switch (char) {
      case "*": regex += "[^/]*"; break;
      case "?": regex += "[^/]"; break;
      case ".": regex += "\\."; break;
      default: regex += char;
    }
  }
  regex += "$";
  return new RegExp(regex);
}
