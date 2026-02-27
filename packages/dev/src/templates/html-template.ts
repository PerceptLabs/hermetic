// @hermetic/dev — Default HTML template for preview

export function createHtmlTemplate(options: {
  code: string;
  css?: string;
  title?: string;
}): string {
  const { code, css, title = "Hermetic Preview" } = options;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  ${css ? `<style>${css}</style>` : ""}
</head>
<body>
  <div id="root"></div>
  <script type="module">
${code}
  </script>
</body>
</html>`;
}
