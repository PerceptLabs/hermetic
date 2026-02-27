# @hermetic/dev

Dev server with esbuild-wasm builds, HMR, and preview integration.

## Install

```bash
npm install @hermetic/dev
```

## Usage

```ts
import { HermeticDev, build } from "@hermetic/dev";

// Standalone build
const result = await build(fs, "/src/main.tsx");
console.log(result.code); // bundled JS
console.log(result.css);  // extracted CSS (if any)

// Full dev server
const dev = new HermeticDev({ fs, container: document.getElementById("preview") });
await dev.start(); // builds, creates preview, watches for changes
dev.dispose();
```

## API

| Export | Description |
|--------|-------------|
| `HermeticDev` | Dev server class with build + preview + HMR |
| `createDev(options)` | Factory function |
| `build(fs, entry, options?)` | Standalone esbuild-wasm build |
| `createHtmlTemplate(options)` | Generate preview HTML from code/CSS |
| `HMR_CLIENT_SOURCE` | HMR client script source |
