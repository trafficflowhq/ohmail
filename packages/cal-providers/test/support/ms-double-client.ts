/**
 * The test's side of the Microsoft double (`ms-double.mjs`): the address and token the bench made at its
 * start, the port that hands the adapter an access token, plain Graph calls for a test's own assertions,
 * and the double's switches (reset, a sync state that is gone, a throttled answer).
 *
 * It talks to this machine only. A base address that is not loopback is refused, so a test wired to the
 * double can never reach Microsoft, and no real token is ever sent to the double.
 */
import { isLoopback, readCalBenchEnv, Secret } from "./calendar-test-accounts.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface GraphAnswer {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

export class MsDoubleClient {
  /** The Graph base address the adapter is given in place of Microsoft's. */
  readonly base: string;
  readonly #origin: string;
  readonly #token: Secret;
  readonly #fetch: FetchLike;

  constructor(o: { base: string; token: Secret; fetch?: FetchLike }) {
    const url = new URL(o.base);
    if (url.protocol !== "http:" || !isLoopback(url.hostname)) throw new Error(`the Microsoft double's client does not talk to ${url.host}: it is not this machine`);
    if (!o.token.filled) throw new Error("the Microsoft double's client was given no token");
    this.base = o.base.replace(/\/$/, "");
    this.#origin = url.origin;
    this.#token = o.token;
    this.#fetch = o.fetch ?? ((input, init) => fetch(input, init));
  }

  /** From the bench's env file or the environment; unset is an error, never a built-in address or token. */
  static fromEnv(env: Record<string, string | undefined>): MsDoubleClient {
    const all = readCalBenchEnv(env);
    if (!all.OHCAL_MS_GRAPH_BASE || !all.OHCAL_MS_DOUBLE_TOKEN) throw new Error("the Microsoft double is not named: start ms-double.mjs and name the bench's env file");
    return new MsDoubleClient({ base: all.OHCAL_MS_GRAPH_BASE, token: new Secret(all.OHCAL_MS_DOUBLE_TOKEN) });
  }

  /** The port the Microsoft adapter takes in place of the sign-in: it yields the double's own token. */
  readonly accessToken = async (): Promise<string> => this.#token.reveal();

  /** One Graph call. `target` is a path under the base (`/me/calendars`) or a link the double handed out. */
  async graph(method: string, target: string, o: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string>; token?: string } = {}): Promise<GraphAnswer> {
    const url = new URL(/^https?:/.test(target) ? target : this.base + target);
    if (url.origin !== this.#origin) throw new Error(`refused: ${url.host} is not the double`);
    for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Authorization: `Bearer ${o.token ?? this.#token.reveal()}`, ...o.headers };
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    const r = await this.#fetch(url.href, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await r.text();
    return { status: r.status, headers: r.headers, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  async #switch(method: string, name: string, body?: unknown): Promise<GraphAnswer> {
    return this.graph(method, `${this.#origin}/__double/${name}`, { body });
  }
  /** The seed again, and every sync state forgotten. */
  reset = async (): Promise<number> => (await this.#switch("POST", "reset")).status;
  /** The next delta call with an old token is answered 410 with `Location`. */
  expireSyncState = async (): Promise<number> => (await this.#switch("POST", "expire-sync-state")).status;
  /** The next `count` Graph calls are answered 429 with `Retry-After: retryAfter`. */
  throttleNext = async (count: number, retryAfter: number): Promise<number> => (await this.#switch("POST", "throttle", { count, retryAfter })).status;
  /** Counts: requests, events, what the server "sent" (invitations, updates, cancellations, answers). */
  state = async (): Promise<Record<string, number>> => (await this.#switch("GET", "state")).json as Record<string, number>;
}
