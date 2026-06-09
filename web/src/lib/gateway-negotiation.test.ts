import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NegotiatingGatewayClient } from "./gateway-negotiation";
import type { ConnectionState, GatewayClientLike, GatewayConnectOptions, GatewayRequestOptions } from "./gateway-client";
import type { GatewayEvent } from "@hermes/protocol";

class MockClient implements GatewayClientLike {
  state: ConnectionState = "idle";
  autoReconnect = false;
  closed = false;
  connectCalls = 0;
  connectBehavior: "open" | "reject" = "open";
  requestImpl = vi.fn(
    async (_method: string, _params?: Record<string, unknown>, _options?: GatewayRequestOptions | number) => ({ ok: true }),
  );

  private stateCbs = new Set<(s: ConnectionState) => void>();
  private anyCbs = new Set<(e: GatewayEvent) => void>();
  private typedCbs = new Map<string, Set<(e: GatewayEvent) => void>>();

  setState(s: ConnectionState): void {
    this.state = s;
    this.stateCbs.forEach((cb) => cb(s));
  }
  emit(e: GatewayEvent): void {
    this.anyCbs.forEach((cb) => cb(e));
    this.typedCbs.get(e.type)?.forEach((cb) => cb(e));
  }

  async connect(_options?: GatewayConnectOptions | number): Promise<void> {
    this.connectCalls += 1;
    if (this.connectBehavior === "reject") {
      this.setState("error");
      throw new Error("connect failed");
    }
    this.setState("open");
  }
  request<T = unknown>(method: string, params?: Record<string, unknown>, options?: GatewayRequestOptions | number): Promise<T> {
    return this.requestImpl(method as never, params as never, options as never) as Promise<T>;
  }
  on(type: string, cb: (e: GatewayEvent) => void): () => void {
    let s = this.typedCbs.get(type);
    if (!s) { s = new Set(); this.typedCbs.set(type, s); }
    s.add(cb);
    return () => s!.delete(cb);
  }
  onAny(cb: (e: GatewayEvent) => void): () => void {
    this.anyCbs.add(cb);
    return () => this.anyCbs.delete(cb);
  }
  onState(cb: (s: ConnectionState) => void): () => void {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }
  enableAutoReconnect(): void { this.autoReconnect = true; }
  disableAutoReconnect(): void { this.autoReconnect = false; }
  forceReconnect(): void {}
  close(): void { this.closed = true; this.setState("idle"); }
}

function makeClient(ws: MockClient, sse: MockClient, persist = vi.fn(), stabilityMs = 1000) {
  return new NegotiatingGatewayClient({
    makeWs: () => ws,
    makeSse: () => sse,
    persist,
    stabilityMs,
    probeConnectTimeoutMs: 4000,
  });
}

describe("NegotiatingGatewayClient", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("commits to WS when the probe connects and stays open", async () => {
    const ws = new MockClient();
    const sse = new MockClient();
    const persist = vi.fn();
    const client = makeClient(ws, sse, persist, 1000);
    client.enableAutoReconnect();

    const p = client.connect();
    await vi.advanceTimersByTimeAsync(1000);
    await p;

    expect(client.activeTransport).toBe("ws");
    expect(persist).toHaveBeenCalledWith("ws");
    expect(ws.autoReconnect).toBe(true);   // auto-reconnect handed to inner only after commit
    expect(sse.connectCalls).toBe(0);       // SSE never built
  });

  it("falls back to SSE when the WS probe connect rejects", async () => {
    const ws = new MockClient();
    ws.connectBehavior = "reject";
    const sse = new MockClient();
    const persist = vi.fn();
    const client = makeClient(ws, sse, persist, 1000);
    client.enableAutoReconnect();

    const p = client.connect();
    await vi.advanceTimersByTimeAsync(1000);
    await p;

    expect(client.activeTransport).toBe("sse");
    expect(persist).toHaveBeenCalledWith("sse");
    expect(ws.closed).toBe(true);
    expect(sse.connectCalls).toBe(1);
    expect(sse.autoReconnect).toBe(true);
  });

  it("falls back to SSE when WS opens but flaps within the stability window", async () => {
    const ws = new MockClient();
    const sse = new MockClient();
    const persist = vi.fn();
    const client = makeClient(ws, sse, persist, 1000);

    const p = client.connect();
    await vi.advanceTimersByTimeAsync(0);   // let ws.connect resolve + waitStable register
    ws.setState("closed");                  // post-handshake reject / instant flap
    await vi.advanceTimersByTimeAsync(1000);
    await p;

    expect(client.activeTransport).toBe("sse");
    expect(persist).toHaveBeenCalledWith("sse");
  });

  it("forwards state + events from the active inner across the WS→SSE swap", async () => {
    const ws = new MockClient();
    ws.connectBehavior = "reject";
    const sse = new MockClient();
    const client = makeClient(ws, sse, vi.fn(), 10);

    const states: ConnectionState[] = [];
    const anyTypes: string[] = [];
    const deltaTypes: string[] = [];
    client.onState((s) => states.push(s));
    client.onAny((e) => anyTypes.push(e.type));
    client.on("message.delta", (e) => deltaTypes.push(e.type));

    const p = client.connect();
    await vi.advanceTimersByTimeAsync(10);
    await p;

    // events from the committed SSE inner forward through the wrapper
    sse.emit({ type: "message.delta", payload: {} } as unknown as GatewayEvent);
    sse.setState("closed");
    expect(anyTypes).toContain("message.delta");
    expect(deltaTypes).toEqual(["message.delta"]);
    expect(states).toContain("closed");

    // the discarded WS inner must NOT forward anymore (no duplicate delivery)
    const before = anyTypes.length;
    ws.emit({ type: "message.delta", payload: {} } as unknown as GatewayEvent);
    expect(anyTypes.length).toBe(before);
  });

  it("does NOT fall back to SSE when close() is called during the WS probe", async () => {
    const ws = new MockClient();
    ws.connectBehavior = "reject"; // probe will fail → would normally fall back
    const sse = new MockClient();
    const persist = vi.fn();
    const client = makeClient(ws, sse, persist, 1000);
    client.enableAutoReconnect();

    const p = client.connect();
    client.close();                 // user disconnects mid-probe
    await vi.advanceTimersByTimeAsync(1000);
    await p;

    // close() intent must be honored: no SSE connection, nothing committed
    expect(sse.connectCalls).toBe(0);
    expect(sse.autoReconnect).toBe(false);
    expect(client.activeTransport).toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });

  it("re-probes (clears close intent) on a fresh connect() after close()", async () => {
    const ws = new MockClient();
    ws.connectBehavior = "reject";
    const sse = new MockClient();
    const client = makeClient(ws, sse, vi.fn(), 1000);

    const p1 = client.connect();
    client.close();
    await vi.advanceTimersByTimeAsync(1000);
    await p1;
    expect(client.activeTransport).toBeNull();

    // a later connect() should re-negotiate and be allowed to fall back again
    const p2 = client.connect();
    await vi.advanceTimersByTimeAsync(1000);
    await p2;
    expect(client.activeTransport).toBe("sse");
  });

  it("request() drives negotiation then delegates to the committed inner", async () => {
    const ws = new MockClient();
    const sse = new MockClient();
    const client = makeClient(ws, sse, vi.fn(), 5);

    const rp = client.request("session.list", { a: 1 });
    await vi.advanceTimersByTimeAsync(5);
    await rp;

    expect(client.activeTransport).toBe("ws");
    expect(ws.requestImpl).toHaveBeenCalledWith("session.list", { a: 1 }, undefined);
  });

  it("delegates subsequent connect() calls to the committed inner", async () => {
    const ws = new MockClient();
    const sse = new MockClient();
    const client = makeClient(ws, sse, vi.fn(), 5);

    const p = client.connect();
    await vi.advanceTimersByTimeAsync(5);
    await p;
    expect(ws.connectCalls).toBe(1);

    await client.connect();
    expect(ws.connectCalls).toBe(2);  // delegated, not re-negotiated
  });
});
