/**
 * A STAND-IN GEOCODER on this machine: it answers as the place suggestion service does (GeoJSON
 * of Photon's shape, its statuses, its error bodies, its Retry-After) and keeps every request it
 * was asked, whole, so a test reads exactly what left the server. Never the real service, and
 * never a recorded answer of it: every feature here is written by hand.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface AskedOfBox {
  method: string;
  path: string;
  query: Record<string, string>;
  /** Every header line, its name in lower case. */
  headers: Record<string, string>;
  body: string;
  /** Set once the connection of a held request closed. */
  gaveUpAt: number | null;
}

/** An answer (`delayMs` after the request, when given), or `hold`: the request is kept open and never answered. */
export type BoxAnswer = { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number } | "hold";

export interface PlaceBox {
  /** `http://localhost:<port>`: a private service name, as the settings admit plain http. */
  readonly url: string;
  readonly port: number;
  readonly asked: AskedOfBox[];
  answer(fn: (asked: AskedOfBox) => BoxAnswer): void;
  close(): Promise<void>;
}

export async function placeBox(): Promise<PlaceBox> {
  const asked: AskedOfBox[] = [];
  let respond: (a: AskedOfBox) => BoxAnswer = () => ({ status: 200, body: collection() });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://box.invalid");
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
      }
      const one: AskedOfBox = {
        method: req.method ?? "", path: url.pathname, query: Object.fromEntries(url.searchParams),
        headers, body: Buffer.concat(chunks).toString("utf8"), gaveUpAt: null,
      };
      asked.push(one);
      const a = respond(one);
      if (a === "hold") {
        res.on("close", () => { one.gaveUpAt = Date.now(); });
        return;
      }
      const body = a.body === undefined ? "" : typeof a.body === "string" ? a.body : JSON.stringify(a.body);
      const send = (): void => {
        res.writeHead(a.status, { "content-type": "application/json", ...a.headers });
        res.end(body);
      };
      if (a.delayMs !== undefined) setTimeout(send, a.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://localhost:${port}`,
    port,
    asked,
    answer(fn) { respond = fn; },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** One feature: Photon's properties and a point, `[lon, lat]`. */
export function feature(properties: Record<string, unknown>, lon = 8.5417, lat = 47.3769): unknown {
  return { type: "Feature", properties, geometry: { type: "Point", coordinates: [lon, lat] } };
}

export function collection(...features: unknown[]): unknown {
  return { type: "FeatureCollection", features };
}

/** The service's error body: a word and a sentence. */
export function refusal(error: string, message: string): unknown {
  return { error, message };
}

/** A resolver that answers this machine's loopback for every name, as the composition's would for `localhost`. */
export const loopback = { resolve: async (): Promise<string[]> => ["127.0.0.1"] };

/** The address the settings would hand the suggester for the stand-in. */
export function boxAddress(box: PlaceBox): { origin: string; hostname: string; transport: "http-private" } {
  return { origin: box.url, hostname: "localhost", transport: "http-private" };
}
