(() => {
  const key = "codex-pocket.theme";
  const root = document.documentElement;
  const desktop = root.dataset.themeStorage === "desktop";
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const normalize = (value) => ["system", "light", "dark"].includes(value) ? value : "system";
  let preference = "system";
  let nativeBridge = null;
  let saveQueue = Promise.resolve();

  try {
    preference = normalize(desktop
      ? new URLSearchParams(location.search).get("theme")
      : localStorage.getItem(key));
  } catch {}

  function apply(value) {
    preference = normalize(value);
    const resolved = preference === "system" ? (system.matches ? "dark" : "light") : preference;
    root.dataset.theme = resolved;
    root.dataset.themePreference = preference;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#212121" : "#ffffff");
    document.querySelectorAll("[data-theme-picker]").forEach((picker) => {
      picker.checked = picker.value === preference;
    });
  }

  function reportSaveError(failed) {
    document.querySelectorAll("[data-theme-error]").forEach((element) => {
      element.hidden = !failed;
    });
  }

  async function connectDesktop() {
    const api = window.pywebview?.api;
    if (!api?.get_theme || nativeBridge) return;
    nativeBridge = api;
    try {
      apply(await api.get_theme());
      document.querySelectorAll("[data-theme-picker]").forEach((picker) => { picker.disabled = false; });
    } catch {
      nativeBridge = null;
      reportSaveError(true);
    }
  }

  apply(preference);
  system.addEventListener("change", () => {
    if (preference === "system") apply(preference);
  });
  window.addEventListener("storage", (event) => {
    if (!desktop && (event.key === key || event.key === null)) apply(event.newValue);
  });
  document.addEventListener("DOMContentLoaded", () => {
    const dialog = document.createElement("dialog");
    dialog.id = "appearance-settings";
    dialog.className = "appearance-settings";
    dialog.setAttribute("aria-labelledby", "settings-heading");
    dialog.innerHTML = `
      <header class="settings-header">
        <h2 id="settings-heading" tabindex="-1" autofocus>设置</h2>
        <button class="settings-button settings-icon-button" type="button" aria-label="关闭设置" title="关闭设置" data-settings-close><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m18 6-12 12M6 6l12 12"/></svg></button>
      </header>
      <div class="settings-content">
        <fieldset class="theme-options">
          <legend>外观</legend>
          <!-- Icons: Lucide v0.468.0, ISC; license in vendor/lucide/LICENSE. -->
          <label class="theme-option">
            <svg aria-hidden="true" viewBox="0 0 24 24"><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
            <span>跟随系统</span><input type="radio" name="appearance" value="system" data-theme-picker>
          </label>
          <label class="theme-option">
            <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41m14.14-14.14-1.41 1.41"/></svg>
            <span>浅色</span><input type="radio" name="appearance" value="light" data-theme-picker>
          </label>
          <label class="theme-option">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
            <span>深色</span><input type="radio" name="appearance" value="dark" data-theme-picker>
          </label>
        </fieldset>
        <p class="theme-error" data-theme-error role="status" hidden>外观设置未能保存</p>
      </div>`;
    document.body.append(dialog);
    let settingsOpener = null;
    document.querySelectorAll("[data-settings-button]").forEach((button) => {
      button.addEventListener("click", () => {
        settingsOpener = button;
        button.setAttribute("aria-expanded", "true");
        dialog.showModal();
      });
    });
    dialog.querySelector("[data-settings-close]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      const bounds = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
    });
    dialog.addEventListener("close", () => {
      settingsOpener?.setAttribute("aria-expanded", "false");
      settingsOpener?.focus();
    });
    apply(preference);
    document.querySelectorAll("[data-theme-picker]").forEach((picker) => {
      picker.disabled = desktop;
      picker.addEventListener("change", () => {
        if (!picker.checked) return;
        apply(picker.value);
        const value = preference;
        // Serialize native writes so quick changes cannot save an older selection last.
        saveQueue = saveQueue.then(async () => {
          try {
            if (desktop) await nativeBridge.set_theme(value);
            else localStorage.setItem(key, value);
            reportSaveError(false);
          } catch {
            reportSaveError(true);
          }
        });
      });
    });
    if (desktop) {
      window.addEventListener("pywebviewready", connectDesktop);
      void connectDesktop();
    }
  });
})();
