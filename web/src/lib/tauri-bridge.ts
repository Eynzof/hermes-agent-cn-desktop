// Tauri v2 IPC bridge.
//
// Wraps @tauri-apps/api/core::invoke() calls to match the hermesDesktop API
// surface. On initialization, populates window.hermesDesktop so that ALL
// existing call sites (settings.tsx, projects.tsx, goose-composer.tsx, etc.)
// work without any changes.

import type {
  ApiRequestInput,
  ApiRequestResult,
  FilePickerResult,
  FileUploadInput,
  RuntimeInfo,
  RuntimeInstallUpdateResult,
  RuntimeUpdateCheckResult,
  SwitchProfileInput,
  SwitchProfileResult,
} from "@hermes/protocol";

let invoke: typeof import("@tauri-apps/api/core").invoke;

export function isTauriDevMode(envDev = import.meta.env.DEV): boolean {
  return envDev;
}

async function ensureInvoke() {
  if (!invoke) {
    const mod = await import("@tauri-apps/api/core");
    invoke = mod.invoke;
  }
  return invoke;
}

const tauriBridge = {
  windowType: "electron" as const,

  async request(input: ApiRequestInput): Promise<ApiRequestResult> {
    const inv = await ensureInvoke();
    return inv("api_request", { input });
  },

  async externalRequest(input: ApiRequestInput): Promise<ApiRequestResult> {
    const inv = await ensureInvoke();
    return inv("external_request", { input });
  },

  async uploadFile(input: FileUploadInput): Promise<ApiRequestResult> {
    const inv = await ensureInvoke();
    const bytes = new Uint8Array(input.data);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    return inv("upload_file", {
      input: {
        sessionId: input.sessionId,
        name: input.name,
        type: input.type,
        data: base64,
      },
    });
  },

  async pickFiles(): Promise<FilePickerResult> {
    const inv = await ensureInvoke();
    return inv("pick_files");
  },

  async pickDirectory(): Promise<FilePickerResult> {
    const inv = await ensureInvoke();
    return inv("pick_directory");
  },

  async createWorkspaceProject(): Promise<FilePickerResult> {
    const inv = await ensureInvoke();
    return inv("create_workspace_project");
  },

  async openWorkspacePath(input: { path: string }): Promise<ApiRequestResult> {
    const inv = await ensureInvoke();
    return inv("open_workspace_path", { input });
  },

  getRuntimeConfig() {
    return window.__HERMES_RUNTIME__;
  },

  async refreshGatewayUrl(): Promise<{ gatewayUrl: string; sessionToken?: string }> {
    const inv = await ensureInvoke();
    return inv("refresh_gateway_url");
  },

  async getRuntimeInfo(): Promise<RuntimeInfo> {
    const inv = await ensureInvoke();
    return inv("runtime_info");
  },

  async checkRuntimeUpdate(): Promise<RuntimeUpdateCheckResult> {
    const inv = await ensureInvoke();
    return inv("runtime_check_update");
  },

  async installRuntimeUpdate(): Promise<RuntimeInstallUpdateResult> {
    const inv = await ensureInvoke();
    return inv("runtime_install_update");
  },

  async rollbackRuntime(): Promise<RuntimeInstallUpdateResult> {
    const inv = await ensureInvoke();
    return inv("runtime_rollback");
  },

  async switchProfile(input: SwitchProfileInput): Promise<SwitchProfileResult> {
    const inv = await ensureInvoke();
    return inv("switch_profile", { input });
  },

  onSystemResume(handler: () => void): () => void {
    // Initial build: rely on the JS clock-skew watchdog in gateway-client.ts.
    // The watchdog detects sleep/wake within ~5s, which is acceptable.
    // Native power monitoring can be added later via a Tauri event.
    let unlisten: (() => void) | null = null;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen("system-resume", handler).then((fn) => {
        unlisten = fn;
      });
    });
    return () => {
      unlisten?.();
    };
  },
};

// Overlay shown while the Rust side downloads the managed runtime on
// first launch. Pre-React, plain DOM — we can't mount React yet
// because the bridge isn't ready (no apiBaseUrl => API calls would
// throw). Phase strings match the `runtime-status` event emitted by
// src/main.rs::emit_runtime_status.
function showBootstrapOverlay(initialMessage: string): {
  update(phase: string, message: string): void;
  dismiss(): void;
} {
  const root = document.createElement("div");
  root.id = "hermes-bootstrap-overlay";
  root.setAttribute(
    "style",
    "position:fixed;inset:0;background:#0a0a0a;color:#fbfaf6;" +
      "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
      "font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "z-index:2147483647;gap:24px;padding:48px;",
  );

  // Block H mark — matches icons/icon.svg
  const mark = document.createElement("div");
  mark.setAttribute(
    "style",
    "width:96px;height:96px;background:#fbfaf6;color:#0a0a0a;border-radius:22px;" +
      "display:flex;align-items:center;justify-content:center;font-weight:700;" +
      "font-size:64px;letter-spacing:-0.04em;line-height:1;",
  );
  mark.textContent = "H";
  root.appendChild(mark);

  const message = document.createElement("div");
  message.id = "hermes-bootstrap-message";
  message.setAttribute(
    "style",
    "font-size:15px;color:#fbfaf6;text-align:center;max-width:480px;line-height:1.5;",
  );
  message.textContent = initialMessage;
  root.appendChild(message);

  const sub = document.createElement("div");
  sub.id = "hermes-bootstrap-sub";
  sub.setAttribute(
    "style",
    "font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;" +
      "color:rgba(255,255,255,0.45);letter-spacing:0.06em;text-transform:uppercase;",
  );
  sub.textContent = "Hermes Agent CN · 首次启动";
  root.appendChild(sub);

  document.body.appendChild(root);

  return {
    update(phase, msg) {
      message.textContent = msg || message.textContent;
      if (phase === "error") {
        mark.style.background = "#c96b3a";
        sub.textContent = "首次启动失败";
      }
    },
    dismiss() {
      root.remove();
    },
  };
}

async function waitForBootstrap(initialMessage: string): Promise<{ failed: boolean; message: string }> {
  const overlay = showBootstrapOverlay(initialMessage);
  const { listen } = await import("@tauri-apps/api/event");

  return new Promise((resolve) => {
    let unlisten: (() => void) | null = null;
    listen<{ phase: string; message: string }>("runtime-status", (event) => {
      const { phase, message } = event.payload;
      overlay.update(phase, message);
      if (phase === "ready") {
        unlisten?.();
        overlay.dismiss();
        resolve({ failed: false, message: "" });
      } else if (phase === "error") {
        // Leave the overlay up so the user sees the error message; the
        // process keeps running so they can read it. They'll need to
        // close + relaunch (or fix the env / hit a "retry" button we
        // add later).
        unlisten?.();
        resolve({ failed: true, message });
      }
    }).then((fn) => {
      unlisten = fn;
    });
  });
}

export async function installTauriBridge(): Promise<void> {
  const inv = await ensureInvoke();
  let config = await inv<{
    apiBaseUrl: string;
    gatewayUrl: string;
    sessionToken?: string;
    currentProfile: string;
    transport?: string;
  }>("get_runtime_config");

  // Dev mode: WebView loads from Vite dev server (http://localhost:9545).
  // Don't set apiBaseUrl/gatewayUrl — let the browser use relative URLs that
  // go through Vite's proxy, just like web mode. This avoids cross-origin
  // issues with SSE EventSource and WebSocket (browser-native APIs that can't
  // go through the Tauri IPC bridge).
  // Production Tauri v2 can also load bundled assets from an
  // `http://*.localhost` origin on Windows, so URL protocol is not a
  // reliable dev/prod signal. Use Vite's explicit build mode instead.
  const isDevMode = isTauriDevMode();

  // First-run in prod: Rust spawned the install task and returned
  // immediately with empty state. Show the overlay and block here
  // until the `runtime-status` event reports `ready`, then refetch
  // the config so we get the populated apiBaseUrl/sessionToken.
  if (!isDevMode && !config.apiBaseUrl) {
    const result = await waitForBootstrap("正在下载 hermes-agent-cn runtime...");
    if (result.failed) {
      // Leave the overlay up — the user needs to see the message
      // and decide what to do (close and reopen, fix env vars, etc).
      // Throwing here would surface in the React error boundary, but
      // we never mounted React; the overlay IS the UI right now.
      throw new Error(`runtime bootstrap failed: ${result.message}`);
    }
    config = await inv("get_runtime_config");
  }

  const transport = (config.transport === "ws" || config.transport === "sse")
    ? config.transport
    : "sse";

  window.__HERMES_RUNTIME__ = {
    platform: "tauri" as const,
    apiBaseUrl: isDevMode ? undefined : config.apiBaseUrl,
    gatewayUrl: isDevMode ? undefined : config.gatewayUrl,
    sessionToken: isDevMode ? undefined : config.sessionToken,
    currentProfile: config.currentProfile,
    transport,
  };

  (window as any).hermesDesktop = tauriBridge;
}
