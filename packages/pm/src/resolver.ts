// @hermetic/pm — Dependency resolver
//
// Simple flat resolution (npm v3+ hoisting style).
// Resolves all dependencies into a flat list for node_modules.

import type { ResolvedPackage } from "./types.js";
import { RegistryClient } from "./registry.js";

export class DependencyResolver {
  private registry: RegistryClient;
  private resolved = new Map<string, ResolvedPackage>();

  constructor(registry: RegistryClient) {
    this.registry = registry;
  }

  async resolve(dependencies: Record<string, string>): Promise<ResolvedPackage[]> {
    this.resolved.clear();
    const queue: Array<{ name: string; range: string }> = [];

    for (const [name, range] of Object.entries(dependencies)) {
      queue.push({ name, range });
    }

    while (queue.length > 0) {
      const { name, range } = queue.shift()!;

      // Skip if already resolved
      if (this.resolved.has(name)) continue;

      const version = await this.registry.getVersion(name, range.replace(/^[\^~>=<]*/,"") || "latest");

      this.resolved.set(name, {
        name: version.name,
        version: version.version,
        tarball: version.dist.tarball,
        dependencies: version.dependencies ?? {},
      });

      // Queue transitive dependencies
      if (version.dependencies) {
        for (const [depName, depRange] of Object.entries(version.dependencies)) {
          if (!this.resolved.has(depName)) {
            queue.push({ name: depName, range: depRange });
          }
        }
      }
    }

    return Array.from(this.resolved.values());
  }
}
