// Hermetic Playground — entry point
//
// Wires together FS, Shell, and Dev into an interactive playground.

import { MemoryFS } from "@hermetic/fs";
import { HermeticShell } from "@hermetic/shell";

// === State ===

let fs: MemoryFS;
let shell: HermeticShell;
let currentFile = "/index.js";
const commandHistory: string[] = [];
let historyIndex = -1;

// === DOM refs ===

const fileList = document.getElementById("file-list")!;
const editor = document.getElementById("editor") as HTMLTextAreaElement;
const editorFilename = document.getElementById("editor-filename")!;
const terminalOutput = document.getElementById("terminal-output")!;
const terminalInput = document.getElementById("terminal-input") as HTMLInputElement;
const btnRun = document.getElementById("btn-run")!;
const btnClear = document.getElementById("btn-clear")!;
const btnSave = document.getElementById("btn-save")!;
const previewContainer = document.getElementById("preview-container")!;

// === Bootstrap ===

async function init() {
  fs = new MemoryFS();
  shell = new HermeticShell(fs, { cwd: "/" });

  // Seed some files
  await fs.mkdir("/src", { recursive: true });
  await fs.writeFile(
    "/index.js",
    `// Welcome to Hermetic Playground!
// This code runs entirely in your browser.

function greet(name) {
  return "Hello, " + name + "!";
}

console.log(greet("World"));
console.log("Hermetic is running in a sealed sandbox.");
`,
  );

  await fs.writeFile(
    "/index.html",
    `<!DOCTYPE html>
<html>
<head><title>My App</title></head>
<body>
  <h1>Hello from Hermetic!</h1>
  <p>This page is served from the virtual filesystem.</p>
  <script src="/index.js"><\/script>
</body>
</html>
`,
  );

  await fs.writeFile(
    "/src/utils.js",
    `export function add(a, b) {
  return a + b;
}

export function multiply(a, b) {
  return a * b;
}
`,
  );

  await fs.writeFile(
    "/package.json",
    JSON.stringify(
      {
        name: "hermetic-demo",
        version: "1.0.0",
        main: "index.js",
      },
      null,
      2,
    ),
  );

  // Load initial file
  await openFile(currentFile);
  await refreshFileTree();
  terminalPrint("Welcome to Hermetic Playground!", "stdout");
  terminalPrint('Type "help" for available commands.\n', "stdout");
  updatePreview();
}

// === File Tree ===

async function refreshFileTree() {
  fileList.innerHTML = "";
  await renderDir("/", 0);
}

async function renderDir(path: string, depth: number) {
  const entries = await fs.readdir(path);
  const sorted = entries.sort();

  for (const entry of sorted) {
    const fullPath = path === "/" ? `/${entry}` : `${path}/${entry}`;
    const stat = await fs.stat(fullPath);
    const isDir = stat.type === "directory";

    const el = document.createElement("div");
    el.className = `file-item${isDir ? " directory" : ""}${fullPath === currentFile ? " active" : ""}`;
    el.style.paddingLeft = `${12 + depth * 16}px`;
    el.textContent = isDir ? `${entry}/` : entry;

    if (!isDir) {
      el.addEventListener("click", () => openFile(fullPath));
    }

    fileList.appendChild(el);

    if (isDir) {
      await renderDir(fullPath, depth + 1);
    }
  }
}

// === Editor ===

async function openFile(path: string) {
  // Save current file first
  if (currentFile && editor.value) {
    await saveCurrentFile();
  }

  currentFile = path;
  editorFilename.textContent = path;

  try {
    const content = (await fs.readFile(path, "utf-8")) as string;
    editor.value = content;
  } catch {
    editor.value = "";
  }

  await refreshFileTree();
}

async function saveCurrentFile() {
  if (!currentFile) return;
  await fs.writeFile(currentFile, editor.value);
}

// === Terminal ===

function terminalPrint(text: string, type: "cmd" | "stdout" | "stderr" = "stdout") {
  if (!text) return;
  const line = document.createElement("div");
  line.className = `terminal-line ${type}`;
  line.textContent = text;
  terminalOutput.appendChild(line);
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

async function executeCommand(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return;

  commandHistory.push(trimmed);
  historyIndex = commandHistory.length;

  terminalPrint(`$ ${trimmed}`, "cmd");

  // Handle special playground commands
  if (trimmed === "help") {
    terminalPrint(
      [
        "Available commands:",
        "  echo, pwd, cd, ls, cat, mkdir, rm, cp, mv, touch",
        "  env, export, which, clear",
        "  help       — Show this help",
        "  run        — Execute current file in preview",
        "  files      — Refresh file tree",
        "",
      ].join("\n"),
      "stdout",
    );
    return;
  }

  if (trimmed === "run") {
    await saveCurrentFile();
    updatePreview();
    terminalPrint("Preview updated.\n", "stdout");
    return;
  }

  if (trimmed === "files") {
    await refreshFileTree();
    terminalPrint("File tree refreshed.\n", "stdout");
    return;
  }

  if (trimmed === "clear") {
    terminalOutput.innerHTML = "";
    return;
  }

  // Execute via shell
  const result = await shell.exec(trimmed);
  if (result.stdout) terminalPrint(result.stdout, "stdout");
  if (result.stderr) terminalPrint(result.stderr, "stderr");

  // Refresh file tree after commands that might modify files
  if (/^(mkdir|touch|rm|cp|mv|echo\s.*>)/.test(trimmed)) {
    await refreshFileTree();
  }
}

// === Preview ===

function updatePreview() {
  previewContainer.innerHTML = "";

  const iframe = document.createElement("iframe");
  iframe.sandbox.add("allow-scripts");
  previewContainer.appendChild(iframe);

  // Build preview HTML from virtual FS
  buildPreviewContent().then((html) => {
    iframe.srcdoc = html;
  });
}

async function buildPreviewContent(): Promise<string> {
  try {
    // Try to read index.html
    const html = (await fs.readFile("/index.html", "utf-8")) as string;

    // Inline any script tags referencing local files
    const inlined = await inlineScripts(html);
    return inlined;
  } catch {
    // Fallback: just run index.js in a blank page
    try {
      const js = (await fs.readFile("/index.js", "utf-8")) as string;
      return `<!DOCTYPE html>
<html>
<head><title>Preview</title></head>
<body>
<pre id="output"></pre>
<script>
const _origLog = console.log;
console.log = function(...args) {
  const el = document.getElementById("output");
  if (el) el.textContent += args.join(" ") + "\\n";
  _origLog.apply(console, args);
};
${js}
<\/script>
</body>
</html>`;
    } catch {
      return "<html><body><p>No index.html or index.js found.</p></body></html>";
    }
  }
}

async function inlineScripts(html: string): Promise<string> {
  // Replace <script src="/..."> with inline <script> content from FS
  const scriptRegex = /<script\s+src="(\/[^"]+)"[^>]*><\/script>/gi;
  let result = html;
  let match: RegExpExecArray | null;

  // eslint-disable-next-line no-cond-assign
  while ((match = scriptRegex.exec(html)) !== null) {
    const srcPath = match[1];
    try {
      const content = (await fs.readFile(srcPath, "utf-8")) as string;
      // Wrap console.log to display in page
      const wrapped = `
<script>
const _origLog = console.log;
console.log = function(...args) {
  let el = document.getElementById("__console");
  if (!el) {
    el = document.createElement("pre");
    el.id = "__console";
    el.style.cssText = "background:#222;color:#eee;padding:12px;margin:12px;border-radius:4px;font-size:14px;";
    document.body.appendChild(el);
  }
  el.textContent += args.join(" ") + "\\n";
  _origLog.apply(console, args);
};
${content}
<\/script>`;
      result = result.replace(match[0], wrapped);
    } catch {
      // Leave original script tag if file not found
    }
  }

  return result;
}

// === Event Handlers ===

// Terminal input
terminalInput.addEventListener("keydown", async (e) => {
  if (e.key === "Enter") {
    const input = terminalInput.value;
    terminalInput.value = "";
    await executeCommand(input);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (historyIndex > 0) {
      historyIndex--;
      terminalInput.value = commandHistory[historyIndex];
    }
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    if (historyIndex < commandHistory.length - 1) {
      historyIndex++;
      terminalInput.value = commandHistory[historyIndex];
    } else {
      historyIndex = commandHistory.length;
      terminalInput.value = "";
    }
  }
});

// Tab key in editor
editor.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.value = editor.value.substring(0, start) + "  " + editor.value.substring(end);
    editor.selectionStart = editor.selectionEnd = start + 2;
  }
  // Ctrl/Cmd+S to save
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    saveCurrentFile().then(() => refreshFileTree());
  }
});

// Toolbar buttons
btnRun.addEventListener("click", async () => {
  await saveCurrentFile();
  updatePreview();
  terminalPrint("Preview updated.\n", "stdout");
});

btnClear.addEventListener("click", () => {
  terminalOutput.innerHTML = "";
});

btnSave.addEventListener("click", async () => {
  await saveCurrentFile();
  terminalPrint(`Saved ${currentFile}\n`, "stdout");
});

// Keep focus on terminal input when clicking terminal area
document.getElementById("terminal-panel")!.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).id !== "terminal-input") {
    terminalInput.focus();
  }
});

// === Start ===

init().catch((err) => {
  console.error("Failed to initialize Hermetic Playground:", err);
});
