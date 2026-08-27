export type CdpTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

type CdpResponse = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

export class CdpClient {
  readonly endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint.replace(/\/$/, "");
  }

  async targets(): Promise<CdpTarget[]> {
    const response = await fetch(`${this.endpoint}/json/list`, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) throw new Error(`Desktop bridge returned HTTP ${response.status}`);
    const targets = await response.json() as CdpTarget[];
    return targets.filter((target) => target.id && target.type && target.url);
  }

  async ready(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/json/version`, { signal: AbortSignal.timeout(1_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async closeTarget(target: Pick<CdpTarget, "id">): Promise<void> {
    const response = await fetch(`${this.endpoint}/json/close/${encodeURIComponent(target.id)}`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) throw new Error(`Desktop bridge could not close target ${target.id} (HTTP ${response.status})`);
  }

  async screenshot(target: CdpTarget): Promise<Uint8Array> {
    if (!target.webSocketDebuggerUrl) throw new Error(`Target ${target.id} does not expose a debugger socket`);
    const result = await this.request(target.webSocketDebuggerUrl, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const data = result.data;
    if (typeof data !== "string") throw new Error("Desktop bridge returned no screenshot data");
    return Uint8Array.from(Buffer.from(data, "base64"));
  }

  async evaluate(target: CdpTarget, expression: string): Promise<unknown> {
    if (!target.webSocketDebuggerUrl) throw new Error(`Target ${target.id} does not expose a debugger socket`);
    const response = await this.request(target.webSocketDebuggerUrl, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const result = response.result as { value?: unknown; description?: string } | undefined;
    if (!result) throw new Error("Desktop bridge returned no evaluation result");
    return result.value ?? result.description;
  }

  async command(target: CdpTarget, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!target.webSocketDebuggerUrl) throw new Error(`Target ${target.id} does not expose a debugger socket`);
    return this.request(target.webSocketDebuggerUrl, method, params);
  }

  async request(webSocketUrl: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(webSocketUrl);
      const requestId = 1;
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error(`Desktop bridge timed out running ${method}`));
      }, 5_000);

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as CdpResponse;
        if (message.id !== requestId) return;
        clearTimeout(timeout);
        socket.close();
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result ?? {});
      });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Desktop bridge WebSocket failed"));
      });
    });
  }
}
