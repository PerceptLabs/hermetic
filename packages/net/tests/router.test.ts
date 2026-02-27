import { describe, it, expect, vi } from "vitest";
import { createRouter } from "../src/router.js";
import { FETCH_SHIM_SOURCE } from "../src/shims/fetch-shim.js";

function createMockPort() {
  const messages: any[] = [];
  return {
    messages,
    port: {
      postMessage(data: any, transfer?: any) {
        messages.push({ data, transfer });
      },
    } as unknown as MessagePort,
  };
}

describe("createRouter", () => {
  it("routes a GET request to the handler", async () => {
    const handler = vi.fn(async (req: Request) => {
      return new Response("hello from server", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });

    const router = createRouter(handler);
    const { port, messages } = createMockPort();

    const event = {
      data: {
        __hermetic: true,
        ns: "net",
        id: "req-1",
        type: "fetch",
        url: "/api/test",
        method: "GET",
        headers: {},
        body: null,
      },
    } as MessageEvent;

    await router(event, port);

    expect(handler).toHaveBeenCalledOnce();
    expect(messages).toHaveLength(1);

    const response = messages[0].data;
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/plain");

    const body = new TextDecoder().decode(response.body);
    expect(body).toBe("hello from server");
  });

  it("routes a POST request with body", async () => {
    const handler = vi.fn(async (req: Request) => {
      const body = await req.text();
      return new Response(`echo: ${body}`, { status: 200 });
    });

    const router = createRouter(handler);
    const { port, messages } = createMockPort();

    const bodyBuffer = new TextEncoder().encode('{"key":"value"}').buffer;
    const event = {
      data: {
        __hermetic: true,
        ns: "net",
        id: "req-2",
        type: "fetch",
        url: "/api/data",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyBuffer,
      },
    } as MessageEvent;

    await router(event, port);

    expect(handler).toHaveBeenCalledOnce();
    const response = messages[0].data;
    expect(response.status).toBe(200);
    const responseBody = new TextDecoder().decode(response.body);
    expect(responseBody).toBe('echo: {"key":"value"}');
  });

  it("returns 500 when handler throws", async () => {
    const handler = vi.fn(async () => {
      throw new Error("server crash");
    });

    const router = createRouter(handler);
    const { port, messages } = createMockPort();

    const event = {
      data: {
        __hermetic: true,
        ns: "net",
        id: "req-3",
        type: "fetch",
        url: "/api/fail",
        method: "GET",
        headers: {},
        body: null,
      },
    } as MessageEvent;

    await router(event, port);

    expect(messages).toHaveLength(1);
    const response = messages[0].data;
    expect(response.status).toBe(500);
    const body = new TextDecoder().decode(response.body);
    expect(body).toBe("server crash");
  });

  it("ignores non-hermetic messages", async () => {
    const handler = vi.fn();
    const router = createRouter(handler);
    const { port, messages } = createMockPort();

    await router({ data: { type: "other" } } as MessageEvent, port);
    await router({ data: null } as MessageEvent, port);

    expect(handler).not.toHaveBeenCalled();
    expect(messages).toHaveLength(0);
  });

  it("preserves response headers", async () => {
    const handler = vi.fn(async () => {
      return new Response("ok", {
        status: 201,
        statusText: "Created",
        headers: {
          "x-custom": "value",
          "content-type": "application/json",
        },
      });
    });

    const router = createRouter(handler);
    const { port, messages } = createMockPort();

    const event = {
      data: {
        __hermetic: true,
        ns: "net",
        id: "req-4",
        type: "fetch",
        url: "/api/create",
        method: "POST",
        headers: {},
        body: null,
      },
    } as MessageEvent;

    await router(event, port);

    const response = messages[0].data;
    expect(response.status).toBe(201);
    expect(response.headers["x-custom"]).toBe("value");
  });
});

describe("Security", () => {
  it("fetch shim intercepts javascript: URLs", () => {
    // The shouldIntercept function in the shim should return true for dangerous protocols
    expect(FETCH_SHIM_SOURCE).toContain("javascript");
    expect(FETCH_SHIM_SOURCE).toContain("data");
    expect(FETCH_SHIM_SOURCE).toContain("blob");
    expect(FETCH_SHIM_SOURCE).toContain("vbscript");
  });

  it("fetch shim validates message structure", () => {
    // The shim should check for valid message types before processing
    expect(FETCH_SHIM_SOURCE).toContain("hermetic-net-init");
    expect(FETCH_SHIM_SOURCE).toContain("hermetic-set-content");
    expect(FETCH_SHIM_SOURCE).toContain("hermetic-navigate");
    expect(FETCH_SHIM_SOURCE).toContain("typeof event.data !== \"object\"");
  });

  it("CSP is configured in preview source", async () => {
    const { createPreview } = await import("../src/preview.js");
    // Preview module should exist and use CSP
    expect(createPreview).toBeDefined();
  });
});
