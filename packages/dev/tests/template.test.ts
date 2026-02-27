import { describe, it, expect } from "vitest";
import { createHtmlTemplate } from "../src/templates/html-template.js";
import { HMR_CLIENT_SOURCE } from "../src/templates/hmr-client.js";

describe("createHtmlTemplate", () => {
  it("generates valid HTML with code", () => {
    const html = createHtmlTemplate({ code: 'console.log("hello")' });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('console.log("hello")');
    expect(html).toContain('<script type="module">');
  });

  it("includes CSS when provided", () => {
    const html = createHtmlTemplate({
      code: "",
      css: "body { color: red; }",
    });
    expect(html).toContain("<style>body { color: red; }</style>");
  });

  it("omits CSS style tag when not provided", () => {
    const html = createHtmlTemplate({ code: "" });
    expect(html).not.toContain("<style>");
  });

  it("uses custom title", () => {
    const html = createHtmlTemplate({ code: "", title: "My App" });
    expect(html).toContain("<title>My App</title>");
  });
});

describe("HMR_CLIENT_SOURCE", () => {
  it("is a non-empty string", () => {
    expect(typeof HMR_CLIENT_SOURCE).toBe("string");
    expect(HMR_CLIENT_SOURCE.length).toBeGreaterThan(0);
  });

  it("contains HMR accept function", () => {
    expect(HMR_CLIENT_SOURCE).toContain("__hermetic_hmr");
    expect(HMR_CLIENT_SOURCE).toContain("accept");
  });

  it("listens for hermetic-hmr-update messages", () => {
    expect(HMR_CLIENT_SOURCE).toContain("hermetic-hmr-update");
    expect(HMR_CLIENT_SOURCE).toContain("hermetic-hmr-full-reload");
  });
});
