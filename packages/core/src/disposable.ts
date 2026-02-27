// @hermetic/core — Disposable pattern for resource cleanup

import type { Disposable } from "./types.js";

export type { Disposable };

export class DisposableStore implements Disposable {
  private items: Disposable[] = [];

  add<T extends Disposable>(item: T): T {
    this.items.push(item);
    return item;
  }

  dispose(): void {
    for (const item of this.items.reverse()) {
      try {
        item.dispose();
      } catch {
        // Swallow errors during disposal — best-effort cleanup
      }
    }
    this.items = [];
  }
}
