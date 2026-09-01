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
  busy: true,
  error: "",
};

function setValue(element, value, fallback) {
  element.textContent = value || fallback;
  element.dataset.empty = String(!value);
  element.title = value || "";
}

function render(state) {
  currentState = { ...currentState, ...state };
  const phase = currentState.phase || "stopped";
  const running = phase === "running";
  const inFlight = phase === "starting" || phase === "stopping";
  const hasUrl = Boolean(currentState.publicUrl);
  const hasKey = Boolean(currentState.accessKey);

  desktopApp.setAttribute("aria-busy", String(inFlight));
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
  errorText.textContent = currentState.error || "";
  errorBanner.hidden = !currentState.error;
}

async function refresh() {
  if (!bridge || refreshInFlight || serviceActionInFlight) return;
  refreshInFlight = true;
  try {
    render(await bridge.get_state());
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
