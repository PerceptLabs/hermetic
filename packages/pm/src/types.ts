// @hermetic/pm — Type definitions

import type { Disposable } from "@hermetic/core";
import type { HermeticFS } from "@hermetic/fs";

export interface Packument {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, VersionMetadata>;
}

export interface VersionMetadata {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dist: {
    tarball: string;
    shasum: string;
    integrity?: string;
  };
  main?: string;
  module?: string;
  types?: string;
}

export interface TarEntry {
  name: string;
  mode: number;
  size: number;
  type: "file" | "directory";
  content: Uint8Array;
}

export interface ResolvedPackage {
  name: string;
  version: string;
  tarball: string;
  dependencies: Record<string, string>;
}

export interface PMOptions {
  fs: HermeticFS;
  registryUrl?: string;
  cdnUrl?: string;
}

export interface HermeticPMInterface extends Disposable {
  install(packages?: string[]): Promise<void>;
  uninstall(packages: string[]): Promise<void>;
}
