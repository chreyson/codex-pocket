function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function requestView(request, threadId, respond) {
  const article = element("article", "approval-request request-panel");
  article.dataset.token = request.token;
  article.dataset.type = request.type;
  const header = element("div", "approval-header");
  const title = element("h3", "", request.title);
  const status = element("span", "approval-state");
  header.append(title, status);
  article.append(header);
  if (request.reason) article.append(element("p", "request-description", request.reason));
  if (request.detail) {
    if (["command", "fileChange", "permissions", "network"].includes(request.type)) {
      const details = element("details", "request-details");
      details.append(element("summary", "", request.type === "command" ? "查看命令" : "查看访问范围"));
      details.append(element("pre", "approval-detail", request.detail));
      article.append(details);
    } else article.append(element("p", "request-description", request.detail));
  }
  const form = element("form", "request-form");
  const body = element("fieldset", "request-fields");
  const error = element("p", "request-error");
  error.hidden = true;
  error.setAttribute("role", "alert");
  const actions = element("div", "approval-actions request-actions");
  form.append(body, error, actions);
  article.append(form);
  let submitting = false;
  let sent = false;
  let offline = false;
  let current = request;
  const buttons = [];
  function update(next = current, unavailable = offline) {
    current = next;
    offline = unavailable;
    const busy = submitting || sent || current.responding;
    article.dataset.state = busy ? "processing" : "pending";
    article.setAttribute("aria-busy", String(busy));
    status.textContent = submitting ? "正在提交" : busy ? "已提交，等待继续" : offline ? "等待连接" : request.type === "userInput" && !request.isBlocking ? "可稍后回答" : "等待你确认";
    body.disabled = Boolean(busy);
    for (const button of buttons) button.disabled = Boolean(busy || offline);
  }
  async function submit(payload) {
    if (submitting || sent || current.responding || offline) return;
    error.hidden = true;
    submitting = true;
    update();
    try {
      await respond(threadId, request.token, payload);
      sent = true;
      // Secret answers live only in these inputs; clear them immediately on delivery.
      for (const input of body.querySelectorAll('input[type="password"]')) input.value = "";
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      submitting = false;
      update();
    }
  }
  function button(label, action, primary = false) {
    const node = element("button", `approval-button ${primary ? "primary" : "secondary"}`, label);
    node.type = "button";
    node.addEventListener("click", action);
    actions.append(node);
    buttons.push(node);
    return node;
  }

  if (request.type === "userInput") {
    const pages = [];
    const readers = [];
    let page = 0;
    const progress = element("span", "request-progress");
    for (const [index, question] of request.questions.entries()) {
      const section = element("fieldset", "request-question");
      section.append(element("legend", "request-question-title", question.question));
      const options = element("div", "request-options");
      const radios = [];
      const input = element(question.isSecret ? "input" : "textarea", "request-answer");
      if (question.isSecret) { input.type = "password"; input.autocomplete = "off"; }
      else input.rows = 2;
      input.maxLength = 12000;
      input.placeholder = question.options.length ? "补充你的想法" : "输入回答";
      input.setAttribute("aria-label", question.question);
      for (const [i, option] of question.options.entries()) {
        const label = element("label", "request-option");
        const radio = element("input", "");
        radio.type = "radio";
        radio.name = `${request.token}-${index}`;
        radio.value = option.label;
        radio.checked = i === 0;
        radio.addEventListener("change", () => { input.value = ""; });
        const copy = element("span", "request-option-copy");
        copy.append(element("span", "request-option-label", option.label));
        if (option.description) copy.append(element("span", "request-option-description", option.description));
        label.append(radio, copy);
        options.append(label);
        radios.push(radio);
      }
      input.addEventListener("input", () => { if (input.value) for (const radio of radios) radio.checked = false; });
      section.append(options, input);
      body.append(section);
      pages.push(section);
      readers.push(() => input.value.trim() ? input.value : radios.find((r) => r.checked)?.value || "");
    }
    const previous = button("上一题", () => { page--; showPage(); });
    actions.append(progress);
    if (!request.isBlocking) button("跳过", () => submit({ skip: true }));
    const next = button("继续", advance, true);
    function showPage() {
      pages.forEach((section, i) => { section.hidden = i !== page; });
      previous.hidden = page === 0;
      progress.textContent = pages.length > 1 ? `${page + 1} / ${pages.length}` : "";
      next.textContent = page === pages.length - 1 ? "提交回答" : "下一题";
      error.hidden = true;
    }
    function advance() {
      if (!readers[page]?.().trim()) {
        error.textContent = "请填写回答";
        error.hidden = false;
        pages[page]?.querySelector("textarea, input")?.focus();
        return;
      }
      if (page < pages.length - 1) { page++; showPage(); return; }
      const answers = Object.fromEntries(request.questions.map((question, i) => [question.id, { answers: [readers[i]()] }]));
      submit({ answers });
    }
    form.addEventListener("submit", (event) => { event.preventDefault(); advance(); });
    showPage();
  } else if (request.type === "elicitation") {
    const readers = new Map();
    if (!request.supported) body.append(element("p", "request-description", "此表单暂不支持在网页填写，可以拒绝或取消。"));
    if (request.url) {
      const link = element("a", "request-link", "打开授权页面");
      link.href = request.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      body.append(link, element("p", "request-option-description", new URL(request.url).host));
    }
    for (const field of request.fields || []) {
      const group = element("div", "request-field");
      const label = element("label", "request-field-label", `${field.label}${field.required ? " *" : ""}`);
      let input;
      if (field.options) {
        input = element("select", "request-answer");
        input.multiple = field.type === "array";
        if (!input.multiple) { const empty = element("option", "", "请选择"); empty.value = ""; empty.disabled = true; input.append(empty); }
        for (const option of field.options) {
          const node = element("option", "", option.label);
          node.value = option.value;
          node.selected = input.multiple ? field.default?.includes(option.value) : field.default === option.value;
          input.append(node);
        }
      } else {
        input = element("input", field.type === "boolean" ? "request-checkbox" : "request-answer");
        input.type = field.type === "boolean" ? "checkbox" : ["number", "integer"].includes(field.type) ? "number" : field.format === "email" ? "email" : "text";
        if (input.type === "number") input.step = field.type === "integer" ? "1" : "any";
        if (field.type === "boolean") input.checked = field.default === true;
        else if (field.default != null) input.value = String(field.default);
        for (const [key, attr] of [["minimum", "min"], ["maximum", "max"], ["minLength", "minlength"], ["maxLength", "maxlength"]]) {
          if (field[key] != null) input.setAttribute(attr, String(field[key]));
        }
      }
      input.name = field.id;
      input.required = field.required && field.type !== "boolean";
      input.autocomplete = "off";
      readers.set(field.id, () => {
        if (field.type === "boolean") return input.checked;
        if (field.type === "array") {
          const selected = [...input.selectedOptions].map((o) => o.value);
          return selected.length || field.required ? selected : undefined;
        }
        if (!input.value && !field.required) return undefined;
        return ["number", "integer"].includes(field.type) ? Number(input.value) : input.value;
      });
      label.append(input);
      group.append(label);
      if (field.description) group.append(element("p", "request-option-description", field.description));
      body.append(group);
    }
    function send(action) {
      if (action === "accept" && !form.reportValidity()) return;
      const content = Object.fromEntries([...readers].map(([id, read]) => [id, read()]).filter(([, value]) => value !== undefined));
      submit({ action, ...(request.mode === "url" ? {} : { content }) });
    }
    for (const choice of request.choices) button(choice.label, () => send(choice.id), choice.id === "accept");
    form.addEventListener("submit", (event) => { event.preventDefault(); if (request.supported) send("accept"); });
  } else {
    const choices = request.choices || (request.type === "unsupported" ? [] : [{ id: "accept", label: "允许一次" }, { id: "decline", label: "拒绝" }]);
    for (const [i, choice] of choices.entries()) {
      const control = button(choice.label, () => submit(request.choices ? { choice: choice.id } : { decision: choice.id }), i === 0);
      if (choice.detail) {
        control.title = `${choice.label}：${choice.detail}`;
        control.append(element("span", "request-choice-detail", choice.detail));
      }
    }
    form.addEventListener("submit", (event) => event.preventDefault());
  }
  return { article, update, threadId };
}

export function createRequestTray(tray, respond) {
  const views = new Map();
  let displayedThread = "";
  return {
    clear() { views.clear(); displayedThread = ""; tray.replaceChildren(); tray.hidden = true; },
    render(requests, threadId, offline = false) {
      if (displayedThread !== threadId) { tray.replaceChildren(); displayedThread = threadId; }
      const tokens = new Set(requests.map((r) => r.token));
      for (const [token, view] of views) {
        if (view.threadId === threadId && !tokens.has(token)) { view.article.remove(); views.delete(token); }
      }
      for (const request of requests) {
        let view = views.get(request.token);
        if (!view) { view = requestView(request, threadId, respond); views.set(request.token, view); }
        view.update(request, offline);
        if (view.article.parentNode !== tray) tray.append(view.article);
      }
      tray.hidden = requests.length === 0;
    },
  };
}
