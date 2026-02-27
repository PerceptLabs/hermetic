// @hermetic/core — Path utilities and helpers
// Pure functions, no Node.js imports, POSIX semantics only

/**
 * POSIX path normalization.
 * - Resolves `.` and `..`
 * - Removes double slashes
 * - Removes trailing slashes (except root)
 * - Always starts with `/`
 */
export function normalizePath(path: string): string {
  if (path === "") return "/";

  const isAbs = path.charCodeAt(0) === 47; // '/'
  const segments = path.split("/");
  const result: string[] = [];

  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (result.length > 0 && result[result.length - 1] !== "..") {
        result.pop();
      } else if (!isAbs) {
        result.push("..");
      }
    } else {
      result.push(seg);
    }
  }

  const normalized = result.join("/");
  if (isAbs) return "/" + normalized;
  return normalized || ".";
}

export function joinPath(...segments: string[]): string {
  if (segments.length === 0) return ".";
  return normalizePath(segments.join("/"));
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) return ".";
  if (lastSlash === 0) return "/";
  return normalized.slice(0, lastSlash);
}

export function basename(path: string, ext?: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const lastSlash = normalized.lastIndexOf("/");
  const base = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
  if (ext && base.endsWith(ext)) {
    return base.slice(0, -ext.length);
  }
  return base;
}

export function extname(path: string): string {
  const base = basename(path);
  const dotIndex = base.lastIndexOf(".");
  if (dotIndex <= 0) return "";
  return base.slice(dotIndex);
}

export function isAbsolute(path: string): boolean {
  return path.length > 0 && path.charCodeAt(0) === 47; // '/'
}

/**
 * Resolve a path relative to a working directory.
 * resolvePath("/home", "./foo/bar") => "/home/foo/bar"
 * resolvePath("/home", "/absolute") => "/absolute"
 */
export function resolvePath(cwd: string, path: string): string {
  if (isAbsolute(path)) return normalizePath(path);
  return normalizePath(cwd + "/" + path);
}

/**
 * MIME type guess from file extension.
 * Used by HermeticNet to set Content-Type headers.
 */
export function guessMimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".cjs": "application/javascript",
    ".json": "application/json",
    ".ts": "application/typescript",
    ".tsx": "application/typescript",
    ".jsx": "application/javascript",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".wasm": "application/wasm",
    ".map": "application/json",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".xml": "application/xml",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".toml": "text/plain",
  };
  return mimeMap[ext] ?? "application/octet-stream";
}
