// @hermetic/pm — npm registry HTTP client

import type { Packument, VersionMetadata } from "./types.js";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export class RegistryClient {
  private registryUrl: string;
  private cache = new Map<string, Packument>();

  constructor(registryUrl?: string) {
    this.registryUrl = registryUrl ?? DEFAULT_REGISTRY;
  }

  async getPackument(name: string): Promise<Packument> {
    if (this.cache.has(name)) return this.cache.get(name)!;

    const url = `${this.registryUrl}/${encodeURIComponent(name).replace("%40", "@")}`;
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Package not found: ${name} (${response.status})`);
    }

    const packument = (await response.json()) as Packument;
    this.cache.set(name, packument);
    return packument;
  }

  async getVersion(name: string, version: string): Promise<VersionMetadata> {
    const packument = await this.getPackument(name);

    // Resolve dist-tags
    const resolved = packument["dist-tags"][version] ?? version;
    const metadata = packument.versions[resolved];

    if (!metadata) {
      throw new Error(`Version not found: ${name}@${version}`);
    }

    return metadata;
  }

  async getLatestVersion(name: string): Promise<VersionMetadata> {
    return this.getVersion(name, "latest");
  }
}
