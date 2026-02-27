# @hermetic/net

Sandboxed networking via MessageChannel with fetch shim, preview iframe creation, and CSP enforcement.

## Install

```bash
npm install @hermetic/net
```

## Usage

```ts
import { createPreview } from "@hermetic/net";

const handle = await createPreview({
  container: document.getElementById("preview"),
  handler: async (request) => {
    return new Response("Hello from handler!", {
      headers: { "content-type": "text/plain" },
    });
  },
});

// Update preview content
handle.setContent("<html><body>Updated</body></html>");

// Clean up
handle.dispose();
```

## API

| Export | Description |
|--------|-------------|
| `createPreview(options)` | Create sandboxed iframe with MessageChannel networking |
| `createRouter(handler)` | Create message router for handling fetch requests |
| `FETCH_SHIM_SOURCE` | Fetch override script injected into sandbox |

### Types

| Type | Description |
|------|-------------|
| `PreviewHandle` | Handle with iframe ref, navigate(), setContent(), dispose() |
| `PreviewOptions` | Options: handler, container, html |
| `ServerHandler` | `(request: Request) => Promise<Response>` |
