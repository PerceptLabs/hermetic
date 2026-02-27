// @hermetic/pm — HermeticPM class

import { joinPath } from "@hermetic/core";
import type { HermeticFS } from "@hermetic/fs";
import type { HermeticPMInterface, PMOptions } from "./types.js";
import { RegistryClient } from "./registry.js";
import { DependencyResolver } from "./resolver.js";
import { extractPackage } from "./tarball.js";

export class HermeticPM implements HermeticPMInterface {
  private fs: HermeticFS;
  private registry: RegistryClient;
  private resolver: DependencyResolver;
  private cdnUrl: string;

  constructor(options: PMOptions) {
    this.fs = options.fs;
    this.registry = new RegistryClient(options.registryUrl);
    this.resolver = new DependencyResolver(this.registry);
    this.cdnUrl = options.cdnUrl ?? "https://esm.sh";
  }

  async install(packages?: string[]): Promise<void> {
    let dependencies: Record<string, string>;

    if (packages && packages.length > 0) {
      // Install specific packages
      dependencies = {};
      for (const pkg of packages) {
        const [name, version] = pkg.includes("@") && !pkg.startsWith("@")
          ? pkg.split("@")
          : [pkg, "latest"];
        dependencies[name] = version;
      }
    } else {
      // Read from package.json
      try {
        const pkgJson = await this.fs.readFile("/package.json", "utf-8");
        const pkg = JSON.parse(pkgJson as string);
        dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
      } catch {
        throw new Error("No package.json found and no packages specified");
      }
    }

    // Resolve dependency tree
    const resolved = await this.resolver.resolve(dependencies);

    // Ensure node_modules exists
    await this.fs.mkdir("/node_modules", { recursive: true });

    // Install each package
    for (const pkg of resolved) {
      const targetDir = joinPath("/node_modules", pkg.name);
      await this.fs.mkdir(targetDir, { recursive: true });
      await extractPackage(pkg.tarball, targetDir, this.fs);
    }

    // Write/update package.json if installing specific packages
    if (packages && packages.length > 0) {
      await this.updatePackageJson(dependencies);
    }
  }

  async uninstall(packages: string[]): Promise<void> {
    for (const pkg of packages) {
      const targetDir = joinPath("/node_modules", pkg);
      if (await this.fs.exists(targetDir)) {
        await this.fs.rmdir(targetDir, { recursive: true });
      }
    }
  }

  private async updatePackageJson(newDeps: Record<string, string>): Promise<void> {
    let pkg: Record<string, unknown>;
    try {
      const content = await this.fs.readFile("/package.json", "utf-8");
      pkg = JSON.parse(content as string);
    } catch {
      pkg = { name: "hermetic-project", version: "0.1.0" };
    }

    const deps = (pkg.dependencies as Record<string, string>) ?? {};
    Object.assign(deps, newDeps);
    pkg.dependencies = deps;

    await this.fs.writeFile("/package.json", JSON.stringify(pkg, null, 2));
  }

  dispose(): void {
    // No persistent resources to clean up
  }
}

export function createPM(options: PMOptions): HermeticPM {
  return new HermeticPM(options);
}
