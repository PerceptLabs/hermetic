// @hermetic/net — Preview iframe creation and port transfer
//
// Creates a sandbox iframe with shim code injected, transfers MessageChannel
// port on load, and provides a PreviewHandle for management.

import type { Disposable } from "@hermetic/core";
import type { PreviewOptions, PreviewHandle } from "./types.js";
import { createRouter } from "./router.js";
import { FETCH_SHIM_SOURCE } from "./shims/fetch-shim.js";
import { LOCATION_SHIM_SOURCE } from "./shims/location-shim.js";
import { COOKIE_SHIM_SOURCE } from "./shims/cookie-shim.js";

/**
 * Build the combined shim code that gets injected into the iframe.
 */
function buildShimCode(): string {
  return [FETCH_SHIM_SOURCE, LOCATION_SHIM_SOURCE, COOKIE_SHIM_SOURCE].join("\n");
}

/**
 * Create a sandboxed preview iframe with MessageChannel-based networking.
 *
 * Bootstrap sequence:
 * 1. Host creates MessageChannel → gets port1 (for iframe), port2 (for router)
 * 2. Host creates sandbox iframe (srcdoc with shim code)
 * 3. Host registers router on port2
 * 4. Host waits for iframe "load" event
 * 5. Host transfers port1 into iframe via postMessage
 * 6. Iframe shim receives port, starts intercepting fetch()
 */
export function createPreview(options: PreviewOptions): Promise<PreviewHandle> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    const router = createRouter(options.handler);

    // Router listens on port2
    port2.onmessage = (event) => router(event, port2);

    const shimCode = buildShimCode();
    const userHtml = options.html ?? "";

    // Create sandbox iframe — allow-scripts but NOT allow-same-origin
    const iframe = document.createElement("iframe");
    iframe.sandbox.add("allow-scripts");

    iframe.srcdoc = `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Security-Policy"
      content="script-src 'unsafe-inline' blob:; connect-src 'none';">
</head><body>
<script>${shimCode}</script>
${userHtml}
</body></html>`;

    iframe.style.cssText = "border:none;width:100%;height:100%";

    iframe.addEventListener("load", () => {
      // Transfer port1 into the iframe — MUST happen after load
      iframe.contentWindow!.postMessage(
        { type: "hermetic-net-init" },
        "*",
        [port1],
      );

      const handle: PreviewHandle = {
        iframe,
        navigate(url: string) {
          // Virtual navigation — update the iframe content via fetch
          iframe.contentWindow!.postMessage(
            { type: "hermetic-navigate", url },
            "*",
          );
        },
        setContent(html: string) {
          iframe.contentWindow!.postMessage(
            { type: "hermetic-set-content", html },
            "*",
          );
        },
        dispose() {
          port1.close();
          port2.close();
          iframe.remove();
        },
      };

      resolve(handle);
    });

    // Append to trigger load
    (options.container ?? document.body).appendChild(iframe);
  });
}
