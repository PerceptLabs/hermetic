// @hermetic/dev — Type definitions

import type { Disposable } from "@hermetic/core";
import type { HermeticFS } from "@hermetic/fs";
import type { PreviewHandle, ServerHandler } from "@hermetic/net";

export interface DevOptions {
  /** The filesystem to build from */
  fs: HermeticFS;
  /** Entry point file path (default: /src/main.tsx or /src/index.ts) */
  entry?: string;
  /** Container for the preview iframe */
  container?: HTMLElement;
  /** Custom HTML template */
  template?: string;
  /** Enable HMR (default: true) */
  hmr?: boolean;
  /** esbuild-wasm URL (default: esm.sh CDN) */
  esbuildWasmUrl?: string;
}

export interface BuildResult {
  /** Built JavaScript code */
  code: string;
  /** CSS output (if any) */
  css?: string;
  /** Build errors */
  errors: BuildMessage[];
  /** Build warnings */
  warnings: BuildMessage[];
}

export interface BuildMessage {
  text: string;
  location?: {
    file: string;
    line: number;
    column: number;
  };
}

export interface HermeticDevInterface extends Disposable {
  /** Start the dev server */
  start(): Promise<void>;
  /** Trigger a rebuild */
  rebuild(): Promise<BuildResult>;
  /** Get the preview handle */
  preview: PreviewHandle | null;
}
