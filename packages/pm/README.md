# @hermetic/pm

Package manager with npm-compatible registry support and tar parsing.

## Install

```bash
npm install @hermetic/pm
```

## Usage

```ts
import { createPM } from "@hermetic/pm";

const pm = createPM({ fs });
const info = await pm.resolve("react");
```

## API

| Export | Description |
|--------|-------------|
| `HermeticPM` | Package manager class |
| `createPM({ fs })` | Factory function |
