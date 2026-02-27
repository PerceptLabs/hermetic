// @hermetic/core — Error types with POSIX error codes

export class HermeticError extends Error {
  code: string;
  path?: string;
  syscall?: string;

  constructor(code: string, message: string, options?: { path?: string; syscall?: string }) {
    super(message);
    this.name = code;
    this.code = code;
    this.path = options?.path;
    this.syscall = options?.syscall;
  }
}

// POSIX error code factory functions

export function ENOENT(path: string, syscall?: string): HermeticError {
  return new HermeticError("ENOENT", `ENOENT: no such file or directory, '${path}'`, { path, syscall });
}

export function EISDIR(path: string, syscall?: string): HermeticError {
  return new HermeticError("EISDIR", `EISDIR: illegal operation on a directory, '${path}'`, { path, syscall });
}

export function ENOTDIR(path: string, syscall?: string): HermeticError {
  return new HermeticError("ENOTDIR", `ENOTDIR: not a directory, '${path}'`, { path, syscall });
}

export function EACCES(path: string, syscall?: string): HermeticError {
  return new HermeticError("EACCES", `EACCES: permission denied, '${path}'`, { path, syscall });
}

export function ENOTEMPTY(path: string, syscall?: string): HermeticError {
  return new HermeticError("ENOTEMPTY", `ENOTEMPTY: directory not empty, '${path}'`, { path, syscall });
}

export function EEXIST(path: string, syscall?: string): HermeticError {
  return new HermeticError("EEXIST", `EEXIST: file already exists, '${path}'`, { path, syscall });
}

export function EBUSY(path: string, syscall?: string): HermeticError {
  return new HermeticError("EBUSY", `EBUSY: resource busy or locked, '${path}'`, { path, syscall });
}

export function EIO(message?: string): HermeticError {
  return new HermeticError("EIO", message ?? "EIO: input/output error");
}

export function ELOOP(path: string): HermeticError {
  return new HermeticError("ELOOP", `ELOOP: too many levels of symbolic links, '${path}'`, { path });
}
