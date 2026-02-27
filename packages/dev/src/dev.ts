// @hermetic/dev — HermeticDev class
//
// Orchestrates the dev server: watches HermeticFS for changes,
// rebuilds with esbuild-wasm, sends HMR updates to preview iframe.

import { DisposableStore, guessMimeType } from "@hermetic/core";
import type { HermeticFS } from "@hermetic/fs";
import type { ServerHandler } from "@hermetic/net";
import { createPreview } from "@hermetic/net";
import type { DevOptions, BuildResult, HermeticDevInterface } from "./types.js";
import type { PreviewHandle } from "@hermetic/net";
import { build } from "./builder.js";
import { createHtmlTemplate } from "./templates/html-template.js";

export class HermeticDev implements HermeticDevInterface {
  private fs: HermeticFS;
  private options: DevOptions;
  private disposables = new DisposableStore();
  private _preview: PreviewHandle | null = null;
  private lastBuild: BuildResult | null = null;
  private unwatchFn?: () => void;

  constructor(options: DevOptions) {
    this.fs = options.fs;
    this.options = options;
  }

  get preview(): PreviewHandle | null {
    return this._preview;
  }

  async start(): Promise<void> {
    // Build the project
    const entry = this.options.entry ?? await this.findEntry();
    this.lastBuild = await build(this.fs, entry, {
      wasmUrl: this.options.esbuildWasmUrl,
    });

    // Create request handler that serves built files
    const handler = this.createHandler();

    // Create preview iframe
    this._preview = await createPreview({
      handler,
      container: this.options.container,
      html: this.generatePreviewHtml(),
    });

    // Watch for file changes and trigger rebuilds
    if (this.options.hmr !== false) {
      this.unwatchFn = this.fs.watch("/", async (event) => {
        try {
          const result = await this.rebuild();
          if (result.errors.length === 0 && this._preview) {
            this._preview.iframe.contentWindow?.postMessage(
              { type: "hermetic-hmr-full-reload" },
              "*",
            );
          }
        } catch {
          // Rebuild error — ignore, will be reported via next explicit rebuild
        }
      });
    }
  }

  async rebuild(): Promise<BuildResult> {
    const entry = this.options.entry ?? await this.findEntry();
    this.lastBuild = await build(this.fs, entry, {
      wasmUrl: this.options.esbuildWasmUrl,
    });
    return this.lastBuild;
  }

  private async findEntry(): Promise<string> {
    const candidates = [
      "/src/main.tsx",
      "/src/main.ts",
      "/src/main.jsx",
      "/src/main.js",
      "/src/index.tsx",
      "/src/index.ts",
      "/src/index.jsx",
      "/src/index.js",
      "/index.tsx",
      "/index.ts",
      "/index.jsx",
      "/index.js",
    ];
    for (const candidate of candidates) {
      if (await this.fs.exists(candidate)) return candidate;
    }
    throw new Error("No entry point found. Set options.entry or create /src/main.tsx");
  }

  private createHandler(): ServerHandler {
    return async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const path = url.pathname;

      // Serve built code
      if (path === "/" || path === "/index.html") {
        return new Response(this.generatePreviewHtml(), {
          headers: { "content-type": "text/html" },
        });
      }

      // Try to serve from the virtual filesystem
      try {
        const content = await this.fs.readFile(path);
        return new Response(content as BodyInit, {
          headers: { "content-type": guessMimeType(path) },
        });
      } catch {
        return new Response("Not Found", { status: 404 });
      }
    };
  }

  private generatePreviewHtml(): string {
    if (this.options.template) return this.options.template;
    if (!this.lastBuild) return "<html><body>Building...</body></html>";

    return createHtmlTemplate({
      code: this.lastBuild.code,
      css: this.lastBuild.css,
    });
  }

  dispose(): void {
    this.unwatchFn?.();
    this._preview?.dispose();
    this.disposables.dispose();
  }
}

export function createDev(options: DevOptions): HermeticDev {
  return new HermeticDev(options);
}
