// @hermetic/core — Public API

// Types
export type { Disposable, HermeticConfig, CapabilitySet } from "./types.js";

// Protocol
export type {
  RequestMessage,
  ResponseMessage,
  StreamMessage,
  NotificationMessage,
  HermeticMessage,
  SerializedError,
} from "./protocol.js";
export {
  serializeError,
  deserializeError,
  isHermeticMessage,
  isRequestMessage,
  isResponseMessage,
  isStreamMessage,
  isNotificationMessage,
} from "./protocol.js";

// Channel
export { HermeticChannel } from "./channel.js";

// Errors
export {
  HermeticError,
  ENOENT,
  EISDIR,
  ENOTDIR,
  EACCES,
  ENOTEMPTY,
  EEXIST,
  EBUSY,
  EIO,
  ELOOP,
} from "./errors.js";

// Disposable
export { DisposableStore } from "./disposable.js";

// Utilities
export {
  normalizePath,
  joinPath,
  dirname,
  basename,
  extname,
  isAbsolute,
  resolvePath,
  guessMimeType,
} from "./utils.js";
