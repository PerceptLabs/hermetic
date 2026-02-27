# @hermetic/vm

Capability-based sandbox VM with a binding system for exposing host APIs to isolated code.

## Install

```bash
npm install @hermetic/vm
```

## Usage

```ts
import { createVM } from "@hermetic/vm";

const vm = createVM();
vm.register("log", { invoke: (msg) => console.log("[sandbox]", msg) });
```

## API

| Export | Description |
|--------|-------------|
| `HermeticVM` | Capability-based VM class |
| `createVM()` | Factory function |
