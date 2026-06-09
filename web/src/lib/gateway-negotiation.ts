import type {
  ConnectionState,
  GatewayClientLike,
  GatewayConnectOptions,
  GatewayRequestOptions,
  GatewayTransport,
} from "./gateway-client";
import type { GatewayEvent } from "@hermes/protocol";

/**
 * Transport auto-negotiation: WebSocket-first with automatic SSE fallback.
 *
 * Why this exists
 * ---------------
 * The official Hermes desktop connects to the runtime dashboard over a single
 * JSON-RPC WebSocket (`/api/ws`) — one ordered channel, no per-RPC HTTP round
 * trip, no async-ack split. Our Tauri desktop historically forced the fork-only
 * SSE+POST transport (P-009) through a Rust proxy, which is the main source of
 * the chat-latency / message-ordering complaints. The runtime serves `/api/ws`
 * natively and our `tauri.conf.json` CSP already allows `ws://127.0.0.1:*`, so
 * the webview *should* be able to connect directly.
 *
 * The one thing we cannot prove offline is whether a *packaged* webview
 * (macOS WKWebView via `tauri://`, Windows WebView2 via `http://tauri.localhost`)
 * actually completes the `ws://127.0.0.1` upgrade — WKWebView may treat `ws://`
 * from the custom scheme as mixed content. So instead of a hard flip (which would
 * risk a black-screen on platforms where the webview blocks WS), we probe WS on
 * the first connect and fall back to the proven SSE path if it doesn't come up
 * healthy. The decision is sticky-persisted by the caller so subsequent launches
 * skip the probe. This is safe-by-construction: the floor is always today's SSE.
 *
 * See docs/gateway-connection-overhaul.md (P1).
 */

const DEFAULT_PROBE_CONNECT_TIMEOUT_MS = 4_000;
// After the socket reports "open" we wait briefly to make sure it *stays* open —
// guards the post-handshake-reject case (upgrade succeeds, then the server closes
// the socket), which would otherwise commit us to a flapping WS.
const DEFAULT_PROBE_STABILITY_MS = 1_200;

export interface NegotiationDeps {
  makeWs: () => GatewayClientLike;
  makeSse: () => GatewayClientLike;
  /** Persist the decided transport so the next launch skips the probe. */
  persist: (transport: GatewayTransport) => void;
  probeConnectTimeoutMs?: number;
  stabilityMs?: number;
  // Injectable timers keep the probe deterministic under unit tests.
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onDecision?: (transport: GatewayTransport) => void;
}

/**
 * A GatewayClientLike that starts on WS, probes it on the first connect, and
 * transparently swaps to an SSE client if the probe fails. All listeners are
 * registered on the wrapper and re-forwarded across the swap, so callers
 * (use-gateway.ts) never observe the transition beyond ordinary state changes.
 */
export class NegotiatingGatewayClient implements GatewayClientLike {
  private inner: GatewayClientLike;
  private phase: "probing" | "committed" = "probing";
  private decided: GatewayTransport | null = null;
  private autoReconnectWanted = false;
  private connectPromise: Promise<void> | null = null;
  // Mirrors the inner clients' invariant: an intentional close() must never lead
  // to an auto-reconnect. Without this, a close() landing mid-probe would still
  // fall through to fallbackToSse() and bring up a live SSE connection.
  private intentionalClose = false;

  private readonly stateListeners = new Set<(s: ConnectionState) => void>();
  private readonly anyListeners = new Set<(e: GatewayEvent) => void>();
  private readonly typedListeners = new Map<string, Set<(e: GatewayEvent) => void>>();
  private innerUnsubs: Array<() => void> = [];

  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly probeConnectTimeoutMs: number;
  private readonly stabilityMs: number;

  constructor(private readonly deps: NegotiationDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.probeConnectTimeoutMs = deps.probeConnectTimeoutMs ?? DEFAULT_PROBE_CONNECT_TIMEOUT_MS;
    this.stabilityMs = deps.stabilityMs ?? DEFAULT_PROBE_STABILITY_MS;
    this.inner = deps.makeWs();
    this.attachInner();
  }

  get state(): ConnectionState {
    return this.inner.state;
  }

  get activeTransport(): GatewayTransport | null {
    return this.decided;
  }

  private attachInner(): void {
    this.innerUnsubs.push(
      this.inner.onState((s) => this.stateListeners.forEach((cb) => cb(s))),
    );
    this.innerUnsubs.push(
      this.inner.onAny((e) => {
        this.anyListeners.forEach((cb) => cb(e));
        const typed = this.typedListeners.get(e.type);
        if (typed) typed.forEach((cb) => cb(e));
      }),
    );
  }

  private detachInner(): void {
    for (const unsub of this.innerUnsubs) {
      try { unsub(); } catch { /* listener teardown must not throw */ }
    }
    this.innerUnsubs = [];
  }

  onState(cb: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  onAny(cb: (e: GatewayEvent) => void): () => void {
    this.anyListeners.add(cb);
    return () => this.anyListeners.delete(cb);
  }

  on(type: string, cb: (e: GatewayEvent) => void): () => void {
    let set = this.typedListeners.get(type);
    if (!set) {
      set = new Set();
      this.typedListeners.set(type, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  enableAutoReconnect(): void {
    this.autoReconnectWanted = true;
    // During the probe we manage reconnect ourselves; only hand control to the
    // inner client once a transport is committed.
    if (this.phase === "committed") this.inner.enableAutoReconnect();
  }

  disableAutoReconnect(): void {
    this.autoReconnectWanted = false;
    this.inner.disableAutoReconnect();
  }

  forceReconnect(reason?: string): void {
    this.inner.forceReconnect(reason);
  }

  close(): void {
    this.intentionalClose = true;
    this.inner.close();
  }

  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: GatewayRequestOptions | number,
  ): Promise<T> {
    await this.connect();
    return this.inner.request<T>(method, params, options);
  }

  async connect(options?: GatewayConnectOptions | number): Promise<void> {
    if (this.phase === "committed") return this.inner.connect(options);
    if (this.connectPromise) return this.connectPromise;
    // A fresh connect attempt clears any prior close intent.
    this.intentionalClose = false;
    this.connectPromise = this.negotiate(options).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async negotiate(options?: GatewayConnectOptions | number): Promise<void> {
    // Probe WS with a short timeout and WITHOUT auto-retry — a failed probe must
    // surface fast so we can fall back, not loop on WS forever.
    this.inner.disableAutoReconnect();
    try {
      await this.inner.connect({ timeoutMs: this.probeConnectTimeoutMs });
    } catch {
      return this.fallbackToSse(options);
    }
    if (this.intentionalClose) return;        // closed mid-probe → honor it, no fallback
    const stayedOpen = await this.waitStable();
    if (this.intentionalClose) return;        // closed during the stability window
    if (!stayedOpen) {
      return this.fallbackToSse(options);
    }
    this.commit("ws");
    if (this.autoReconnectWanted) this.inner.enableAutoReconnect();
  }

  private async fallbackToSse(options?: GatewayConnectOptions | number): Promise<void> {
    // If the wrapper was intentionally closed during the probe, don't resurrect
    // the connection via SSE — preserve close() semantics.
    if (this.intentionalClose) {
      try { this.inner.close(); } catch { /* best-effort */ }
      return;
    }
    try { this.inner.close(); } catch { /* best-effort */ }
    this.detachInner();
    this.inner = this.deps.makeSse();
    this.attachInner();
    this.commit("sse");
    if (this.autoReconnectWanted) this.inner.enableAutoReconnect();
    await this.inner.connect(options);
  }

  private commit(transport: GatewayTransport): void {
    this.phase = "committed";
    this.decided = transport;
    try { this.deps.persist(transport); } catch { /* persistence is best-effort */ }
    this.deps.onDecision?.(transport);
  }

  // Resolve true if the socket is still open after the stability window; false
  // if it leaves "open" before then (post-handshake reject / instant flap).
  private waitStable(): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.inner.state !== "open") {
        resolve(false);
        return;
      }
      let settled = false;
      let timer: unknown;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        try { unsub(); } catch { /* noop */ }
        this.clearTimer(timer);
        resolve(ok);
      };
      const unsub = this.inner.onState((s) => {
        if (s !== "open") finish(false);
      });
      timer = this.setTimer(() => finish(true), this.stabilityMs);
    });
  }
}
