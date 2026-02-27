// @hermetic/net — Fetch shim (runs INSIDE the sandbox iframe)
//
// This code is bundled as a string and injected into the iframe's <script> tag.
// It overrides window.fetch to route requests through the MessageChannel port.
//
// IMPORTANT: This file is self-contained. No external imports.

export const FETCH_SHIM_SOURCE = `
(function() {
  let __hermeticPort = null;
  const __pendingRequests = new Map();

  // Listen for port transfer from host
  window.addEventListener("message", function(event) {
    if (event.data && event.data.type === "hermetic-net-init" && event.ports.length > 0) {
      __hermeticPort = event.ports[0];
      __hermeticPort.onmessage = function(e) {
        const msg = e.data;
        if (!msg || !msg.__hermetic || msg.ns !== "net") return;

        if (msg.type === "fetch-response") {
          const pending = __pendingRequests.get(msg.id);
          if (pending) {
            __pendingRequests.delete(msg.id);
            pending.resolve(msg);
          }
        }

        if (msg.stream === "chunk") {
          const pending = __pendingRequests.get(msg.id);
          if (pending && pending.controller) {
            pending.controller.enqueue(new Uint8Array(msg.data));
          }
        }

        if (msg.stream === "end") {
          const pending = __pendingRequests.get(msg.id);
          if (pending && pending.controller) {
            pending.controller.close();
            __pendingRequests.delete(msg.id);
          }
        }

        if (msg.stream === "error") {
          const pending = __pendingRequests.get(msg.id);
          if (pending && pending.controller) {
            pending.controller.error(new Error(msg.error));
            __pendingRequests.delete(msg.id);
          }
        }
      };
      __hermeticPort.start();
    }

    // Content injection from host
    if (event.data && event.data.type === "hermetic-set-content") {
      document.open();
      document.write(event.data.html);
      document.close();
    }
  });

  // Check if a URL should be intercepted (relative/localhost) or passed through
  function shouldIntercept(url) {
    try {
      var parsed = new URL(url, "http://localhost");
      return parsed.hostname === "localhost" ||
             parsed.hostname === "127.0.0.1" ||
             url.startsWith("/") ||
             url.startsWith("./") ||
             url.startsWith("../");
    } catch {
      return true; // If can't parse, intercept
    }
  }

  // Override fetch
  var _originalFetch = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));

    // Pass through external URLs to real fetch
    if (!shouldIntercept(url)) {
      return _originalFetch.call(window, input, init);
    }

    if (!__hermeticPort) {
      return Promise.reject(new TypeError("Network not initialized: MessagePort not yet received"));
    }

    var id = Math.random().toString(36).substring(2) + Date.now().toString(36);
    var method = (init && init.method) || (input instanceof Request ? input.method : "GET");
    var headers = {};
    if (init && init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach(function(v, k) { headers[k] = v; });
      } else if (typeof init.headers === "object") {
        Object.assign(headers, init.headers);
      }
    }

    return new Promise(function(resolve, reject) {
      // Get body as ArrayBuffer
      var bodyPromise = Promise.resolve(null);
      if (init && init.body) {
        if (typeof init.body === "string") {
          bodyPromise = Promise.resolve(new TextEncoder().encode(init.body).buffer);
        } else if (init.body instanceof ArrayBuffer) {
          bodyPromise = Promise.resolve(init.body);
        } else if (init.body instanceof Uint8Array) {
          bodyPromise = Promise.resolve(init.body.buffer);
        }
      }

      bodyPromise.then(function(body) {
        __pendingRequests.set(id, {
          resolve: function(msg) {
            if (msg.streaming) {
              // Streaming response — use ReadableStream
              var controller;
              var stream = new ReadableStream({
                start: function(c) {
                  controller = c;
                  // Re-register for streaming
                  __pendingRequests.set(id, { controller: controller });
                }
              });
              resolve(new Response(stream, {
                status: msg.status,
                statusText: msg.statusText,
                headers: msg.headers,
              }));
            } else {
              resolve(new Response(msg.body, {
                status: msg.status,
                statusText: msg.statusText,
                headers: msg.headers,
              }));
            }
          },
          reject: reject
        });

        var transfer = body ? [body] : [];
        __hermeticPort.postMessage({
          __hermetic: true,
          ns: "net",
          id: id,
          type: "fetch",
          url: url,
          method: method,
          headers: headers,
          body: body
        }, transfer);
      });
    });
  };
})();
`;
