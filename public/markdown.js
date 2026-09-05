import { Marked } from "./vendor/marked.js";
import DOMPurify from "./vendor/dompurify.js";

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

const markdown = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    // Attachments have their own viewer; Markdown must not load remote images.
    image: ({ text }) => escapeHtml(text || "图片"),
  },
});

export function renderMarkdown(element, source) {
  const fragment = DOMPurify.sanitize(markdown.parse(source), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ["p", "br", "strong", "em", "del", "a", "ul", "ol", "li", "input", "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "th", "td"],
    ALLOWED_ATTR: ["href", "title", "start", "checked", "disabled", "type", "class", "align"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  for (const link of fragment.querySelectorAll("a")) {
    const href = link.getAttribute("href");
    try {
      const url = new URL(href, document.baseURI);
      if (!href || !["http:", "https:", "mailto:"].includes(url.protocol)) throw new Error("Unsupported link");
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    } catch {
      link.removeAttribute("href");
    }
  }
  for (const input of fragment.querySelectorAll("input")) {
    input.type = "checkbox";
    input.disabled = true;
  }
  for (const table of fragment.querySelectorAll("table")) {
    const scroll = document.createElement("div");
    scroll.className = "markdown-table-scroll";
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "表格");
    table.replaceWith(scroll);
    scroll.append(table);
  }
  for (const pre of fragment.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    const block = document.createElement("div");
    block.className = "markdown-code-block";
    const toolbar = document.createElement("div");
    toolbar.className = "markdown-code-toolbar";
    const language = document.createElement("span");
    language.textContent = code?.className.replace(/^language-/, "") || "";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "markdown-copy";
    copy.title = "复制代码";
    copy.setAttribute("aria-label", "复制代码");
    copy.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code?.textContent || "");
        copy.title = "已复制";
        copy.setAttribute("aria-label", "已复制");
      } catch {
        copy.title = "复制失败";
        copy.setAttribute("aria-label", "复制失败");
      }
    });
    toolbar.append(language, copy);
    pre.replaceWith(block);
    block.append(toolbar, pre);
    pre.tabIndex = 0;
  }
  element.replaceChildren(fragment);
}
