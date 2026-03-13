(function bootstrapPwaManager() {
  const elements = {
    installStatus: document.getElementById("install-status"),
    installMessage: document.getElementById("install-message"),
    installAppBtn: document.getElementById("install-app-btn"),
    iosInstallHint: document.getElementById("ios-install-hint"),
    offlineNotice: document.getElementById("offline-notice"),
    secureContextNote: document.getElementById("secure-context-note"),
    deviceLabel: document.getElementById("device-label"),
  };

  if (!elements.installStatus || !elements.installMessage || !elements.installAppBtn) {
    return;
  }

  const state = {
    device: detectDevice(),
    deferredPrompt: null,
    isStandalone: checkStandaloneMode(),
    isInstalled: checkStandaloneMode(),
    isIos: detectIos(),
  };

  init();

  async function init() {
    elements.installAppBtn.addEventListener("click", handleInstallClick);

    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      state.deferredPrompt = event;
      render();
    });

    window.addEventListener("appinstalled", () => {
      state.deferredPrompt = null;
      state.isInstalled = true;
      state.isStandalone = true;
      render();
    });

    window.addEventListener("online", render);
    window.addEventListener("offline", render);

    if ("serviceWorker" in navigator && window.isSecureContext) {
      try {
        await navigator.serviceWorker.register("/service-worker.js");
      } catch (error) {
        console.warn("Service worker registration failed", error);
      }
    }

    render();
  }

  async function handleInstallClick() {
    if (!state.deferredPrompt) {
      render();
      return;
    }

    const promptEvent = state.deferredPrompt;
    state.deferredPrompt = null;
    await promptEvent.prompt();

    try {
      await promptEvent.userChoice;
    } catch {
      // Ignore prompt outcome inspection failures.
    }

    render();
  }

  function render() {
    state.isStandalone = checkStandaloneMode();
    state.isInstalled = state.isInstalled || state.isStandalone;

    elements.deviceLabel.textContent = formatDeviceLabel(state.device);
    elements.offlineNotice.classList.toggle("hidden", navigator.onLine);
    elements.secureContextNote.classList.toggle("hidden", window.isSecureContext);

    const iosHintVisible = state.isIos && !state.isInstalled;
    elements.iosInstallHint.classList.toggle("hidden", !iosHintVisible);

    if (state.isInstalled) {
      elements.installStatus.textContent = "Installed";
      elements.installStatus.className = "status-pill saved";
      elements.installMessage.textContent = "Already installed. Open it from your home screen, desktop, or app launcher for a faster app-like experience.";
      elements.installAppBtn.hidden = true;
      return;
    }

    if (state.deferredPrompt) {
      elements.installStatus.textContent = "Install Available";
      elements.installStatus.className = "status-pill downloading";
      elements.installMessage.textContent = "Install this tool on your home screen for faster access and standalone app mode.";
      elements.installAppBtn.hidden = false;
      return;
    }

    elements.installStatus.textContent = "Not Installed";
    elements.installStatus.className = "status-pill pending";
    elements.installMessage.textContent = state.isIos
      ? "Safari on iPhone and iPad uses Add to Home Screen manually."
      : "Open this app over HTTPS in Chrome or Edge to enable the install prompt on supported devices.";
    elements.installAppBtn.hidden = true;
  }

  function detectDevice() {
    const userAgent = navigator.userAgent.toLowerCase();
    if (/android/.test(userAgent)) {
      return "android";
    }
    if (detectIos()) {
      return "ios";
    }
    return "desktop";
  }

  function detectIos() {
    const userAgent = navigator.userAgent.toLowerCase();
    return /iphone|ipad|ipod/.test(userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function checkStandaloneMode() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  function formatDeviceLabel(device) {
    if (device === "android") {
      return "Android";
    }
    if (device === "ios") {
      return "iPhone / iPad";
    }
    return "Desktop";
  }
})();
