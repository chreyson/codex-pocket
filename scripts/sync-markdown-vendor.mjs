import fs from "node:fs/promises";

const root = new URL("../", import.meta.url);
const files = [
  ["node_modules/marked/lib/marked.esm.js", "public/vendor/marked.js"],
  ["node_modules/marked/LICENSE", "public/vendor/marked.LICENSE"],
  ["node_modules/dompurify/dist/purify.es.mjs", "public/vendor/dompurify.js"],
  ["node_modules/dompurify/LICENSE", "public/vendor/dompurify.LICENSE"],
];
await fs.mkdir(new URL("public/vendor/", root), { recursive: true });
for (const [source, target] of files) await fs.copyFile(new URL(source, root), new URL(target, root));
