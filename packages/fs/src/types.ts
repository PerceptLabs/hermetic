// @hermetic/fs — Type definitions

export interface FileStat {
  type: "file" | "directory" | "symlink";
  size: number;
  mode: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  /** For symlinks: the target path */
  target?: string;
}

export interface WriteOptions {
  /** Create parent directories if missing */
  recursive?: boolean;
  /** File mode (default 0o644) */
  mode?: number;
}

export interface MkdirOptions {
  recursive?: boolean;
  mode?: number;
}

export interface RmdirOptions {
  recursive?: boolean;
}

export type WatchEventType = "create" | "modify" | "delete";

export interface WatchEvent {
  type: WatchEventType;
  path: string;
}

export type WatchCallback = (event: WatchEvent) => void;

export interface FSOptions {
  backend?: "opfs" | "memory" | "indexeddb";
}

/** Full virtual filesystem interface */
export interface HermeticFS {
  readonly backend: "opfs" | "memory" | "indexeddb";

  readFile(path: string, encoding?: "utf-8"): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string, options?: WriteOptions): Promise<void>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rmdir(path: string, options?: RmdirOptions): Promise<void>;
  stat(path: string): Promise<FileStat>;
  lstat(path: string): Promise<FileStat>;
  chmod(path: string, mode: number): Promise<void>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  readlink(path: string): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  watch(path: string, callback: WatchCallback): () => void;

  dispose(): void;
}
