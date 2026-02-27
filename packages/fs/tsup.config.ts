import { defineConfig } from "tsup";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read the OPFS worker source and inline it as a string constant
const rawImportPlugin = {
  name: "raw-import",
  setup(build: any) {
    build.onResolve({ filter: /\?raw$/ }, (args: any) => ({
      path: resolve(dirname(args.importer), args.path.replace(/\?raw$/, "")),
      namespace: "raw",
    }));
    build.onLoad({ filter: /.*/, namespace: "raw" }, (args: any) => ({
      contents: `export default ${JSON.stringify(readFileSync(args.path, "utf-8"))}`,
      loader: "ts",
    }));
  },
};

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  esbuildPlugins: [rawImportPlugin],
});
