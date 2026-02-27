// @hermetic/dev — esbuild-wasm build integration
//
// Wraps esbuild-wasm with a custom plugin that resolves imports
// from HermeticFS (relative) and esm.sh (bare specifiers).

import { dirname, extname, resolvePath } from "@hermetic/core";
import type { HermeticFS } from "@hermetic/fs";
import type { BuildResult, BuildMessage } from "./types.js";

// esbuild types (we'll use dynamic import to avoid bundling esbuild)
interface EsbuildPlugin {
  name: string;
  setup(build: any): void;
}

let esbuildModule: any = null;
let initialized = false;

const DEFAULT_ESBUILD_CDN = "https://esm.sh/esbuild-wasm@0.21.5";

async function ensureEsbuild(wasmUrl?: string): Promise<any> {
  if (initialized && esbuildModule) return esbuildModule;
  // Dynamic import of esbuild-wasm from CDN at runtime
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const importFn = new Function("url", "return import(url)") as (url: string) => Promise<any>;
  esbuildModule = await importFn(DEFAULT_ESBUILD_CDN);
  await esbuildModule.initialize({
    wasmURL: wasmUrl ?? `${DEFAULT_ESBUILD_CDN}/esbuild.wasm`,
  });
  initialized = true;
  return esbuildModule;
}

function getLoader(path: string): string {
  const ext = extname(path);
  const loaderMap: Record<string, string> = {
    ".ts": "ts",
    ".tsx": "tsx",
    ".js": "js",
    ".jsx": "jsx",
    ".css": "css",
    ".json": "json",
    ".svg": "text",
    ".html": "text",
  };
  return loaderMap[ext] ?? "text";
}

/**
 * esbuild plugin that resolves from HermeticFS
 */
function hermeticPlugin(fs: HermeticFS): EsbuildPlugin {
  return {
    name: "hermetic-fs",
    setup(build: any) {
      // Resolve bare specifiers to esm.sh CDN
      build.onResolve({ filter: /^[^./]/ }, (args: any) => {
        return { path: `https://esm.sh/${args.path}`, external: true };
      });

      // Resolve relative imports against HermeticFS
      build.onResolve({ filter: /^\./ }, async (args: any) => {
        const dir = args.importer ? dirname(args.importer) : "/";
        let resolved = resolvePath(dir, args.path);

        // Try resolving with extensions if no extension
        if (!extname(resolved)) {
          const extensions = [".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];
          for (const ext of extensions) {
            if (await fs.exists(resolved + ext)) {
              resolved = resolved + ext;
              break;
            }
          }
        }

        return { path: resolved, namespace: "hermetic" };
      });

      // Load files from HermeticFS
      build.onLoad({ filter: /.*/, namespace: "hermetic" }, async (args: any) => {
        try {
          const content = await fs.readFile(args.path, "utf-8");
          return {
            contents: content as string,
            loader: getLoader(args.path),
          };
        } catch (err: any) {
          return {
            errors: [{ text: `Failed to load ${args.path}: ${err.message}` }],
          };
        }
      });
    },
  };
}

/**
 * Build files from HermeticFS using esbuild-wasm.
 */
export async function build(
  fs: HermeticFS,
  entry: string,
  options?: { wasmUrl?: string },
): Promise<BuildResult> {
  const esbuild = await ensureEsbuild(options?.wasmUrl);

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    jsx: "automatic",
    jsxImportSource: "react",
    plugins: [hermeticPlugin(fs)],
    write: false,
    outdir: "/dist",
  });

  const code = result.outputFiles
    ?.filter((f: any) => f.path.endsWith(".js"))
    .map((f: any) => f.text)
    .join("\n") ?? "";

  const css = result.outputFiles
    ?.filter((f: any) => f.path.endsWith(".css"))
    .map((f: any) => f.text)
    .join("\n") ?? undefined;

  const mapErrors = (msgs: any[]): BuildMessage[] =>
    (msgs ?? []).map((m: any) => ({
      text: m.text,
      location: m.location ? {
        file: m.location.file,
        line: m.location.line,
        column: m.location.column,
      } : undefined,
    }));

  return {
    code,
    css,
    errors: mapErrors(result.errors),
    warnings: mapErrors(result.warnings),
  };
}
