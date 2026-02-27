// @hermetic/core — MessageChannel wire protocol
//
// Every cross-context communication flows through this protocol.
// All message types are discriminated unions, serializable via structured clone.

// === UNIVERSAL ENVELOPE ===

export type RequestMessage = {
  __hermetic: true;
  ns: string;
  id: string;
  method: string;
  args: unknown[];
  transfer?: ArrayBuffer[];
};

export type ResponseMessage = {
  __hermetic: true;
  ns: string;
  id: string;
} & (
  | { ok: true; value: unknown; transfer?: ArrayBuffer[] }
  | { ok: false; error: SerializedError }
);

export type StreamMessage = {
  __hermetic: true;
  ns: string;
  id: string;
  stream: "chunk" | "end" | "error";
  data?: ArrayBuffer;
  error?: string;
};

export type NotificationMessage = {
  __hermetic: true;
  ns: string;
  event: string;
  data: unknown;
};

export type HermeticMessage =
  | RequestMessage
  | ResponseMessage
  | StreamMessage
  | NotificationMessage;

// === ERROR SERIALIZATION ===

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  path?: string;
  syscall?: string;
  stack?: string;
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const e = err as Error & { code?: string; path?: string; syscall?: string };
    return {
      name: e.name,
      message: e.message,
      code: e.code,
      path: e.path,
      syscall: e.syscall,
      stack: e.stack,
    };
  }
  return { name: "Error", message: String(err) };
}

export function deserializeError(se: SerializedError): Error {
  const err = new Error(se.message) as Error & { code?: string; path?: string; syscall?: string };
  err.name = se.name;
  err.code = se.code;
  err.path = se.path;
  err.syscall = se.syscall;
  if (se.stack) err.stack = se.stack;
  return err;
}

// === MESSAGE DISCRIMINATION HELPERS ===

export function isHermeticMessage(msg: unknown): msg is HermeticMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as Record<string, unknown>).__hermetic === true
  );
}

export function isRequestMessage(msg: HermeticMessage): msg is RequestMessage {
  return "method" in msg && "id" in msg && !("ok" in msg) && !("stream" in msg) && !("event" in msg);
}

export function isResponseMessage(msg: HermeticMessage): msg is ResponseMessage {
  return "ok" in msg && "id" in msg;
}

export function isStreamMessage(msg: HermeticMessage): msg is StreamMessage {
  return "stream" in msg;
}

export function isNotificationMessage(msg: HermeticMessage): msg is NotificationMessage {
  return "event" in msg && !("id" in msg);
}
