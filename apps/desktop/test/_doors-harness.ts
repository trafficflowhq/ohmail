import type { EngineStatus } from "../src/bridge-fetch.js";

/**
 * THE WINDOW'S PIPE, RECORDED. The desktop's window cannot run in a browser: every call it makes
 * leaves through the shell's `invoke`. This stands in for the shell and nothing else: the engine's
 * status is planted per door, and every request the window sends is handed to a REAL engine's own
 * handler and written down as it leaves. What the window asked is then the pipe's own log.
 */
interface Shell {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}

/** One answer, framed as the shell frames one for the bridge. */
async function framed(res: Response): Promise<Uint8Array> {
  const h: [string, string][] = [];
  res.headers.forEach((value, name) => h.push([name, value]));
  const meta = new TextEncoder().encode(JSON.stringify({ status: res.status, statusText: res.statusText, h }));
  const payload = new Uint8Array(await res.arrayBuffer());
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

const masked = (path: string): string =>
  path.split("?")[0]!.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":id");

export interface Pipe {
  /** Every request that left the window: method and path, ids masked, in order. */
  asked: string[];
  /** Every shell command the window invoked that is not a request to the engine. */
  commands: string[];
  unplant(): void;
}

/** Plant `status` as the engine's own answer and hand every request to `engine`, with the shell's bearer. */
export function plantShell(status: EngineStatus, engine: (req: Request) => Promise<Response>, bearer: string): Pipe {
  const host = globalThis as unknown as Shell;
  const asked: string[] = [];
  const commands: string[] = [];
  let next = 1;
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => next++,
    invoke: async (command, payload) => {
      if (command === "engine_status") return status;
      if (command !== "engine_request") {
        commands.push(command);
        return null;
      }
      const p = (payload ?? {}) as { method?: string; url?: string; headers?: [string, string][]; body?: number[]; bodyText?: string };
      const method = (p.method ?? "GET").toUpperCase();
      asked.push(`${method} ${masked(p.url ?? "/")}`);
      const headers = new Headers(p.headers ?? []);
      headers.set("authorization", `Bearer ${bearer}`);
      const body = p.bodyText ?? (p.body && p.body.length > 0 ? Uint8Array.from(p.body) : undefined);
      return framed(await engine(new Request(`http://sidecar${p.url ?? "/"}`, {
        method, headers, ...(body !== undefined && method !== "GET" && method !== "HEAD" ? { body } : {}),
      })));
    },
  };
  return { asked, commands, unplant: () => { delete host.__TAURI_INTERNALS__; } };
}

/** The four doors of the desktop, as the engine's status tells them apart. */
export const DOORS: Record<"D-l" | "D-m" | "D-s" | "D-p", (mailbox: { id: string; address: string }) => EngineStatus> = {
  "D-l": (m) => ({ state: "serving", mode: "local", address: m.address, mailboxId: m.id, baseUrl: "http://sidecar", credentialState: "ready" }),
  "D-m": (m) => ({ state: "serving", mode: "cloud", address: m.address, mailboxId: m.id, baseUrl: "http://sidecar", cloudUrl: "https://ohmail.app", credentialState: "ready" }),
  "D-s": (m) => ({ state: "serving", mode: "cloud", address: m.address, mailboxId: m.id, baseUrl: "http://sidecar", cloudUrl: "https://mail.lichtgrat.example", credentialState: "ready" }),
  "D-p": (m) => ({ state: "serving", mode: "cloud", flavor: "desktop-host", address: m.address, mailboxId: m.id, baseUrl: "http://sidecar", cloudUrl: "https://kestrel.tail1234.ts.net", credentialState: "ready" }),
};
