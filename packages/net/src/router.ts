// @hermetic/net — Host-side request router
//
// Reconstructs Request objects from MessageChannel messages,
// calls the server handler, serializes Response back.

import { serializeError } from "@hermetic/core";
import type { ServerHandler } from "./types.js";

/**
 * Create a message event handler that routes fetch requests from the
 * preview iframe to the server handler.
 */
export function createRouter(handler: ServerHandler) {
  return async (event: MessageEvent, port: MessagePort): Promise<void> => {
    const msg = event.data;
    if (!msg?.__hermetic || msg.ns !== "net" || msg.type !== "fetch") return;

    const { id, url, method, headers, body } = msg;

    try {
      // Reconstruct a proper Request object
      const requestInit: RequestInit = {
        method,
        headers,
      };

      // Only set body for methods that support it
      if (body && method !== "GET" && method !== "HEAD") {
        requestInit.body = body;
      }

      // Resolve URL relative to localhost
      const resolvedUrl = url.startsWith("http")
        ? url
        : `http://localhost${url.startsWith("/") ? url : "/" + url}`;

      const request = new Request(resolvedUrl, requestInit);
      const response = await handler(request);

      // Check for streaming response
      if (response.body && isStreamingResponse(response)) {
        // Send metadata first
        port.postMessage({
          __hermetic: true,
          ns: "net",
          id,
          type: "fetch-response",
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: null,
          streaming: true,
        });

        // Pipe chunks through MessageChannel
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              port.postMessage({ __hermetic: true, ns: "net", id, stream: "end" });
              break;
            }
            port.postMessage(
              { __hermetic: true, ns: "net", id, stream: "chunk", data: value.buffer },
              [value.buffer],
            );
          }
        } catch (err) {
          port.postMessage({
            __hermetic: true,
            ns: "net",
            id,
            stream: "error",
            error: String(err),
          });
        }
        return;
      }

      // Non-streaming response — send body as ArrayBuffer
      const responseBody = await response.arrayBuffer();
      const transfer: Transferable[] = responseBody.byteLength > 0 ? [responseBody] : [];

      port.postMessage(
        {
          __hermetic: true,
          ns: "net",
          id,
          type: "fetch-response",
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: responseBody,
        },
        transfer,
      );
    } catch (err) {
      port.postMessage({
        __hermetic: true,
        ns: "net",
        id,
        type: "fetch-response",
        status: 500,
        statusText: "Internal Server Error",
        headers: { "content-type": "text/plain" },
        body: new TextEncoder().encode(
          err instanceof Error ? err.message : String(err),
        ).buffer,
      });
    }
  };
}

function isStreamingResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return (
    contentType.includes("text/event-stream") ||
    contentType.includes("application/x-ndjson") ||
    response.headers.has("transfer-encoding")
  );
}
