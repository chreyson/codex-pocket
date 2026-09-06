const desktopApp = document.querySelector("#desktop-app");
const serviceButton = document.querySelector("#service-button");
const serviceButtonLabel = serviceButton.querySelector("span");
const statusDot = document.querySelector("#status-dot");
const statusText = document.querySelector("#status-text");
const publicUrl = document.querySelector("#public-url");
const accessKey = document.querySelector("#access-key");
const copyUrlButton = document.querySelector("#copy-url");
const openUrlButton = document.querySelector("#open-url");
const copyKeyButton = document.querySelector("#copy-key");
const errorBanner = document.querySelector("#error-banner");
const errorText = document.querySelector("#error-text");
const dismissErrorButton = document.querySelector("#dismiss-error");
const copyToast = document.querySelector("#copy-toast");
const copyToastText = document.querySelector("#copy-toast-text");
const connectionDescription = document.querySelector("#connection-description");
const connectionMode = document.querySelector("#connection-mode");
const connectionModeCurrent = document.querySelector("#connection-mode-current");
const connectionModeAdvice = document.querySelector("#connection-mode-advice");
const connectDesktopButton = document.querySelector("#connect-desktop");
const connectionQr = document.querySelector("#connection-qr");
const qrPlaceholder = document.querySelector("#qr-placeholder");
const copyQrButton = document.querySelector("#copy-qr");
const showQrButton = document.querySelector("#show-qr");
const closeQrButton = document.querySelector("#close-qr");
const qrDialog = document.querySelector("#qr-dialog");
const qrCopyStatus = document.querySelector("#qr-copy-status");
let renderedConnectionUrl = "";
let copyingQr = false;

let bridge = null;
let refreshTimer = null;
let refreshInFlight = false;
let serviceActionInFlight = false;
let copyToastTimer = null;
const copyButtonTimers = new WeakMap();
let currentState = {
  phase: "stopped",
  status: "正在连接桌面服务",
  publicUrl: "",
  accessKey: "",
  connectionUrl: "",
  busy: true,
  error: "",
  connectionMode: "unknown",
};

function setValue(element, value, fallback) {
  const text = value || fallback;
  if (element.textContent === text) return;
  element.textContent = text;
  element.dataset.empty = String(!value);
  element.title = value || "";
}

function renderConnectionQr() {
  const url = currentState.phase === "running" ? currentState.connectionUrl || "" : "";
  showQrButton.disabled = !url;
  if (!url && qrDialog.open) qrDialog.close();
  copyQrButton.disabled = !url || copyingQr;
  if (url && url === renderedConnectionUrl) return;
  renderedConnectionUrl = "";
  qrCopyStatus.textContent = "";
  connectionQr.hidden = true;
  connectionQr.removeAttribute("src");
  qrPlaceholder.hidden = false;
  qrPlaceholder.textContent = currentState.phase === "starting" ? "正在建立连接" : "服务未开启";
  if (!url) return;
  try {
    const qr = window.qrcode(0, "M");
    qr.addData(url, "Byte");
    qr.make();
    // Keep four clear modules around the code in both light and dark themes.
    connectionQr.src = qr.createDataURL(4, 16);
    connectionQr.hidden = false;
    qrPlaceholder.hidden = true;
    renderedConnectionUrl = url;
  } catch {
    copyQrButton.disabled = true;
    qrPlaceholder.textContent = "二维码暂不可用";
  }
}

function render(state) {
  currentState = { ...currentState, ...state };
  const phase = currentState.phase || "stopped";
  const running = phase === "running";
  const inFlight = phase === "starting" || phase === "stopping";
  const hasUrl = Boolean(currentState.publicUrl);
  const hasKey = Boolean(currentState.accessKey);

  desktopApp.setAttribute("aria-busy", String(inFlight));
  desktopApp.dataset.phase = phase;
  if (connectionDescription) connectionDescription.textContent = {
    stopped: "服务未开启",
    starting: "正在建立连接…",
    stopping: "正在断开连接…",
    running: "连接已就绪",
    error: "连接未完成",
  }[phase] || currentState.status;
  if (connectionMode) {
    const connection = running && currentState.desktopConnection || {
      label: running ? "待确认" : "未连接",
      advice: running ? "正在确认桌面 App 的实际连接。" : "启动服务后检测桌面连接。",
    };
    connectionMode.textContent = connection.label;
    connectionMode.dataset.mode = running ? connection.state || "unknown" : "unknown";
    if (connectionModeCurrent && connectionModeAdvice) {
      connectionModeCurrent.textContent = connection.label;
      connectionModeAdvice.textContent = connection.advice;
    }
    if (connectDesktopButton) {
      connectDesktopButton.hidden = !running || currentState.connectionMode !== "shared" || connection.state === "shared";
      connectDesktopButton.disabled = !bridge || Boolean(currentState.desktopConnecting);
      connectDesktopButton.textContent = currentState.desktopConnecting ? "正在确认连接…" : "连接桌面 App";
    }
  }
  statusDot.dataset.phase = phase;
  statusText.textContent = currentState.status || "服务已停止";
  statusText.title = statusText.textContent;
  setValue(publicUrl, currentState.publicUrl, inFlight ? "正在生成公网链接" : "服务启动后生成");
  setValue(accessKey, currentState.accessKey, inFlight ? "正在生成访问密钥" : "服务启动后生成");

  serviceButton.classList.toggle("primary", !running);
  serviceButton.classList.toggle("secondary", running);
  serviceButton.disabled = !bridge || phase === "stopping";
  serviceButtonLabel.textContent = running
    ? "停止服务"
    : phase === "starting" ? "取消启动" : phase === "error" ? "重新开启" : "开启服务";

  copyUrlButton.disabled = !hasUrl;
  openUrlButton.disabled = !hasUrl;
  copyKeyButton.disabled = !hasKey;
  renderConnectionQr();
  errorText.textContent = currentState.error || "";
  errorBanner.hidden = !currentState.error;
}

async function refresh() {
  if (!bridge || refreshInFlight || serviceActionInFlight) return;
  refreshInFlight = true;
  try {
    const next = await bridge.get_state();
    if (Object.keys(next).some((key) => next[key] !== currentState[key])) render(next);
  } catch {
    render({
      phase: "error",
      status: "桌面服务已断开",
      busy: false,
      error: "无法连接桌面控制服务，请重新打开 Codex Pocket。",
    });
  } finally {
    refreshInFlight = false;
  }
}

async function connectBridge() {
  bridge = window.pywebview?.api || null;
  if (!bridge) return;
  serviceButton.disabled = false;
  await refresh();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, 450);
}

connectDesktopButton?.addEventListener("click", async () => {
  if (!bridge || currentState.desktopConnecting) return;
  render({ desktopConnecting: true });
  try {
    render(await bridge.connect_desktop());
  } catch {
    render({ desktopConnecting: false, error: "无法连接桌面 App，请重试。" });
  }
});

serviceButton.addEventListener("click", async () => {
  if (!bridge || serviceActionInFlight) return;
  serviceActionInFlight = true;
  serviceButton.disabled = true;
  try {
    if (currentState.phase === "running" || currentState.phase === "starting") {
      render(await bridge.stop_service());
    } else {
      render(await bridge.start_service());
    }
  } catch {
    render({
      phase: "error",
      status: "桌面服务调用失败",
      busy: false,
      error: "无法控制本地服务，请重新打开 Codex Pocket。",
    });
  } finally {
    serviceActionInFlight = false;
  }
});

function showCopyToast(message, tone = "success") {
  clearTimeout(copyToastTimer);
  copyToastText.textContent = message;
  copyToast.dataset.tone = tone;
  copyToast.hidden = false;
  requestAnimationFrame(() => {
    copyToast.dataset.visible = "true";
  });
  copyToastTimer = setTimeout(() => {
    copyToast.dataset.visible = "false";
    copyToastTimer = setTimeout(() => {
      copyToast.hidden = true;
      copyToastTimer = null;
    }, 160);
  }, 1_800);
}

function markCopyButton(button, label) {
  clearTimeout(copyButtonTimers.get(button));
  button.dataset.copied = "true";
  button.setAttribute("aria-label", `${label}已复制`);
  button.title = `${label}已复制`;
  copyButtonTimers.set(button, setTimeout(() => {
    delete button.dataset.copied;
    button.setAttribute("aria-label", `复制${label}`);
    button.title = `复制${label}`;
    copyButtonTimers.delete(button);
  }, 1_800));
}

async function copy(value, label, button) {
  if (!bridge || !value) return;
  try {
    const copied = await bridge.copy_text(value);
    if (copied === false) throw new Error("copy failed");
    markCopyButton(button, label);
    showCopyToast(`${label}已复制`);
  } catch {
    showCopyToast(`${label}复制失败`, "error");
  }
}

copyUrlButton.addEventListener("click", () => {
  copy(currentState.publicUrl, "公网链接", copyUrlButton);
});
copyKeyButton.addEventListener("click", () => {
  copy(currentState.accessKey, "访问密钥", copyKeyButton);
});
showQrButton.addEventListener("click", () => {
  if (currentState.phase !== "running" || !currentState.connectionUrl || qrDialog.open) return;
  qrCopyStatus.textContent = "";
  qrDialog.showModal();
});
closeQrButton.addEventListener("click", () => qrDialog.close());
qrDialog.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  const controls = [copyQrButton, closeQrButton].filter((button) => !button.disabled);
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === document.querySelector("#scan-label"))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
qrDialog.addEventListener("click", (event) => {
  if (event.target !== qrDialog) return;
  const rect = qrDialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) qrDialog.close();
});
qrDialog.addEventListener("close", () => {
  if (!showQrButton.disabled) showQrButton.focus();
  else serviceButton.focus();
});

copyQrButton.addEventListener("click", async () => {
  if (!bridge || copyingQr || currentState.phase !== "running" || !renderedConnectionUrl) return;
  const url = renderedConnectionUrl;
  copyingQr = true;
  copyQrButton.disabled = true;
  try {
    await connectionQr.decode();
    if (currentState.phase !== "running" || renderedConnectionUrl !== url) return;
    const canvas = document.createElement("canvas");
    canvas.width = connectionQr.naturalWidth;
    canvas.height = connectionQr.naturalHeight;
    canvas.getContext("2d").drawImage(connectionQr, 0, 0);
    const copied = await bridge.copy_qr_image(url, canvas.toDataURL("image/png"));
    if (!copied) throw new Error("copy failed");
    if (renderedConnectionUrl === url) markCopyButton(copyQrButton, "二维码");
    qrCopyStatus.textContent = "二维码已复制";
  } catch {
    qrCopyStatus.textContent = "二维码复制失败";
  } finally {
    copyingQr = false;
    copyQrButton.disabled = currentState.phase !== "running" || !renderedConnectionUrl;
  }
});
openUrlButton.addEventListener("click", async () => {
  if (bridge && currentState.publicUrl) await bridge.open_url(currentState.publicUrl);
});
dismissErrorButton.addEventListener("click", async () => {
  if (!bridge) return;
  render(await bridge.dismiss_error());
});

window.addEventListener("pywebviewready", connectBridge);
if (window.pywebview?.api) connectBridge();
render(currentState);
