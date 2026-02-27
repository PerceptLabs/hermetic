// @hermetic/core — Core type definitions

/** Generic async disposable interface */
export interface Disposable {
  dispose(): void;
}

/** Configuration for Hermetic runtime initialization */
export interface HermeticConfig {
  /** Namespace prefix for OPFS storage isolation */
  storagePrefix?: string;
  /** Default RPC timeout in milliseconds */
  rpcTimeout?: number;
}

/** Capability set that a sandbox context may request */
export type CapabilitySet = {
  fs?: boolean;
  net?: boolean;
  proc?: boolean;
  env?: Record<string, string>;
};
