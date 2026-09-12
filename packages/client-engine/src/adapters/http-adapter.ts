import {
  CursorExpiredError,
  FOLDER_OF_VIEW,
  MutationRejectedError,
  UnsupportedMutationError,
  type EngineMessage,
  type EngineMutation,
  type FolderEntity,
  type MessageBodyBatchWire,
  type MessageBodyWire,
  type OhmailView,
  type RuleDTO,
  type SyncChange,
  type SyncResponse,
  type SyncSnapshotPage,
  type TagDTO,
  type UnsubscribeRefusal,
  type UnsubscribeResult,
} from "../types.js";
import type {
  ListOlderWire,
  ListTrashWire,
  RestoreFromTrashWire,
  ServerAddressOpts,
  ServerAddressWire,
  ServerSearchOpts,
  ServerSearchWire,
  TrashRowWire,
} from "../engine.js";
import type { AttachmentWire, EngineAdapter, MutationOutcome, SyncParams } from "./adapter.js";
import { retryAfterMsOf, retryingRead } from "./retrying-read.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpAdapterOptions {
  /** e.g. "" (same origin), "/api/v1", or "http://localhost" in tests. */
  baseUrl?: string;
  /** Injectable fetch — tests bridge it straight into `app.handle`; the future
   *  localhost engine points it at 127.0.0.1. Defaults to global fetch. */
  fetch?: FetchLike;
  /** Cookie reader for the double-submit CSRF token; defaults to document.cookie. */
  getCookie?: (name: string) => string | null;
  /** Cookie carrying the CSRF token (contract §1.3). */
  csrfCookieName?: string;
  /**
   * The wait a retried READ takes, for a guard that must assert the interval rather than sit
   * through it. Production leaves it unset and the wrapper uses `setTimeout`.
   */
  readWaitFor?: (ms: number) => Promise<void>;
  /** Extra headers on every request (e.g. Authorization for bearer mode). */
  headers?: () => Record<string, string>;
  /**
   * May this client stage attachment bytes out of the send request?
   * Default: no. On, a send whose base64 bytes exceed the request-body
   * limit mints a ticket per file (`POST /attachments/staging`), PUTs the
   * bytes at the given URL and sends references — the ceiling becomes the
   * mailbox's own announced limit. The default is the safety property: this
   * adapter is both desktop doors' transport — the standalone engine has no
   * object storage, the cloud door must forward sends byte-identical — and
   * neither passes options, so neither stages; the browser opts in.
   */
  stageAttachments?: boolean;
}

function defaultGetCookie(name: string): string | null {
  const doc = (globalThis as { document?: { cookie?: string } }).document;
  if (!doc?.cookie) return null;
  for (const part of doc.cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

interface WireError {
  /** `details` is the refusal's structured facts — opaque here, read by the surface that knows the code. */
  error?: { code?: string; message?: string; retryable?: boolean; details?: unknown };
}

// ── the two view vocabularies ──────────────────────────────────────────────
//
// Two names for every pile, overlapping in exactly one place. The client's
// vocabulary is {@link OhmailView} (`ohbox`, `reads`, `receipts`, `screener`,
// `screened`, `spam`); the server's message-list route speaks another, and
// the only shared name is `screened` — so a client that puts its own word on
// the wire works for one view out of six. The translation happens here, in
// the wire client: nothing above this file should know the server's words.

/**
 * The server's message-view vocabulary, mirrored from the `MessageView` union its message-list
 * service declares.
 *
 * Seven names, of which this client asks for five. `new_for_you` and `previously_seen` are the
 * server's unread/read split of the Imbox; the client makes that split itself, out of the mirror
 * it already has, so it never asks for them. They are named here anyway because this type's job
 * is to be a faithful copy of the server's list — a partial copy would make the drift check below
 * pass while the vocabularies diverged.
 */
export type ServerMessageView =
  | "imbox" | "feed" | "paper_trail" | "screened" | "quarantine"
  | "new_for_you" | "previously_seen";

/**
 * Client view → server view, the one place the two vocabularies meet.
 * `null` means the server has no message-list for that view — a real answer:
 * `screener` is a queue of senders at the door, not a pile of mail with a
 * paging cursor. A request would be refused, so none is made. Exhaustive by
 * `Record<OhmailView, …>`: adding a view without deciding what the server
 * calls it does not compile.
 */
export const SERVER_VIEW_OF: Record<OhmailView, ServerMessageView | null> = {
  ohbox: "imbox",
  reads: "feed",
  receipts: "paper_trail",
  screened: "screened",
  spam: "quarantine",
  screener: null,
};

/**
 * How long the client waits for `GET /messages/:id/attachments`. `fetch` has
 * no default deadline, so a request the server accepts and never answers (a
 * dead proxy, a half-open connection) left `loadAttachments` in
 * `{state: "loading"}` for the life of the tab, with no bound anywhere on
 * the path. Twelve seconds is chosen against the user, not derived from
 * `maxDuration`: the route is `cost: "read"`, one indexed row, fired on
 * every message open — 12 s leaves room for a cold lambda on a slow mobile
 * link (~8 s floor) and stays short of "the app is broken, reload".
 */
export const ATTACHMENT_LIST_TIMEOUT_MS = 12_000;

/**
 * How long the client waits for `GET /messages/:id/attachments`. `fetch`
 * has no default deadline, so a request the server accepts and never
 * answers (a dead proxy, a half-open connection) left `loadAttachments` in
 * `{state: "loading"}` for the life of the tab. Twelve seconds is chosen
 * against the user, not derived from `maxDuration`: the route is
 * `cost: "read"`, one indexed row, fired on every message open — 12 s
 * leaves room for a cold lambda on a slow mobile link (~8 s floor) and
 * stays short of "the app is broken, reload".
 */
export const BODY_FETCH_TIMEOUT_MS = 12_000;

/**
 * The worker-doorbell ring (`POST /sync/pull`). Shorter than the read deadlines: the route is
 * one guarded UPDATE — nothing streams — and the ring is an ACCELERANT in front of a sync that
 * proceeds regardless, so a slow answer is worth less than the gesture staying live. 8 s keeps
 * a cold serverless start inside the window and still leaves the webapp's 30 s settle cap
 * meaningfully about the SCAN rather than about the POST.
 */
export const PULL_RING_TIMEOUT_MS = 8_000;

/**
 * How long the client waits for `GET /messages/:id/body` — the same silence
 * as {@link ATTACHMENT_LIST_TIMEOUT_MS}, on the route that shows a reader
 * the message, where the stuck spinner is unrecoverable: the single-flight
 * map clears in the request's own `.finally`, so a hung request keeps its
 * entry for the tab's life and even Retry joins the promise that never
 * settles — this deadline makes `loading` a state that ends. Twelve, not
 * longer: the same read cost class as its sibling, the response is gzipped,
 * and timing out late costs the reader those seconds with nothing offered.
 */
function narrowBody(wire: Partial<MessageBodyWire>): MessageBodyWire {
  return {
    text: typeof wire.text === "string" ? wire.text : "",
    html: typeof wire.html === "string" ? wire.html : null,
    loadedRemoteContent: wire.loadedRemoteContent === true,
    unsubscribe:
      wire.unsubscribe === "one_click" ||
      wire.unsubscribe === "mailto_only" ||
      wire.unsubscribe === "not_one_click"
        ? wire.unsubscribe
        : "no_header",
    unsubscribeUrl: typeof wire.unsubscribeUrl === "string" ? wire.unsubscribeUrl : null,
    // Carried only when the server said a member of the closed set, so an older server — or an
    // ordinary stored body — narrows to a record without the key, exactly as the wire.
    ...(wire.withheld === "storage_cap" || wire.withheld === "junk_filed" || wire.withheld === "expunged"
      ? { withheld: wire.withheld }
      : {}),
  };
}

/**
 * THE FIVE ANSWERS `POST /drafts/:id/send` SPEAKS. Anything else at a status that says the server
 * ACTED is ambiguity — see the guard that reads this set.
 *
 * Named as a set rather than inlined because the guard sits ABOVE the per-status branches (it has
 * to, or `draftForKey` is already gone by the time it runs) and would otherwise swallow the very
 * answers those branches exist to handle. It did: lifting the guard turned a `409 {status:"failed"}`
 * — a definitively-undelivered attempt, terminal and NOT retryable — into a retryable
 * `send_in_flight`, and the existing send suite said so immediately.
 */
const SEND_WIRE_STATUSES = new Set(["sent", "unverified", "queued", "in_flight", "failed"]);

/** `POST /drafts/:id/send` answers this shape at 200 AND at 409 — never the error envelope. */
interface SendWire {
  status?: "sent" | "unverified" | "failed" | "in_flight" | "queued";
  providerMessageId?: string | null;
  message?: string;
}

/**
 * A 2xx whose body will not parse is ambiguity, not a refusal: the server
 * acted and we cannot read what it said — the row may exist, the ticket may
 * be minted. Letting the raw SyntaxError escape made `dispatch` wrap it as
 * `retryable: false`, so the client dropped its Idempotency-Key and the next
 * attempt created a second draft. Retryable, under the same key, carrying
 * the response's own status so the give-up ceiling can attribute it. See
 * the send route's equivalent arm.
 */
async function readJsonOrAmbiguous<T>(res: Response, what: string): Promise<T> {
  try {
    const body = (await res.json()) as T;
    // A body that PARSES but is not an object — `null`, a bare string, a number — is the same
    // ambiguity as one that will not parse, and it used to be worse: `null` threw a TypeError on
    // the first field access, which `dispatch` wrapped as a terminal refusal. The server acted and
    // we cannot read what it said; a create that may already exist must not be reported as one
    // that does not.
    if (body === null || typeof body !== "object") throw new Error("unusable body");
    return body;
  } catch {
    throw new MutationRejectedError(
      `We could not read the server's answer to this ${what}. ohmail will ask again under the same key.`,
      { status: res.status, code: "unreadable_response", retryable: true, retryAfterMs: retryAfterMsOf(res) },
    );
  }
}

/**
 * The real protocol (api-contract.md): `GET /sync?since=` with 410 → CursorExpired,
 * mutations with a client `Idempotency-Key`, `X-CSRF-Token` echoed from the
 * `tf_csrf` cookie on unsafe requests (cookie-auth web mode; bearer is exempt
 * server-side, sending it is harmless), and `X-Sync-Seq` awareness (§3.4) so the
 * engine can apply the read-your-writes echo immediately.
 */
export class HttpAdapter implements EngineAdapter {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  /**
   * The SAME transport with {@link retryingRead} around it — used for GETs and nothing else.
   *
   * Built once in the constructor rather than per call so there is one wrapper per adapter, and
   * kept beside `fetchImpl` rather than replacing it because the wrapper REFUSES a write.
   */
  private readonly readImpl: FetchLike;
  private readonly getCookie: (name: string) => string | null;
  private readonly csrfCookieName: string;
  private readonly extraHeaders: () => Record<string, string>;
  /** See {@link HttpAdapterOptions.stageAttachments}. `false` unless a host asked for it. */
  private readonly stageAttachments: boolean;
  /** Highest X-Sync-Seq observed across mutations — converged once the /sync cursor reaches it. */
  lastSyncSeq: number | null = null;
  /**
   * `Idempotency-Key → draftId` for in-flight sends. A send is TWO requests — create the draft, then send it — and
   * only the second is idempotent server-side (`POST /drafts` is not `idempotent`-marked, so `withIdempotency`
   * short-circuits and a replay writes a SECOND draft). Remembering the draft this key already created means the
   * engine's retry — same key, same envelope — re-sends the same draft instead of minting another. It is in-memory ON
   * PURPOSE and needs no more durability than that: the engine's retry queue lives in the same object graph and dies
   * on the same reload. The worst case when the memo is missed is one orphan `drafts` row that nobody sees — NEVER a
   * second delivery, because `outbound_sends` is UNIQUE on `(accountId, idempotencyKey)` and a same-key request
   * replays the first reservation's outcome without touching SMTP.
   */
  private readonly draftForKey = new Map<string, string>();
  /**
   * Keys whose `POST /drafts` went out and came back unreadable.
   *
   * `POST /drafts` is NOT idempotent — it ignores the key it is given — so a retry under the same
   * key creates a second draft rather than returning the first. This is what stops that: the key
   * is remembered, and the next attempt refuses instead of repeating a create the server may
   * already have committed.
   */
  private readonly createAttempted = new Set<string>();

  constructor(opts: HttpAdapterOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "").replace(/\/$/, "");
    const injected = opts.fetch;
    const global = globalThis.fetch as FetchLike | undefined;
    if (!injected && !global) throw new Error("no fetch implementation available — pass HttpAdapterOptions.fetch");
    // BIND THE GLOBAL. `request()` calls this through `this.fetchImpl(...)`, which makes the
    // receiver the adapter — and a browser's native `fetch` refuses any receiver that is not
    // its own global: "Failed to execute 'fetch' on 'Window': Illegal invocation", thrown
    // BEFORE a request leaves. Every test injects `opts.fetch` (a plain function, which has no
    // receiver requirement), so this default branch only ever ran in a browser and no suite
    // could see it. It made the Cloud client's `/sync` drain die on its first call, silently.
    this.fetchImpl = injected ?? (global!.bind(globalThis) as FetchLike);
    this.readImpl = retryingRead(this.fetchImpl, {
      ...(opts.readWaitFor ? { waitFor: opts.readWaitFor } : {}),
    });
    this.getCookie = opts.getCookie ?? defaultGetCookie;
    this.csrfCookieName = opts.csrfCookieName ?? "tf_csrf";
    this.extraHeaders = opts.headers ?? (() => ({}));
    // `=== true` rather than `?? false`, so nothing truthy-but-not-boolean can turn this on.
    this.stageAttachments = opts.stageAttachments === true;
  }

  /** The SSE wake-signal attach point (same origin/base as the sync API). */
  eventsUrl(): string {
    return `${this.baseUrl}/events`;
  }

  /**
   * `signal` is OPTIONAL AND UNSET BY DEFAULT, and that is the blast-radius decision. This method is shared by every
   * call the client makes — sync drains, bodies, search, the byte fetches, and every mutation. A deadline installed
   * HERE would bound all of them at one number, and they do not deserve one number: a `/sync` drain legitimately runs
   * longer than a list read, a mutation aborted mid-flight is ambiguous in a way a GET never is (`POST /rules` has no
   * server-side idempotency claim — see `rule_create` below — so abort-then-retry writes a second rule), and the two
   * `cost: "connection"` byte routes hold a slot in `imap-admission` that a CLIENT giving up does not hand back, so a
   * deadline there plus the retry it invites double-counts against the per-mailbox cap and produces a `mailbox_busy`
   * the user caused. So the mechanism is here and the POLICY is at the call site.
   */

  /**
   * Exactly one caller passes a signal today: {@link HttpAdapter.listAttachments}, via {@link
   * HttpAdapter.withDeadline}.
   */
  private async request(method: string, path: string, init: { body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...this.extraHeaders() };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
    if (method !== "GET") {
      const csrf = this.getCookie(this.csrfCookieName);
      if (csrf) headers["x-csrf-token"] = csrf;
    }
    try {
      /* A GET IS THE ONLY THING THAT MAY BE ASKED TWICE. `readImpl` refuses anything else, so the
         branch is the enforcement and not merely a routing choice — see {@link retryingRead}. */
      const transport = method === "GET" ? this.readImpl : this.fetchImpl;
      return await transport(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
      });
    } catch (err) {
      // Network failure — safe to retry with the SAME Idempotency-Key (§1.6). An abort raised by
      // `withDeadline` also lands here, as an `AbortError`; it becomes the LOSING branch of that
      // race and is swallowed there, so this classification never reaches a surface.
      throw new MutationRejectedError(`network failure: ${String(err)}`, { code: "network", retryable: true });
    }
  }

  /**
   * Run one request-and-parse under a deadline, ABORTING it when the deadline fires. It is a race
   * AND an abort, both load-bearing: the abort makes the sentence true about the socket (a timeout
   * that left the request running would say it failed while it may yet succeed, and leak a
   * connection per hung open); the race makes the bound unconditional — a transport that ignores
   * `signal` would hang exactly as before, and every injected `fetch` in this repo's suites is such
   * a transport. It wraps the whole body, `res.json()` included: a deadline ending at the
   * `Response` would miss a server that sends headers and stalls the stream.
   */

  /**
   * The loser's rejection is swallowed at mint time: the abandoned request rejects later with nobody awaiting it, and
   * an unhandled rejection is a console error about a request the app deliberately dropped. `Promise.race` already
   * registers a handler on `attempt`, so the explicit `.catch()` is redundant TODAY and no test can distinguish its
   * presence — stated plainly rather than dressed as a guard. It is kept because the swallow is a property of this
   * method, not of the operator it currently uses: express the bound any other way and the handler goes away silently
   * with it. The thrown error is `code: "timeout"`, `retryable: true` — not a hedge: nothing was established about
   * the server, the call is a side-effect-free GET, and the surface must offer the button (`AttachmentStrip`'s
   * failure row reads exactly this flag).
   */
  private async withDeadline<T>(timeoutMs: number, run: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
    const Ctor = (globalThis as { AbortController?: typeof AbortController }).AbortController;
    const controller = Ctor ? new Ctor() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new MutationRejectedError(`ohmail did not answer within ${timeoutMs} ms`, {
          code: "timeout",
          retryable: true,
        }));
      }, timeoutMs);
    });

    const attempt = run(controller?.signal);
    attempt.catch(() => { /* the loser of the race has no reader — see the note above */ });

    try {
      return await Promise.race([attempt, deadline]);
    } finally {
      // On the success path this is what stops the timer firing over a list that already arrived,
      // which would replace a good answer with a failure — the silent hang inverted, and worse.
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async rejectionOf(res: Response): Promise<MutationRejectedError> {
    let wire: WireError = {};
    try {
      wire = (await res.json()) as WireError;
    } catch {
      /* non-JSON body */
    }
    return new MutationRejectedError(wire.error?.message ?? `HTTP ${res.status}`, {
      status: res.status,
      code: wire.error?.code ?? null,
      retryable: wire.error?.retryable ?? (res.status >= 500 || res.status === 429),
      retryAfterMs: retryAfterMsOf(res),
    });
  }

  /**
   * `Retry-After` as milliseconds, or `null` when the server named no interval. RFC 9110 allows both spellings and
   * the API uses the numeric one on the `503 db_busy` its starved-pool refusal raises; the HTTP-date form is parsed
   * anyway because a proxy in front of the API may rewrite it, and a misparse here does not merely lose an
   * optimisation — it turns a server's "wait, I know when" into a failure that counts toward the outbox's give-up
   * ceiling. A date in the past clamps to 0 rather than going negative: the server has spoken, and the answer is
   * "now".
   */

  private noteSeq(res: Response): number | null {
    const raw = res.headers.get("x-sync-seq");
    if (raw == null) return null;
    const seq = Number(raw);
    if (!Number.isFinite(seq)) return null;
    if (this.lastSyncSeq === null || seq > this.lastSyncSeq) this.lastSyncSeq = seq;
    return seq;
  }

  // ── sync ─────────────────────────────────────────────────────────────────

  async sync(params: SyncParams): Promise<SyncResponse> {
    const q = new URLSearchParams({ since: params.since });
    if (params.limit !== undefined) q.set("limit", String(params.limit));
    if (params.types && params.types.length > 0) q.set("types", params.types.join(","));
    const res = await this.request("GET", `/sync?${q.toString()}`);
    if (res.status === 410) throw new CursorExpiredError();
    if (!res.ok) throw await this.rejectionOf(res);
    return (await res.json()) as SyncResponse;
  }

  /**
   * `POST /sync/pull` — the worker doorbell. See {@link EngineAdapter.requestPull}. UNDER A DEADLINE, like the body
   * and attachment reads and for a sharper reason: the ring is the FIRST await of every pull gesture, so a stalled
   * POST (or a stalled response body) with no abort would hold the webapp's spinner past its advertised cap and
   * starve the mobile follow-up drains that are scheduled off this promise — the whole affordance hangs on the one
   * request that was only ever an accelerant. `fetch` has no timeout of its own; the abort is the only thing that
   * reclaims the transport. The wire carries per-mailbox effective stamps (`mailboxes`) — each mailbox's OWN request
   * instant at the database's clock, which is the client's honest-settle baseline. `requestedAt` is the newest of
   * them, kept for logging; a missing field degrades to "nothing to wait for".
   */
  async requestPull(): Promise<{
    requested: number; requestedAt: string;
    mailboxes: Array<{ id: string; requestedAt: string }>;
  }> {
    return this.withDeadline(PULL_RING_TIMEOUT_MS, async (signal) => {
      const res = await this.request("POST", "/sync/pull", { body: {}, ...(signal ? { signal } : {}) });
      if (!res.ok) throw await this.rejectionOf(res);
      const wire = (await res.json()) as Partial<{
        requested: number; requestedAt: string;
        mailboxes: Array<{ id?: string; requestedAt?: string }>;
      }>;
      const mailboxes = (Array.isArray(wire.mailboxes) ? wire.mailboxes : [])
        .filter((m): m is { id: string; requestedAt: string } =>
          typeof m?.id === "string" && typeof m?.requestedAt === "string");
      return {
        requested: typeof wire.requested === "number" ? wire.requested : mailboxes.length,
        requestedAt: typeof wire.requestedAt === "string" ? wire.requestedAt : new Date().toISOString(),
        mailboxes,
      };
    });
  }

  /**
   * `GET /sync/snapshot` — current state at one consistent point, instead of replaying the log from `since=0` (see
   * {@link SyncSnapshotPage}). Optional on the engine's side and deliberately not a member of `EngineAdapter`: the
   * FixturesAdapter has no server, and an adapter lacking this takes the `since=0` path; a wrapper must forward it
   * explicitly (`SnapshotCapableAdapter` in `engine.ts`). Forward-compatible parsing (§8) with one strict field:
   * `nextCursor` and `window` degrade (missing `nextCursor` means "last page", the safe reading), but `asOfSeq` does
   * NOT — it becomes the `/sync` cursor, and a missing value coerced to 0 would commit a cold-mirror cursor and
   * re-snapshot for ever, or resume deltas from the beginning over a full mirror. A response without a usable
   * `asOfSeq` is not a snapshot: it throws, and the fallback runs.
   */

  /**
   * No 410 branch: a snapshot has no client-supplied cursor to expire.
   */
  async snapshot(params: { cursor?: string; limit?: number } = {}): Promise<SyncSnapshotPage> {
    const q = new URLSearchParams();
    if (params.cursor) q.set("cursor", params.cursor);
    if (params.limit !== undefined) q.set("limit", String(params.limit));
    const qs = q.toString();
    const res = await this.request("GET", qs ? `/sync/snapshot?${qs}` : "/sync/snapshot");
    if (!res.ok) throw await this.rejectionOf(res);
    const wire = (await res.json()) as Partial<SyncSnapshotPage>;
    const asOfSeq = Number(wire.asOfSeq);
    if (!Number.isFinite(asOfSeq) || asOfSeq < 0) {
      throw new MutationRejectedError("snapshot response carried no usable asOfSeq", {
        code: "protocol",
        retryable: false,
      });
    }
    return {
      asOfSeq,
      changes: Array.isArray(wire.changes) ? wire.changes : [],
      nextCursor: typeof wire.nextCursor === "string" && wire.nextCursor !== "" ? wire.nextCursor : null,
      window: {
        days: typeof wire.window?.days === "number" ? wire.window.days : 0,
        minRows: typeof wire.window?.minRows === "number" ? wire.window.minRows : 0,
      },
    };
  }

  // ── bodies ───────────────────────────────────────────────────────────────

  /**
   * `GET /messages/:id/body` — the endpoint that existed, spend-gated and contract-tested, with zero client callers
   * for the whole of Stage 2: the wire `MessageDTO` carries `snippet` and never `body`, which is the entire reason a
   * live account rendered one line of every newsletter. The route is `cost: "read"`, open to an unverified session (a
   * 403 costs the same invocation as the read it refuses) — which is NOT licence to prefetch: the engine calls this
   * on explicit intent only, never pile-wide. The text comes back ALREADY REDACTED for a sensitive message and passes
   * through untouched: sensitive mail is redacted once, server-side, and this method must not learn what an OTP looks
   * like. A non-2xx THROWS through the same `rejectionOf` every mutation uses, so a 402 arrives with the server's own
   * sentence; the engine turns the throw into a `failed` record and the surface says the body could not be loaded.
   */
  async fetchBody(messageId: string): Promise<MessageBodyWire> {
    // UNDER A DEADLINE — see {@link BODY_FETCH_TIMEOUT_MS} for why this route earns one and what
    // a hang costs without it. The read itself is split out so the wrapper stays one line and
    // the parse below is unchanged; `withDeadline` covers the whole thing, `res.json()` included.
    return this.withDeadline(BODY_FETCH_TIMEOUT_MS, (signal) => this.readBody(messageId, signal));
  }

  private async readBody(messageId: string, signal: AbortSignal | undefined): Promise<MessageBodyWire> {
    const res = await this.request("GET", `/messages/${encodeURIComponent(messageId)}/body`, { signal });
    if (!res.ok) throw await this.rejectionOf(res);
    return narrowBody((await res.json()) as Partial<MessageBodyWire>);
  }

  /**
   * `GET /drafts/:id` — the draft's text, for a mirror row that arrived without one.
   *
   * The same route the AI-draft purchase reads back, and the same `cost: "read"`. Under the body
   * fetch's deadline, because compose is waiting on it before it will show the editor; a refusal
   * throws through `rejectionOf` so "the server said no" cannot be mistaken for "the draft is
   * empty". A body the server omits is `null` — the one answer that means "no text of record".
   */
  async fetchDraftBody(draftId: string): Promise<string | null> {
    return this.withDeadline(BODY_FETCH_TIMEOUT_MS, async (signal) => {
      const res = await this.request("GET", `/drafts/${encodeURIComponent(draftId)}`, { signal });
      if (!res.ok) throw await this.rejectionOf(res);
      const wire = (await res.json()) as { body?: unknown };
      return typeof wire.body === "string" ? wire.body : null;
    });
  }

  /**
   * `GET /messages/bodies?ids=…` — every body a conversation needs, in ONE request. SAME ROUTE as the mirror's keyset
   * page and the same `cost: "read"`; the `ids` parameter is what selects the mode. The server answers ONLY ids this
   * account owns and omits the rest silently, so the response is not an existence oracle — which is why the rows
   * carry their own `messageId` and the engine matches on it rather than on position. UNDER THE SAME DEADLINE AS
   * `fetchBody`, and for the same reason: this call is what a thread IS, the engine writes `loading` markers before
   * it, and a request the server accepts and never answers would leave every one of those markers as a permanent
   * spinner ({@link BODY_FETCH_TIMEOUT_MS} — the state is only recoverable because the deadline exists). One batch is
   * one round trip, so it earns the same twelve seconds one body does rather than a multiple of it.
   */

  /**
   * A non-2xx THROWS, through the same `rejectionOf` reader everything else uses; the engine turns that into a
   * `failed` record for each id in the batch. An unrecognised payload narrows to an empty list rather than throwing,
   * so the engine's per-id fallback covers a server that does not understand the parameter — the old behaviour, not
   * an empty thread.
   */
  async fetchBodies(messageIds: string[]): Promise<MessageBodyBatchWire[]> {
    const ids = messageIds.map((id) => encodeURIComponent(id)).join(",");
    return this.withDeadline(BODY_FETCH_TIMEOUT_MS, async (signal) => {
      const res = await this.request("GET", `/messages/bodies?ids=${ids}`, { signal });
      if (!res.ok) throw await this.rejectionOf(res);
      const page = (await res.json()) as { items?: unknown };
      if (!Array.isArray(page.items)) return [];
      const out: MessageBodyBatchWire[] = [];
      for (const raw of page.items) {
        const row = raw as Partial<MessageBodyBatchWire>;
        // A row with no id is unusable — it cannot be matched to a message, and guessing by
        // position is exactly what the omission rule above forbids. Dropped, so the id it was
        // meant for falls to the per-message path rather than onto the wrong message.
        if (typeof row.messageId !== "string") continue;
        out.push({ messageId: row.messageId, ...narrowBody(row) });
      }
      return out;
    });
  }


  /**
   * `POST /messages/:id/unsubscribe` — one-click, performed by the SERVER (invariant: the
   * reader is never in the loop). The body is empty; the id in the path is the only input, and
   * the URL is read from the message's stored headers server-side, so a caller cannot name a
   * host. A non-2xx THROWS through `rejectionOf`, so a 409 refusal arrives carrying the server's
   * own sentence ("this sender only offers unsubscribe by email…") rather than as `HTTP 409`.
   */
  async unsubscribe(messageId: string): Promise<UnsubscribeResult> {
    const res = await this.request("POST", `/messages/${encodeURIComponent(messageId)}/unsubscribe`, { body: {} });
    if (!res.ok) throw await this.rejectionOf(res);
    const wire = (await res.json()) as Partial<UnsubscribeResult>;
    const REFUSALS: readonly UnsubscribeRefusal[] = [
      "not_actionable", "author_failed_authentication", "no_header", "mailto_only",
      "not_one_click", "already_recorded",
    ];
    return {
      messageId: typeof wire.messageId === "string" ? wire.messageId : messageId,
      posted: wire.posted === true,
      status: typeof wire.status === "number" ? wire.status : null,
      refusal:
        typeof wire.refusal === "string" && (REFUSALS as string[]).includes(wire.refusal)
          ? (wire.refusal as UnsubscribeRefusal)
          : null,
      header:
        wire.header === "one_click" ||
        wire.header === "mailto_only" ||
        wire.header === "not_one_click"
          ? wire.header
          : "no_header",
    };
  }

  /**
   * `GET /search` — the full corpus, which is nearly all of the body text the on-device index
   * does not hold: the local index sees a 200-character snippet per message and nothing past it.
   *
   * Throws rather than resolving empty, for the same reason `fetchBody` does: a 402 arrives
   * carrying the server's own sentence about spent credits, and rendering "nothing matched"
   * over a refusal would be a lie the user cannot see through.
   */
  async searchServer(query: string, opts: ServerSearchOpts = {}): Promise<ServerSearchWire> {
    const q = new URLSearchParams({ q: query });
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    /**
     * `relevance` IS NOT SENT. It is the server's default and the endpoint's whole prior
     * behaviour, so leaving the parameter off means this build asks an older deploy exactly the
     * question it asked before — no 400 from a server that predates `?sort=`, and no flag day
     * between the client and the API. Every other value is explicit, and an unknown one is
     * refused by the route rather than coerced, which is what makes that silence safe.
     */
    if (opts.sort !== undefined && opts.sort !== "relevance") q.set("sort", opts.sort);
    const res = await this.request("GET", `/search?${q.toString()}`);
    if (!res.ok) throw await this.rejectionOf(res);
    const wire = (await res.json()) as { items?: EngineMessage[]; total?: number; tier?: string };
    // Forward-compatible (§8): `facets` is deliberately unread — its folder keys are raw IMAP
    // paths, and the client keys its own facets by view id.
    return {
      items: Array.isArray(wire.items) ? wire.items : [],
      total: typeof wire.total === "number" ? wire.total : (wire.items?.length ?? 0),
      // `similar` only when the server says so, and every other reading — absent, unknown
      // string, a deploy that predates the field — is `exact`. Read `ServerSearchWire.tier`
      // for why the unknown case takes that side rather than the cautious-looking one.
      tier: wire.tier === "similar" ? "similar" : "exact",
    };
  }

  /**
   * `GET /search?address=<addr>&direction=from` — every message in the archive FROM one address. **`direction=from`
   * IS ALWAYS SENT, EXPLICITLY, and that is the opposite of the `sort` decision one method up.** `sort=relevance` is
   * left off the wire because it is the server's default and omitting it asks an older deploy the question it always
   * answered. There is no such default here: a deploy that predates the address arm ignores an unknown `address` and
   * runs a TEXT search for the empty string, which answers `200` with an empty result — a client that read that as
   * "the archive holds nothing from this person" would state it on screen.
   */

  /**
   * Sending the parameter does not fix that (nothing can, from this side), but the value is required by the route on
   * every deploy that HAS the arm, and the route refuses an absent or unknown direction rather than assuming one, so
   * no build of this client can be answered a different question than it asked. The address is NOT lowercased here.
   * The server compares `lower(from_address) = lower($1)`, so the case-folding is one rule in one place; folding it a
   * second time on the client would be a second place for the two to disagree about what an address is.
   */
  async searchAddressServer(
    address: string, opts: ServerAddressOpts = {},
  ): Promise<ServerAddressWire> {
    const q = new URLSearchParams({ address, direction: "from" });
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const res = await this.request("GET", `/search?${q.toString()}`);
    if (!res.ok) throw await this.rejectionOf(res);
    const wire = (await res.json()) as { items?: EngineMessage[]; total?: number; direction?: string };
    return {
      items: Array.isArray(wire.items) ? wire.items : [],
      total: typeof wire.total === "number" ? wire.total : (wire.items?.length ?? 0),
      // Forward-compatible (§8): the engine re-reads this against its own vocabulary and falls
      // back to `from`, so an unknown word never reaches a label. Passed through as-is here.
      ...(wire.direction !== undefined ? { direction: wire.direction as ServerAddressWire["direction"] } : {}),
    };
  }

  /**
   * `GET /messages?view=&cursor=` — one keyset page of a view, oldest-ward. Mounted since Stage 2 with no caller: the
   * mirror held the whole mailbox, so nothing was ever past the end of a list; a windowed client changes that
   * (`StorePolicy`), and this is the only way back to the mail it chose not to keep. Optional on the engine's side,
   * not a member of `EngineAdapter` — a client with no server must read as "nothing beyond this list", not broken; a
   * wrapper must forward it explicitly. `cursor` is the server's opaque keyset token, never a `/sync` cursor; a
   * missing `nextCursor` means "last page" and a missing `items` is an empty page; a non-2xx throws through
   * `rejectionOf`.
   */

  /**
   * The view name is TRANSLATED, not forwarded ({@link SERVER_VIEW_OF}): the client and server share exactly one of
   * six pile words, and the mismatch does not fail loudly — five views are refused with internal vocabulary and the
   * sixth works, reading as an intermittent fault. A view the server has no list for resolves `null` — the same
   * "nothing behind this list" a serverless client reports.
   */
  async listMessages(
    view: OhmailView | "folder",
    opts: {
      cursor?: string; limit?: number; folderId?: string;
      startBelow?: { date: string | null; id: string };
    } = {},
  ): Promise<ListOlderWire | null> {
    // A FOLDER page (the folders foundation): the entity id is the whole address — the server
    // resolves it, scoped to the account and gated on the account's own "Use folders" flag.
    if (view === "folder") {
      if (!opts.folderId) return null;
      const qf = new URLSearchParams({ view: "folder", folderId: opts.folderId });
      if (opts.cursor) qf.set("cursor", opts.cursor);
      else if (opts.startBelow) {
        // The mirror boundary: only meaningful on page one — a cursor supersedes it.
        if (opts.startBelow.date !== null) qf.set("beforeDate", opts.startBelow.date);
        qf.set("beforeId", opts.startBelow.id);
      }
      if (opts.limit !== undefined) qf.set("limit", String(opts.limit));
      const resf = await this.request("GET", `/messages?${qf.toString()}`);
      if (!resf.ok) throw await this.rejectionOf(resf);
      const wiref = (await resf.json()) as { items?: EngineMessage[]; nextCursor?: string | null };
      return {
        items: Array.isArray(wiref.items) ? wiref.items : [],
        nextCursor: typeof wiref.nextCursor === "string" && wiref.nextCursor !== "" ? wiref.nextCursor : null,
      };
    }
    const serverView = SERVER_VIEW_OF[view];
    if (serverView === null) return null;
    const q = new URLSearchParams({ view: serverView });
    if (opts.cursor) q.set("cursor", opts.cursor);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const res = await this.request("GET", `/messages?${q.toString()}`);
    if (!res.ok) throw await this.rejectionOf(res);
    const wire = (await res.json()) as { items?: EngineMessage[]; nextCursor?: string | null };
    return {
      items: Array.isArray(wire.items) ? wire.items : [],
      nextCursor: typeof wire.nextCursor === "string" && wire.nextCursor !== "" ? wire.nextCursor : null,
    };
  }

  // ── Trash ────────────────────────────────────────────────────────────────

  /**
   * `GET /messages?view=trash&cursor=` — one keyset page of mail this account deleted in ohmail. `view=trash` is
   * passed as the literal and NOT through {@link SERVER_VIEW_OF}: that table maps the client's six pile names onto
   * the server's, and Trash is not one of them — it is the provider's own folder, and both ends already spell it the
   * same way. Putting it in that table would invite the next reader to think Trash is a seventh pile. The rows in
   * this page are TOMBSTONED on the server's side (every other list excludes `deleted_at`), so `trashedAt` and
   * `restoreTo` ride along per item. Both are read forward-compatibly (§8) — a server that predates them sends
   * neither, and the engine's type has them optional, so the view falls back to the message's own date and to the
   * inbox, which is what those two values MEAN when nothing said otherwise.
   */

  /**
   * A non-2xx THROWS through `rejectionOf`, exactly as `listMessages` does, so a 402 from the spend gate arrives
   * carrying the server's own sentence.
   */
  async listTrash(opts: { cursor?: string; limit?: number } = {}): Promise<ListTrashWire | null> {
    const q = new URLSearchParams({ view: "trash" });
    if (opts.cursor) q.set("cursor", opts.cursor);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const res = await this.request("GET", `/messages?${q.toString()}`);
    if (!res.ok) throw await this.rejectionOf(res);
    const wire = (await res.json()) as { items?: TrashRowWire[]; nextCursor?: string | null };
    return {
      items: Array.isArray(wire.items) ? wire.items : [],
      nextCursor: typeof wire.nextCursor === "string" && wire.nextCursor !== "" ? wire.nextCursor : null,
    };
  }

  /**
   * `POST /messages/:id/restore` — put one deleted message back where it was. The `Idempotency-Key` is the caller's,
   * when it has one. The route is `idempotent`-marked, so a replay under the same key is answered with the first
   * response — a client whose first response was lost after the commit used to meet the state check and be told 409
   * `not_in_trash` about a restore the server was already committed to. A second PRESS is a different intent with a
   * different key and still meets that check. No key ⇒ no header, and the request is what it was. `restoreTo` is the
   * SERVER's answer, which may not equal the row's rendered one — the origin folder can disappear between the page
   * and the press — so it is read off the response rather than assumed. `pending` defaults true when absent: the
   * honest reading of a missing field here is "the mail server has not done it yet", never "it is done".
   */
  async restoreFromTrash(
    messageId: string, opts: { idempotencyKey?: string } = {},
  ): Promise<RestoreFromTrashWire | null> {
    const res = await this.request(
      "POST", `/messages/${encodeURIComponent(messageId)}/restore`,
      opts.idempotencyKey === undefined ? {} : { idempotencyKey: opts.idempotencyKey },
    );
    if (!res.ok) throw await this.rejectionOf(res);
    const wire = (await res.json()) as { restoreTo?: string; pending?: boolean };
    return {
      restoreTo: typeof wire.restoreTo === "string" && wire.restoreTo !== "" ? wire.restoreTo : "INBOX",
      pending: wire.pending !== false,
    };
  }

  // ── attachments ──────────────────────────────────────────────────────────

  /**
   * `GET /messages/:id/attachments` — the metadata read, no bytes, no IMAP connection. The route is `cost: "read"`,
   * unlike the two byte methods below (`cost: "connection"` — serving them opens a socket to the user's mail server);
   * that difference is why metadata is a separate call. Forward-compatible parsing (§8): every field guarded, so a
   * row predating a column degrades to a rendered fallback rather than `undefined` on screen; `inline` defaults
   * false-ish and is filtered in the engine.
   */

  /**
   * The only bounded call in this file ({@link ATTACHMENT_LIST_TIMEOUT_MS} via {@link HttpAdapter.withDeadline}), for
   * a reason rather than by omission — see `request()` for the arguments against a blanket deadline: this call is the
   * cheapest thing to abandon in the protocol (a GET, one indexed row, no effect, no IMAP slot), and its silence is
   * total — the strip renders `loading` as nothing, so a hang draws a paperclip over an empty message for as long as
   * the tab lives.
   */
  async listAttachments(messageId: string): Promise<AttachmentWire[]> {
    return this.withDeadline(ATTACHMENT_LIST_TIMEOUT_MS, async (signal) => {
      const res = await this.request("GET", `/messages/${encodeURIComponent(messageId)}/attachments`, { signal });
      if (!res.ok) throw await this.rejectionOf(res);
      const wire = (await res.json()) as { items?: unknown };
      if (!Array.isArray(wire.items)) return [];
      return wire.items.map((raw): AttachmentWire => {
        const r = raw as Partial<AttachmentWire>;
        return {
          id: String(r.id ?? ""),
          filename: typeof r.filename === "string" ? r.filename : null,
          contentType: typeof r.contentType === "string" ? r.contentType : "application/octet-stream",
          sizeBytes: typeof r.sizeBytes === "number" && Number.isFinite(r.sizeBytes) ? r.sizeBytes : 0,
          inline: r.inline === true,
          contentId: typeof r.contentId === "string" && r.contentId !== "" ? r.contentId : null,
          messageId: typeof r.messageId === "string" ? r.messageId : messageId,
        };
      }).filter((a) => a.id !== "");
    });
  }

  /**
   * `GET /attachments/:id` — the bytes, live from the user's IMAP mailbox. ## The response is TWO different content
   * types and the branch order matters This route is `raw`: on success it answers `application/octet-stream` with the
   * file, but on failure it answers the ordinary JSON error envelope. So `res.ok` has to be checked BEFORE `blob()` —
   * reading the body as a Blob first would turn a 413's explanatory JSON into a "file" the surface would happily hand
   * the user as a download named after their PDF. `rejectionOf` carries the server's `code` through, which is what
   * lets the engine tell the size ceiling (`payload_too_large` → the `too_large` state, a sentence about the limit)
   * apart from a mail server that is simply down (`upstream_unavailable` → `failed`, a retry is reasonable).
   */
  async fetchAttachment(attachmentId: string): Promise<Blob> {
    const res = await this.request("GET", `/attachments/${encodeURIComponent(attachmentId)}`);
    if (!res.ok) throw await this.rejectionOf(res);
    return await res.blob();
  }

  /**
   * `POST /messages/:id/attachments/download-all` — the whole set as one zip.
   *
   * A POST with no body: the message id is in the path and the route reads nothing else. It still
   * goes through `request()`, which attaches the `X-CSRF-Token` every unsafe method needs (§1.3).
   *
   * Same two-content-type branch as `fetchAttachment` — zip on 200, JSON envelope on error — so
   * `res.ok` is checked first for the same reason.
   */
  async fetchAllAttachments(messageId: string): Promise<Blob> {
    const res = await this.request("POST", `/messages/${encodeURIComponent(messageId)}/attachments/download-all`);
    if (!res.ok) throw await this.rejectionOf(res);
    return await res.blob();
  }

  // ── mutations ────────────────────────────────────────────────────────────

  /** A message-DTO echo becomes one authoritative change at the echoed seq (§3.4). */
  private messageEcho(dto: EngineMessage, seq: number, op: "update" | "move", move?: { from: null; to: EngineMessage["folder"] }): SyncChange {
    return {
      type: "message",
      op,
      id: dto.id,
      seq,
      updatedAt: dto.updatedAt,
      entity: dto,
      ...(move ? { move } : {}),
    };
  }

  async mutate(m: EngineMutation, opts: { idempotencyKey: string }): Promise<MutationOutcome> {
    switch (m.kind) {
      case "move": {
        const res = await this.request("POST", `/messages/${m.messageId}/move`, {
          body: { folder: m.folder },
          idempotencyKey: opts.idempotencyKey,
        });
        if (!res.ok) throw await this.rejectionOf(res);
        const seq = this.noteSeq(res);
        const dto = (await res.json()) as EngineMessage;
        return {
          changes: seq !== null ? [this.messageEcho(dto, seq, "move", { from: null, to: m.folder })] : [],
          seq,
        };
      }

      case "message_delete": {
        const res = await this.request("DELETE", `/messages/${m.messageId}`, {
          idempotencyKey: opts.idempotencyKey,
        });
        if (!res.ok) throw await this.rejectionOf(res);
        const seq = this.noteSeq(res);
        const dto = (await res.json()) as EngineMessage;
        // The echo is the tombstone, at the echoed seq — op:"delete" carries no entity (§3.4),
        // and the apply core turns it into `entity: null` for every selector.
        return {
          changes: seq !== null
            ? [{ type: "message", op: "delete", id: dto.id, seq, updatedAt: dto.updatedAt }]
            : [],
          seq,
        };
      }

      case "triage_set": {
        const res = await this.request("POST", `/messages/${m.messageId}/triage`, {
          body: { state: m.state, ...(m.bubbleUpAt ? { bubbleUpAt: m.bubbleUpAt } : {}) },
          idempotencyKey: opts.idempotencyKey,
        });
        if (!res.ok) throw await this.rejectionOf(res);
        // The triage endpoint returns the MessageStateDTO without an X-Sync-Seq
        // echo — the engine reconciles via the next /sync drain.
        return { changes: [], seq: this.noteSeq(res) };
      }

      case "screener_decide": {
        const res = await this.request("POST", `/screener/${m.senderId}`, {
          body: {
            decision: m.decision,
            // THE DESTINATION, TRANSLATED TO THE SERVER'S VOCABULARY: `dest` is a VIEW on this side (`reads`) and a
            // FOLDER on the wire (`ohmail/Reads`), because every other endpoint that names a place already takes a
            // folder: `POST /messages/:id/move` takes `{folder}` and `POST /rules` takes `{destination}`. A second
            // spelling reachable only here is a translation somebody has to remember; this is the one line that does
            // it. OMITTED when absent rather than sent as `null`: the server reads an absent `dest` as the two-folder
            // default it has always had, which is what keeps a client that predates this field working unchanged.
            ...(m.dest ? { dest: FOLDER_OF_VIEW[m.dest] } : {}),
            ...(m.scope ? { scope: m.scope } : {}),
          },
          idempotencyKey: opts.idempotencyKey,
        });
        if (!res.ok) throw await this.rejectionOf(res);
        // Response is { messageId, appliedFolder, createdRuleId } — the moved held mail + promoted rule arrive
        // authoritatively via /sync. EXCEPT ON A MAILBOX THIS ACCOUNT DOES NOT ORGANIZE: There the server answers
        // `202 { pending: true, requestId, holder }`: the decision is recorded for the install that DOES organize the
        // mailbox, and nothing has been filed. That answer has to reach the caller, because nothing else will ever
        // mention it — a queued decision writes no `change_log` row, so the drain below carries nothing, the
        // optimistic overlay is dropped on confirm, and the sender comes back looking undecided. READ DEFENSIVELY,
        // and a body this code cannot parse is simply not a queued decision: the shapes that reach here are a 200
        // with a decision result, a 200 from an older server, and this.

        // Guessing `pending` from anything less than the flag itself would withhold a filing that did happen.
        const decided = await res.json().catch(() => null) as
          { pending?: unknown; holder?: { name?: unknown } | null } | null;
        const seq = this.noteSeq(res);
        if (decided && decided.pending === true) {
          const name = typeof decided.holder?.name === "string" && decided.holder.name.trim()
            ? decided.holder.name
            : null;
          return { changes: [], seq, pendingWith: { name } };
        }
        return { changes: [], seq };
      }

      case "feed_mark_seen": {
        // No batch endpoint — one PATCH per message (idempotent by definition,
        // §1.6); each echoes the updated DTO + X-Sync-Seq.
        //
        // `via: "glance"` on every one, because this verb IS the involuntary read (the per-card
        // dwell, the leave-commit): the server marks read WITHOUT spending a resurface pin, so
        // a sweep that covers a pinned row reads it and leaves the pin standing — the same
        // thing the overlay paints (`mutations.ts#feed_mark_seen`).
        const changes: SyncChange[] = [];
        let seq: number | null = null;
        for (const id of m.messageIds ?? []) {
          const res = await this.request("PATCH", `/messages/${id}`, { body: { unread: false, via: "glance" } });
          if (!res.ok) throw await this.rejectionOf(res);
          const s = this.noteSeq(res);
          const dto = (await res.json()) as EngineMessage;
          if (s !== null) {
            changes.push(this.messageEcho(dto, s, "update"));
            seq = s;
          }
        }
        return { changes, seq };
      }

      case "mark_seen": {
        // ONE capped batch request — `PATCH /messages { ids, unread }`. The per-message loop `feed_mark_seen` runs
        // above is what this replaces: N requests meant N transactions and N chances to leave a selection
        // half-flipped, and it could not carry one Idempotency-Key for one user intent. No echo is turned into
        // changes. The route emits one `change_log` row per message at DISTINCT seqs, and `X-Sync-Seq` can only carry
        // the last of them, so fabricating N changes at one seq would write the mirror's cursor past deltas it never
        // applied. The engine's `dispatch` sees `changes: []` and pulls the authoritative drain instead — the same
        // contract `triage_set` and `screener_decide` already use, and the overlay holds the user's view steady until
        // it lands.

        // `via` travels when the surface set it: a glance-labelled read must reach the server AS a glance, so it
        // marks read without spending a resurface pin (`MessageService.markSeen`). Deliberate reads (no `via`) keep
        // answering pins exactly as before.
        const res = await this.request("PATCH", "/messages", {
          body: { ids: m.messageIds, unread: m.unread, ...(m.via ? { via: m.via } : {}) },
          idempotencyKey: opts.idempotencyKey,
        });
        if (!res.ok) throw await this.rejectionOf(res);
        return { changes: [], seq: this.noteSeq(res) };
      }

      case "mail_send":
        return this.mailSend(m, opts.idempotencyKey);

      /**
       * THIS CASE IS WHERE TAGS REACH THE WIRE. It threw `UnsupportedMutationError` until it existed, which made a
       * fully-built tag UI do nothing on every real account: the picker, the `t` shortcut and the bulk verb all
       * called `mutate`, the optimistic effect painted the tag on the row, and the adapter then rejected it — so the
       * overlay rolled back and the tag vanished, with no error a user could see. Fixtures served it in place and
       * stayed green throughout. THE BODY IS A DELTA, NOT `m.labels`. The mutation carries a full next-labels array
       * (filled by `Engine.enrich`) for the OPTIMISTIC effect, and sending that array to the server would be a
       * read-modify-write: two concurrent toggles of DIFFERENT tags on one message each compute their array from the
       * same starting state, and whichever request lands second silently erases the other's tag.
       */

      /**
       * So the local effect uses the array and the wire uses `{ tagId, assigned }` — one row, idempotent in both
       * directions (`INSERT … ON CONFLICT DO NOTHING` / `DELETE`), and immune to that race. No echo is turned into
       * changes, matching `triage_set` and `mark_seen`: the route emits a `message` update, `dispatch` sees `changes:
       * []` and pulls the authoritative drain, and the overlay holds the user's view steady until it lands.
       */
      case "tag_assign": {
        const res = await this.request("POST", `/messages/${encodeURIComponent(m.messageId)}/tags`, {
          body: m.createName === undefined
            ? { tagId: m.tagId, assigned: m.assigned }
            // TAG-OR-CREATE: the name the user typed, plus the id to mint it under, so the
            // optimistic paint and the stored row agree. An existing name wins over the id.
            : { tagId: m.tagId, name: m.createName, assigned: m.assigned },
          idempotencyKey: opts.idempotencyKey,
        });
        if (!res.ok) throw await this.rejectionOf(res);
        return { changes: [], seq: this.noteSeq(res) };
      }

      /**
       * THE TAG CRUD REACHES THE WIRE. `POST /tags`, `PATCH /tags/:id` and `DELETE /tags/:id` have been mounted and
       * contract-tested since the tags backend landed, with no caller — the same "built, tested, unreachable" shape
       * the rules CRUD below was in, and the one `tag_assign`'s own comment in `types.ts` records for `tag_assign`
       * itself. THE ID IS NOT SENT, AND THAT IS THE `rule_create` PRECEDENT, NOT AN OVERSIGHT: `POST /tags` takes `{
       * name, hue? }` and the database mints the id (`TagsService.create` inserts without one). So the optimistic
       * row's `tagId` is a CLIENT-LOCAL name for a row that does not exist yet, exactly as `rule_create`'s
       * `ctx.uuid()` is: the overlay is deleted the moment the mutation confirms, and the server's own row arrives in
       * the `create` change returned here. The two ids never have to agree because they never coexist.
       */

      /**
       * Sending the client's id would be worse than useless — the server ignores it, and a reader of this code would
       * believe the row was created under it.
       */
      case "tag_create": {
        const res = await this.request("POST", "/tags", {
          body: m.hue === undefined ? { name: m.name } : { name: m.name, hue: m.hue },
          idempotencyKey: opts.idempotencyKey,
        });
        if (!res.ok) throw await this.rejectionOf(res);
        const seq = this.noteSeq(res);
        const dto = (await res.json()) as TagDTO;
        return {
          changes: seq === null ? [] : [{ type: "tag", op: "create", id: dto.id, seq, updatedAt: dto.updatedAt ?? dto.createdAt ?? "", entity: dto }],
          seq,
        };
      }

      case "tag_rename": {
        const res = await this.request("PATCH", `/tags/${encodeURIComponent(m.tagId)}`, {
          body: { name: m.name },
          idempotencyKey: opts.idempotencyKey,
        });
        if (!res.ok) throw await this.rejectionOf(res);
        const seq = this.noteSeq(res);
        const dto = (await res.json()) as TagDTO;
        return {
          changes: seq === null ? [] : [{ type: "tag", op: "update", id: dto.id, seq, updatedAt: dto.updatedAt ?? dto.createdAt ?? "", entity: dto }],
          seq,
        };
      }

      /**
       * RECOLOUR — the {@link tag_rename} PATCH with `hue` in place of `name`. The two are
       * separate verbs, not one wide one, so each request carries exactly the field that
       * changed; `TagsService.update` merges whatever is sent over what it holds.
       */
      case "tag_recolor": {
        const res = await this.request("PATCH", `/tags/${encodeURIComponent(m.tagId)}`, {
          body: { hue: m.hue },
          idempotencyKey: opts.idempotencyKey,
        });
        if (!res.ok) throw await this.rejectionOf(res);
        const seq = this.noteSeq(res);
        const dto = (await res.json()) as TagDTO;
        return {
          changes: seq === null ? [] : [{ type: "tag", op: "update", id: dto.id, seq, updatedAt: dto.updatedAt ?? dto.createdAt ?? "", entity: dto }],
          seq,
        };
      }

      /**
       * 204 WITH NO BODY, and a 404 is success — the same reading `rule_delete` uses below.
       * The tag is gone either way, which is what the caller asked for; treating "already
       * gone" as a failure would roll back an optimistic delete that was correct.
       *
       * No `changes` are returned even though the server appends one `message` change per
       * message that carried the tag: a 204 carries no payload to read them from. They arrive
       * on the next drain, and the optimistic effect has already cleared the chips.
       */
      case "tag_delete": {
        const res = await this.request("DELETE", `/tags/${encodeURIComponent(m.tagId)}`, {
          idempotencyKey: opts.idempotencyKey,
        });
        if (res.status === 404) return { changes: [], seq: null };
        if (!res.ok) throw await this.rejectionOf(res);
        return { changes: [], seq: this.noteSeq(res) };
      }

      /**
       * ═══ THE FOLDER VERBS REACH THE WIRE (FOLDERS-SPEC.md stage 2) ═══════════════════════
       *
       * Every verb answers the subject's fresh DTO wearing its PENDING MARKER (`FolderDTO.op`)
       * — the API records the command; the worker executes it seconds later and the settled
       * entity arrives on the drain. The echo is returned as a change so the server's own
       * pending row replaces the optimistic one (create swaps the client-local id for the
       * server's, exactly `tag_create`'s two-ids-never-coexist rule).
       */
      case "folder_create": {
        const res = await this.request("POST", "/folders", {
          body: { mailboxId: m.mailboxId, name: m.name },
          idempotencyKey: opts.idempotencyKey,
        });
        if (!res.ok) throw await this.rejectionOf(res);
        const seq = this.noteSeq(res);
        const dto = (await res.json()) as FolderEntity;
        return {
          changes: seq === null ? [] : [{ type: "folder", op: "create", id: dto.id, seq, updatedAt: dto.updatedAt ?? "", entity: dto }],
          seq,
        };
      }

      case "folder_rename": {
        const res = await this.request("PATCH", `/folders/${encodeURIComponent(m.folderId)}`, {
          body: { name: m.name },
          idempotencyKey: opts.idempotencyKey,
        });
        if (!res.ok) throw await this.rejectionOf(res);
        const seq = this.noteSeq(res);
        const dto = (await res.json()) as FolderEntity;
        return {
          changes: seq === null ? [] : [{ type: "folder", op: "update", id: dto.id, seq, updatedAt: dto.updatedAt ?? "", entity: dto }],
          seq,
        };
      }

      /**
       * DELETE answers 200 WITH the DTO — the entity persists, wearing `op: { kind: "delete" }`,
       * until the worker's sweep finishes and the tombstones drain. A 404 is success, the
       * `tag_delete` reading: the folder is gone, which is what the caller asked for.
       */
      case "folder_delete": {
        const res = await this.request("DELETE", `/folders/${encodeURIComponent(m.folderId)}`, {
          idempotencyKey: opts.idempotencyKey,
        });
        if (res.status === 404) return { changes: [], seq: null };
        if (!res.ok) throw await this.rejectionOf(res);
        const seq = this.noteSeq(res);
        const dto = (await res.json()) as FolderEntity;
        return {
          changes: seq === null ? [] : [{ type: "folder", op: "update", id: dto.id, seq, updatedAt: dto.updatedAt ?? "", entity: dto }],
          seq,
        };
      }

      /**
       * DISMISS a failed command. The answer is either the folder shed of its marker (rename/
       * delete refusals) or `{ dismissed: true }` — a failed CREATE took its row with it, and
       * the authoritative `folder` delete arrives on the drain the empty `changes` triggers.
       */
      case "folder_op_dismiss": {
        const res = await this.request("DELETE", `/folders/${encodeURIComponent(m.folderId)}/op`, {
          idempotencyKey: opts.idempotencyKey,
        });
        if (res.status === 404) return { changes: [], seq: null };
        if (!res.ok) throw await this.rejectionOf(res);
        const seq = this.noteSeq(res);
        const body = (await res.json()) as FolderEntity | { dismissed: true };
        if (!("id" in body)) return { changes: [], seq };
        return {
          changes: seq === null ? [] : [{ type: "folder", op: "update", id: body.id, seq, updatedAt: body.updatedAt ?? "", entity: body }],
          seq,
        };
      }

      /**
       * The rules CRUD reaches the wire — `DELETE /rules/:id` and `PATCH /rules/:id`, mounted and
       * contract-tested since the rules backend landed, with no caller until this case. A 204
       * carries no body, so `changes: []` is not a chosen no-echo — there is literally no DTO;
       * `dispatch` turns it into an immediate `syncOnce()`, and the optimistic tombstone holds the
       * row off screen until the authoritative delete lands. `PATCH` does return the updated
       * `RuleDTO` and is echoed: one row at one seq, so the `mark_seen` objection does not arise.
       */

      /**
       * A 404 on a delete is the outcome that was asked for: `RulesService.remove` throws `not_found` on zero rows,
       * and every lookup is account-scoped, so 404 means exactly "no such rule on this account" — the state a revoke
       * is trying to reach. Three ordinary paths produce it: a second tab that revoked first, a queued retry whose
       * reply was lost, a double-click. Treating it as a rejection rolls the tombstone back — the revoked rule
       * REAPPEARS, then the next drain removes it again: the user watches their own action fail and un-fail.
       * Swallowed HERE and not at the call site, because every caller is equally right to be told the rule is gone,
       * and HTTP already says DELETE is idempotent; `seq: null` is honest — nothing was written this time.
       */

      /**
       * Nothing else is swallowed: 403, 429 and 500 all still throw — the first two because the user genuinely may
       * not, the last because the rule may well still be there.
       */
      case "rule_delete": {
        const res = await this.request("DELETE", `/rules/${encodeURIComponent(m.ruleId)}`, {
          idempotencyKey: opts.idempotencyKey,
        });
        if (res.status === 404) return { changes: [], seq: null };
        if (!res.ok) throw await this.rejectionOf(res);
        return { changes: [], seq: this.noteSeq(res) };
      }

      case "rule_update": {
        const res = await this.request("PATCH", `/rules/${encodeURIComponent(m.ruleId)}`, {
          body: { destination: m.destination },
          idempotencyKey: opts.idempotencyKey,
        });
        if (!res.ok) throw await this.rejectionOf(res);
        const seq = this.noteSeq(res);
        const dto = (await res.json()) as RuleDTO;
        return {
          changes: seq === null ? [] : [{ type: "rule", op: "update", id: dto.id, seq, updatedAt: dto.updatedAt, entity: dto }],
          seq,
        };
      }

      /**
       * `POST /rules` — mounted since §5.6 and called by nothing: only the Screener's own endpoint ever created a
       * rule. This case makes "rule this sender" reachable from the Ohbox, Reads and Receipts, where `POST
       * /screener/:id` answers 404 because the mail has left the gate. The body is three fields, and `priority` is
       * deliberately not one: `validPriority` defaults to 0 and `enabled` to true — what the optimistic row claims —
       * and a client asserting a ranking would be choosing precedence (`compareRules` ranks priority FIRST) from a
       * sheet that offers no such control. The echo is safe here: 201 returns the created `RuleDTO` with `X-Sync-Seq`
       * — one entity at one seq, so echoing cannot move the cursor past deltas the mirror never applied (the
       * objection that stops `mark_seen`); a missing header degrades to `changes: []` and `dispatch` pulls the drain.
       */

      /**
       * The key is honoured now, and this paragraph used to say it was not: a retryable failure replayed by
       * `flushPending` once wrote a second identical rule. The route now marks the POST `idempotent`, AND — the half
       * marking alone would not supply — `RulesService.create` claims the key with `claimIdempotencyKey` INSIDE its
       * own insert transaction, storing the verbatim 201 (a claim outside the transaction still lets the concurrent
       * case mint two rows, which is why the service does it and not the middleware). A replayed key hands back the
       * FIRST rule; the same key with a different body is a 409, never a silent second rule. Nothing on this line
       * changed for that to become true — the key was already being forwarded against the day the claim landed.
       */
      case "rule_create": {
        const res = await this.request("POST", "/rules", {
          body: {
            kind: m.ruleKind, match: m.match, destination: m.destination,
            // The second term, and OMITTED rather than sent as `null` when there is none — unlike
            // `applyRetro` one line down, and for the opposite reason. `applyRetro`'s default is a
            // DECISION this client owns, so it states it explicitly; `subjectContains` has no
            // default to own (absent means "an ordinary one-term rule"), and sending `null` on every
            // rule the sender sheet writes would put a field in the request body of a caller that
            // has nothing to say about it — and in the `Idempotency-Key` request hash of every one
            // of them, changing the hash of requests whose meaning did not change.
            ...(m.subjectContains ? { subjectContains: m.subjectContains } : {}),
            // The third term (mail 0052): omitted when absent, on the line above's reasoning —
            // no default to own, and no `null` in the idempotency hash of callers with nothing
            // to say about it.
            ...(m.bodyContains ? { bodyContains: m.bodyContains } : {}),
            // Sent on every call, never omitted. The server treats an absent field as `true`;
            // the surface decides what actually ships, from one constant it can flip in one
            // line (`sender-screening.ts#RETRO_DEFAULT_ON`). `?? true` keeps a caller that has
            // not been updated on the server's own default rather than silently declining.
            applyRetro: m.applyRetro ?? true,
          },
          idempotencyKey: opts.idempotencyKey,
        });
        if (!res.ok) throw await this.rejectionOf(res);
        const seq = this.noteSeq(res);
        const dto = (await res.json()) as RuleDTO;
        return {
          changes: seq === null ? [] : [{ type: "rule", op: "create", id: dto.id, seq, updatedAt: dto.updatedAt, entity: dto }],
          seq,
        };
      }

      /**
       * Autosave — `POST /drafts` on a create, `PUT /drafts/:id` on an update; both mounted since the drafts backend
       * landed, one with a single caller and one with none. The create returns its id, and that is the point:
       * `entityId` lets the surface adopt it, so the next autosave PUTs the same row and the send sends it — without
       * it, every two seconds of typing is a new `drafts` row. The echo also goes into `changes`, so the mirror holds
       * the real row under the real id while the client-local overlay drops. One of `body`/`html`, never both —
       * identical to the send path: `DraftsService` derives the plain half from the sanitized markup and refuses a
       * request asserting what plaintext readers see.
       */

      /**
       * No `Idempotency-Key` replay is relied on: the key is forwarded, and a retried autosave is harmless either way
       * — a PUT is set-to-a-value, a duplicated POST leaves one empty-ish draft. Nothing here sends.
       */
      case "draft_save": {
        const fields = {
          subject: m.subject,
          ...(m.html ? { html: m.html } : { body: m.body }),
          to: m.to,
          cc: m.cc,
          bcc: m.bcc,
        };
        if (m.draftId === null && this.createAttempted.has(opts.idempotencyKey)) {
          // A create under this key already went out and its answer was unreadable — see
          // `createAttempted`. `POST /drafts` ignores the key, so trying again writes a SECOND
          // draft rather than returning the first, and an autosave loop turns that into one new
          // draft per attempt.
          throw new MutationRejectedError(
            "ohmail could not tell whether this draft was created, and will not create a second "
              + "one. Reload to see what the server has.",
            { code: "draft_unverified", status: null, retryable: false },
          );
        }
        if (m.draftId === null) {
          const res = await this.request("POST", "/drafts", {
            body: {
              mailboxId: m.mailboxId,
              threadId: m.threadId ?? null,
              inReplyToMessageId: m.inReplyToMessageId ?? null,
              ...fields,
            },
            idempotencyKey: opts.idempotencyKey,
          });
          if (!res.ok) throw await this.rejectionOf(res);
          const seq = this.noteSeq(res);
          const dto = await readJsonOrAmbiguous<{ id?: string; updatedAt?: string; createdAt?: string }>(res, "draft save");
          if (!dto.id) {
            /**
             * Parsed, but without the id it promised: the row may exist and this client cannot
             * name it. The old sentence promised ohmail would "ask again under the same key" —
             * it does not, because this route ignores the key, so asking again wrote a second
             * draft. The key is remembered instead, and the branch above refuses the repeat.
             */
            this.createAttempted.add(opts.idempotencyKey);
            throw new MutationRejectedError(
              "We could not read the server's answer to this draft save, so ohmail cannot tell "
                + "whether it was created. It will not create a second one.",
              { code: "unreadable_response", status: res.status, retryable: true, retryAfterMs: retryAfterMsOf(res) },
            );
          }
          return {
            changes: seq === null ? [] : [{
              type: "draft", op: "create", id: dto.id, seq,
              updatedAt: dto.updatedAt ?? dto.createdAt ?? "",
              entity: dto as unknown as Record<string, unknown>,
            }],
            seq,
            entityId: dto.id,
          };
        }
        const res = await this.request("PUT", `/drafts/${encodeURIComponent(m.draftId)}`, {
          // `mailboxId` rides the update too: the sending identity follows the From pick for
          // as long as the row is a draft (the server refuses the move past `draft`), so a
          // draft closed here and reopened on another device carries the pick with it.
          body: { ...fields, ...(m.mailboxId ? { mailboxId: m.mailboxId } : {}) },
          idempotencyKey: opts.idempotencyKey,
        });
        if (!res.ok) throw await this.rejectionOf(res);
        const seq = this.noteSeq(res);
        const dto = (await res.json()) as { id?: string; updatedAt?: string };
        return {
          changes: seq === null || !dto.id ? [] : [{
            type: "draft", op: "update", id: dto.id, seq, updatedAt: dto.updatedAt ?? "",
            entity: dto as unknown as Record<string, unknown>,
          }],
          seq,
          entityId: dto.id ?? m.draftId,
        };
      }

      /**
       * DISCARD — `DELETE /drafts/:id`.
       *
       * A 404 is SWALLOWED, on `rule_delete`'s reasoning one entity over: the user asked for this
       * draft to be gone and it is gone. Reporting a failure would leave a rolled-back tombstone
       * and the draft back on screen, which is the one outcome nobody wants from a Discard.
       * Nothing else is swallowed — a 403 or a 500 means the row may well still be there.
       */
      case "draft_discard": {
        const res = await this.request("DELETE", `/drafts/${encodeURIComponent(m.draftId)}`, {
          idempotencyKey: opts.idempotencyKey,
        });
        if (res.status === 404) return { changes: [], seq: null };
        if (!res.ok) throw await this.rejectionOf(res);
        const seq = this.noteSeq(res);
        /**
         * THE TOMBSTONE IS ECHOED, and `rule_delete` next door deliberately does not do this — so the difference is
         * worth the paragraph. An empty `changes` sends the engine to the authoritative drain, which is correct
         * whenever the drain can express what happened. A BOOTSTRAP cannot: `GET /sync/snapshot` emits every live row
         * as `op: "create"` and has no way to say "and this one is gone", and it fixes the delta cursor at the
         * CURRENT high water — so a delete that happened before the snapshot is skipped by the delta that follows it.
         * Any drain that bootstraps therefore loses the tombstone, the optimistic overlay is dropped when this
         * resolves, and the draft the reader just discarded comes back on screen and stays. Echoing it makes the
         * removal a read-your-writes fact that does not depend on which path the next drain takes.
         */

        /**
         * Measured, not reasoned: the mirror really did keep the row (`mail-send.test.ts`, "draft_discard removes the
         * row"), and the delete really was in `change_log` the whole time.
         */
        return {
          changes: seq === null ? [] : [{
            type: "draft", op: "delete", id: m.draftId, seq, updatedAt: "", entity: null,
          }],
          seq,
        };
      }

      /**
       * CANCEL A SEND-LATER APPOINTMENT — `DELETE /drafts/:id/schedule` (mail 0077).
       *
       * The interesting answer is the 409: the scheduled-send pass claimed the row first and
       * the mail is leaving. That is surfaced as a non-retryable rejection — the overlay rolls
       * back, so the row never falsely reads "cancelled", and the caller's toast says what
       * actually happened. A repeat cancel is the server's idempotent 200 (the asked-for
       * state), and the echo goes to the drain like the draft verbs above it.
       */
      /**
       * ANSWER FOR AN UNCONFIRMED SEND — `POST /drafts/:id/resolve`. The echo is turned into a `draft` update rather
       * than left to the drain, on {@link draft_schedule_cancel}'s terms: the row's whole visible identity changes
       * (it either leaves the Drafts list as `sent` or becomes an ordinary draft), and a reader who has just pressed
       * "It didn't arrive" must find Discard working immediately rather than on whatever the next drain happens to
       * be. A REPEAT IS NOT AN ERROR HERE and the request is not marked idempotent, because the server's transition
       * is a compare-and-swap on `unverified`: the second call finds nothing to move and answers 200 with the row as
       * it stands. So a double-tap converges without a stored response, exactly as the schedule verbs do.
       */
      case "draft_resolve": {
        const res = await this.request("POST", `/drafts/${encodeURIComponent(m.draftId)}/resolve`, {
          body: { outcome: m.outcome },
          idempotencyKey: opts.idempotencyKey,
        });
        if (!res.ok) throw await this.rejectionOf(res);
        const seq = this.noteSeq(res);
        const dto = (await res.json()) as { id?: string; updatedAt?: string };
        return {
          changes: seq === null || !dto.id ? [] : [{
            type: "draft", op: "update", id: dto.id, seq, updatedAt: dto.updatedAt ?? "",
            entity: dto as unknown as Record<string, unknown>,
          }],
          seq,
        };
      }

      case "draft_schedule_cancel": {
        const res = await this.request("DELETE", `/drafts/${encodeURIComponent(m.draftId)}/schedule`, {
          idempotencyKey: opts.idempotencyKey,
        });
        if (!res.ok) throw await this.rejectionOf(res);
        const seq = this.noteSeq(res);
        const dto = (await res.json()) as { id?: string; updatedAt?: string };
        return {
          changes: seq === null || !dto.id ? [] : [{
            type: "draft", op: "update", id: dto.id, seq, updatedAt: dto.updatedAt ?? "",
            entity: dto as unknown as Record<string, unknown>,
          }],
          seq,
        };
      }

      // Draft-accept is a pure client-side editor action — it moves an AI draft into the
      // editor and touches no server state. No wire mapping, by design.
      case "draft_accept":
        throw new UnsupportedMutationError(m.kind);
    }
  }

  /**
   * Sending is two requests: `POST /drafts` then `POST /drafts/:id/send`. There is no compose-and-send endpoint, and
   * composing from the two that exist is safe because ALL the danger lives in the second — the send route is
   * deliberately not `idempotent`-marked (`SendService` owns the reservation and reads `Idempotency-Key` directly),
   * so the forwarded key is what makes a retry replay instead of re-deliver. The body is exactly what the user typed:
   * no quoted original — quoting would put the PARENT's body into outgoing mail, and a sensitive message's
   * client-side quote block is exactly the seam an OTP leaves through; the editor still SHOWS the conversation, which
   * is the author's context, not the payload.
   */

  /**
   * `inReplyToMessageId` is the only fork between a reply and a compose (`null` is what makes a compose a new
   * conversation — the server mints threading headers only inside `if (d.inReplyToMessageId)`). `rejectionOf` is not
   * used here and must not be: this route answers `{status, message}` at both 200 and 409, and the generic reader
   * would treat the 200 `unverified` answer as a success. A 200 from this endpoint is INSPECTED, never trusted.
   */
  private async mailSend(
    m: Extract<EngineMutation, { kind: "mail_send" }>,
    idempotencyKey: string,
  ): Promise<MutationOutcome> {
    /**
     * THE MESSAGE MAY ALREADY BE A ROW: A compose autosaves through `draft_save`, so by the time Send is pressed the
     * account usually already holds this message. `m.draftId` names it, and then this method PUTs the final text and
     * sends THAT row — one draft from the first keystroke to delivery, instead of an abandoned twin left behind by
     * every send. The PUT is not optional and the reason is the debounce: autosave settles two seconds after the last
     * keystroke, so the last thing typed may not have reached the row. Sending without writing the mutation's own
     * fields first would deliver a message that is not the one on screen — the kind of defect nobody finds twice,
     * because they stop trusting the product. A FAILED PUT DOES NOT STOP THE SEND.
     */

    /**
     * The row is already there and its stored text is at most a couple of seconds stale; refusing to send somebody's
     * message because a settings- shaped write blipped would be the worse failure, and the send route reads the row
     * it finds. The staleness is bounded by the debounce and by the fact that the composer wrote on every pause; a
     * network that cannot take a PUT is unlikely to take the send either, and that failure IS reported.
     */
    let draftId = this.draftForKey.get(idempotencyKey) ?? m.draftId;
    if (draftId && !this.draftForKey.has(idempotencyKey)) {
      this.draftForKey.set(idempotencyKey, draftId);
      const wantsBcc = (m.bcc?.length ?? 0) > 0;
      let echoed: { bcc?: unknown; mailboxId?: unknown } | null = null;
      try {
        const put = await this.request("PUT", `/drafts/${encodeURIComponent(draftId)}`, {
          body: {
            subject: m.subject ?? "",
            ...(m.html ? { html: m.html } : { body: m.body }),
            to: m.to ?? [],
            cc: m.cc ?? [],
            bcc: m.bcc ?? [],
            // THE SENDING IDENTITY, AT PRESS TIME. The row was born at the FIRST autosave,
            // under whatever the From picker held then; `m.mailboxId` is what the From line
            // resolved when Send was pressed. Carrying it re-homes the row while it is still
            // `draft`, so the send that follows dials the identity on screen rather than the
            // frozen one — the wrong-From incident this line exists to close.
            ...(m.mailboxId ? { mailboxId: m.mailboxId } : {}),
          },
        });
        if (put.ok) echoed = (await put.json()) as { bcc?: unknown; mailboxId?: unknown };
      } catch { /* see above — the row stands, and the send is what matters */ }

      // ── THE VERSION-SKEW GUARD, ON THIS PATH TOO ────────────────────────────────────────
      //
      // The create path below refuses to send when blind recipients were asked for and the
      // server did not echo them, because an API that predates the field stores the draft
      // WITHOUT them and the mail leaves addressed to To/Cc only — a wrong delivery the sender
      // cannot see. Reusing an existing row skips that POST, so the same check runs here, and it
      // is the one thing on this path that is NOT swallowed: an unverified Bcc is exactly the
      // failure the guard exists for, and "the PUT did not answer" is not proof that it was
      // stored. A send with no Bcc is unaffected and still tolerates a blipped PUT.
      if (wantsBcc && !Array.isArray(echoed?.bcc)) {
        this.draftForKey.delete(idempotencyKey);
        throw new MutationRejectedError(
          "This message was not sent: the server did not confirm the Bcc recipients. Reload to update, then try again.",
          { code: "bcc_unsupported", retryable: false },
        );
      }

      // ── AND THE SAME GUARD FOR THE SENDING IDENTITY ─────────────────────────────────────
      //
      // The send that follows dials the ROW's mailbox, so the PUT above is what makes the
      // picked From real — and a server that predates the movable column reads named fields
      // and ignores the rest: the PUT "succeeds" and the echo carries the row's OLD mailbox.
      // Going on to `/send` would deliver under an identity the sender explicitly moved off,
      // which is a wrong-From delivery the recipient sees and the sender cannot. So the echo
      // must name the picked mailbox, and anything else — the old id, or no echo because the
      // PUT blipped — refuses the send. Text tolerates a blipped PUT because a stale row is
      // at most one debounce old; the row's IDENTITY may be days old, so it does not.
      if (m.mailboxId && echoed?.mailboxId !== m.mailboxId) {
        this.draftForKey.delete(idempotencyKey);
        throw new MutationRejectedError(
          "This message was not sent: the server did not confirm the sending address. Try again, or reload to update.",
          { code: "from_mailbox_unconfirmed", retryable: false },
        );
      }
    }
    if (!draftId && this.createAttempted.has(idempotencyKey)) {
      /**
       * A CREATE UNDER THIS KEY ALREADY WENT OUT AND ITS ANSWER WAS UNREADABLE.
       *
       * Sending it again would create a second draft, because the route does not honour the key.
       * The honest answer is that this device cannot tell what happened — the same shape as an
       * unverified send, and for the same reason: the only safe repeat is one the server would
       * recognise, and there is none.
       */
      throw new MutationRejectedError(
        "ohmail could not tell whether this draft was created, and will not create a second one. "
          + "Reload to see what the server has.",
        { code: "draft_unverified", status: null, retryable: false },
      );
    }
    if (!draftId) {
      const created = await this.request("POST", "/drafts", {
        body: {
          mailboxId: m.mailboxId,
          threadId: m.threadId ?? null,
          inReplyToMessageId: m.inReplyTo,
          subject: m.subject ?? "",
          // ONE of the two, never both. `DraftsService` derives the text/plain alternative
          // from the sanitized html itself and refuses a request that carries a `body`
          // beside it — a client that sent both would be asserting what plaintext readers
          // see, which is precisely the assertion the server takes back so the two parts of
          // the multipart cannot disagree. `m.body` is still the local plain rendering; it
          // stays out of the request when there is markup to derive a better one from.
          ...(m.html ? { html: m.html } : { body: m.body }),
          to: m.to ?? [],
          cc: m.cc ?? [],
          bcc: m.bcc ?? [],
        },
        // Harmless today (the route is unmarked, so the middleware returns early) and
        // forward-protective: the day `POST /drafts` is marked `idempotent`, replay
        // protection turns on with no client change. The request hash covers method+path+
        // body, and the envelope was frozen by `Engine.enrich` before it was queued, so a
        // retry hashes identically and replays rather than 409ing on a hash mismatch.
        idempotencyKey,
      });
      if (!created.ok) throw await this.rejectionOf(created);
      this.noteSeq(created);
      const draft = await readJsonOrAmbiguous<{ id?: string; bcc?: unknown }>(created, "draft create");
      if (!draft.id) {
        /**
         * AN UNREADABLE CREATE IS AMBIGUOUS, AND THE CREATE IS NOT IDEMPOTENT: The old sentence here said ohmail
         * would "ask again under the same key". It does not, because `POST /drafts` IGNORES the idempotency key — as
         * the comment on the request itself records. So the retry issued a second create and the server, which had
         * already committed the first one, wrote another: a duplicate draft on every autosave, and on a send an
         * orphaned first draft with the message going out under the second. The key is remembered as having attempted
         * a create, so the next attempt under it does not POST again. The refusal is still retryable — a person may
         * press Try again — but it comes back through the branch below, which refuses rather than repeating the
         * create.
         */

        /**
         * Reporting failure instead would be worse: it says no draft was made about one that may have been written.
         */
        this.createAttempted.add(idempotencyKey);
        throw new MutationRejectedError(
          "We could not read the server's answer to this draft, so ohmail cannot tell whether it "
            + "was created. It will not create a second one.",
          { code: "unreadable_response", status: created.status, retryable: true, retryAfterMs: retryAfterMsOf(created) },
        );
      }
      // VERSION-SKEW GUARD: a dropped Bcc must NEVER become a silent send: `bcc` is the newest field on `POST
      // /drafts`. An API that predates it does not 400 an unknown key — `DraftsService` reads named fields and
      // ignores the rest — it stores the draft WITHOUT the blind recipients and echoes a DTO with no `bcc` array. If
      // this client then went on to `/send`, the mail would leave addressed to To/Cc only and the sender would
      // believe three people were blind-copied who never were. That is a correctness failure the user cannot see, so
      // it is caught HERE, before the irreversible second request: a server that accepted bcc echoes the array
      // (possibly empty); one that did not omits the key entirely. Only fires when bcc was actually asked for — a
      // plain or To/Cc-only send is unaffected and still works against any server.

      // The draft the old API stored is an orphan (the same cost the create-lost path already documents), never a
      // wrong delivery. Non-retryable: retrying the same key against the same old API repeats the same drop.
      if (m.bcc && m.bcc.length > 0 && !Array.isArray(draft.bcc)) {
        this.draftForKey.delete(idempotencyKey);
        throw new MutationRejectedError(
          "This message was not sent: the server did not accept the Bcc recipients. Reload to update, then try again.",
          { code: "bcc_unsupported", retryable: false },
        );
      }
      draftId = draft.id;
      this.draftForKey.set(idempotencyKey, draftId);
    }

    // ── SEND LATER (mail 0077): the press becomes an APPOINTMENT, not a delivery ─────────────
    //
    // The row half above is IDENTICAL on purpose — the same PUT-with-guards or create, so the
    // scheduled message is exactly the message on screen, Bcc and From confirmations included.
    // What differs is the second request: `POST /drafts/:id/schedule` writes `send_at` +
    // `status: 'scheduled'` and dials nothing; the server's scheduled-send pass runs the
    // ordinary gated send when the time comes.
    if (m.sendAt) {
      // A draft row stores no attachment bytes and no forward reference (both ride the SEND
      // request, deliberately — §13.2/§14), so an appointment cannot carry either. The compose
      // surface disables the affordance for both cases; this is the same rule where it cannot
      // be bypassed, refused before any request rather than after the row is marked.
      if ((m.attachments?.length ?? 0) > 0 || m.forwardOf) {
        this.draftForKey.delete(idempotencyKey);
        throw new MutationRejectedError(
          "Send later isn't available for messages with attachments or forwards yet.",
          { code: "schedule_unsupported_content", retryable: false },
        );
      }

      const res = await this.request("POST", `/drafts/${encodeURIComponent(draftId)}/schedule`, {
        body: { sendAt: m.sendAt },
        idempotencyKey,
      });
      const seq = this.noteSeq(res);
      if (res.status === 404) {
        // VERSION SKEW: a server that predates scheduling answers its ordinary 404 here. The
        // draft row stands (it is in Drafts, nothing lost); what must not happen is a silent
        // fallback to sending NOW — the user picked a time, and mail leaving early is the one
        // surprise this feature exists to rule out.
        this.draftForKey.delete(idempotencyKey);
        throw new MutationRejectedError(
          "This message was not scheduled: the server does not support Send later yet. Reload to update.",
          { status: 404, code: "schedule_unsupported", retryable: false },
        );
      }
      if (!res.ok) {
        this.draftForKey.delete(idempotencyKey);
        throw await this.rejectionOf(res);
      }
      this.draftForKey.delete(idempotencyKey);
      // THE SCHEDULED ROW RIDES THE ECHO — the route answers the draft DTO with its seq, and
      // handing it back as a change is what keeps the Scheduled group populated across the
      // confirm: the engine drops the optimistic overlay the moment this outcome resolves, and
      // an empty `changes` would leave the group EMPTY until a background drain lands (or does
      // not — a hidden tab aborts it). `draft_save`'s exact pattern, for `draft_discard`'s
      // reason: read-your-writes must not depend on which path the next drain takes.
      //
      // No providerMessageId — nothing left the building, so the engine materialises no Sent
      // overlay (its gate reads exactly that field).
      let dto: { id?: string; updatedAt?: string } = {};
      try {
        dto = (await res.json()) as { id?: string; updatedAt?: string };
      } catch { /* an empty body degrades to the drain, exactly the pre-echo behaviour */ }
      return {
        changes: seq === null || !dto.id ? [] : [{
          type: "draft", op: "update", id: dto.id, seq, updatedAt: dto.updatedAt ?? "",
          entity: dto as unknown as Record<string, unknown>,
        }],
        seq,
        entityId: draftId,
      };
    }

    // ATTACHMENTS AND `forwardOf` RIDE THE SEND, not the draft. Attachment bytes are base64 on this one request; the
    // server decodes them, caps the total, hands them to the transport, and stores none of them. `forwardOf` is just
    // the original's id — the server reads the original, refuses a no_forward one, builds the quoted MIME and streams
    // its attachments. Omitted when neither is set, so a plain send stays the bodyless request it has always been.
    // …UNLESS THEY DO NOT FIT, AND THIS CLIENT IS ALLOWED TO STAGE: See {@link HttpAdapter.stagedIdsFor}. The
    // threshold, not "always", is the decision: under the inline ceiling the request is byte-identical to the one
    // this client has always sent, so the overwhelming majority of sends gain no new failure mode, and the staged
    // path exists for exactly the sends that are impossible without it.
    const sendBody: {
      attachments?: typeof m.attachments;
      stagedAttachmentIds?: string[];
      forwardOf?: string;
    } = {};
    const staged = await this.stagedIdsFor(m, idempotencyKey);
    if (staged) sendBody.stagedAttachmentIds = staged;
    else if (m.attachments && m.attachments.length) sendBody.attachments = m.attachments;
    if (m.forwardOf) sendBody.forwardOf = m.forwardOf;
    const res = await this.request("POST", `/drafts/${draftId}/send`, {
      idempotencyKey,
      ...(Object.keys(sendBody).length ? { body: sendBody } : {}),
    });
    // BEFORE any throw: the route echoes X-Sync-Seq on the unverified answer too, and a
    // rejection is no reason to let `lastSyncSeq` fall behind the log.
    const seq = this.noteSeq(res);

    let wire: SendWire = {};
    try {
      wire = (await res.json()) as SendWire;
    } catch {
      /* non-JSON body — fall through to the status-code branches below */
    }

    if (res.ok && wire.status === "sent") {
      this.draftForKey.delete(idempotencyKey);
      // No echo turned into changes: the answer is `{status, providerMessageId}`, not a
      // seq'd DTO, and the draft's `sent` transition arrives on the authoritative drain the
      // engine runs when `changes` is empty — the `triage_set`/`mark_seen` contract.
      //
      // `providerMessageId` IS surfaced, and it is the one field this outcome adds over that
      // contract: it is the minted Message-ID the server appended to Sent, which the engine uses
      // to materialise an optimistic Sent overlay on confirm and to reconcile it against the real
      // row when a later drain ingests it (`OhmailEngine.dispatch`). A missing/empty value simply
      // means no overlay — the send still confirmed.
      return { changes: [], seq, providerMessageId: wire.providerMessageId ?? null };
    }

    if (wire.status === "unverified") {
      // AMBIGUOUS, and it stays ambiguous: SMTP threw AND the Sent-folder probe found nothing. Non-retryable because
      // the server will replay this same answer for this key forever; the user decides whether to compose a fresh
      // send, with the warning on screen. An automatic resend here would be the second delivery this whole path is
      // built to make impossible: one press is one delivery. THE ROW GOES OUT WITH THE REFUSAL, AND IT IS READ OFF
      // *BEFORE* THE FORGETTING: `draftId` at this point is the row this send was about — the caller's, or the one
      // created for it a few lines above when the press carried none. The second case is the one that mattered: the
      // server marked THAT row `unverified`, this client was never told which row it was, and it therefore sat in
      // Drafts looking like an ordinary draft.

      // Opening it took the recovery door and one press delivered the message a second time (measured live, recipient
      // total 2). Naming it here is what lets the durable send record park the message. Read before
      // `draftForKey.delete`, deliberately: `draftId` is a local, but the ORDER of these two statements is the thing
      // a later edit would get wrong, and a refusal that names no row is indistinguishable from one whose row nobody
      // created.
      const unverifiedRow = draftId;
      this.draftForKey.delete(idempotencyKey);
      throw new MutationRejectedError(
        // The fallback matches the shell's own sentence for this state: the send is HELD under the
        // key it went out under, so the honest instruction is to look rather than to press again —
        // pressing again is refused, which a sentence inviting it would not explain.
        wire.message
          ?? "We couldn't confirm this send. It's held under the same send — check your Sent folder to see whether it arrived.",
        {
          status: res.status, code: "send_unverified", retryable: false,
          entityId: unverifiedRow ?? null,
        },
      );
    }

    if (wire.status === "queued") {
      // THE SERVER HAS IT. It reserved the send, stopped waiting for the submission at its own attempt ceiling, and
      // kept the key — so the envelope may or may not have reached the mail server, and the reservation is what
      // decides which. Retryable, and `draftForKey` is deliberately NOT cleared, for the same reason as `in_flight`
      // below: the outbox replays this mutation under the SAME Idempotency-Key, which is the only thing that makes a
      // retry safe. `resumeExisting` answers `in_flight` while the attempt could still be alive and runs
      // verify-by-Sent once it provably is not; a fresh key would be a second delivery. Its own code rather than
      // `send_in_flight`, and the distinction is load-bearing on screen: this one means the server ACCEPTED the send,
      // so the compose surface may close and say so.

      // A transport rejection means the request may never have arrived, and that surface must stay open. Telling the
      // two apart is what stops "Accepted" being said about a request nobody received.
      throw new MutationRejectedError(
        wire.message ?? "This send was accepted and is still being handed to your mail server.",
        {
          status: res.status, code: "send_queued", retryable: true,
          // A server that names an interval is obeyed even here: this arm is a WAIT, and the
          // client's own cadence is not better information than the server's.
          retryAfterMs: retryAfterMsOf(res),
          // The row this accepted send is about — see the `unverified` arm above. A reload inside
          // the queued window otherwise came back unable to name it, read it as an ordinary draft
          // and minted a second row for one message.
          entityId: draftId ?? null,
        },
      );
    }

    if (wire.status === "in_flight") {
      // A genuinely concurrent attempt under this key is still running. Retryable: the same
      // key will replay the terminal outcome once it lands, and past SEND_STALE_AFTER_MS it
      // triggers the server's verify-by-Sent recovery instead.
      throw new MutationRejectedError(
        wire.message ?? "A send for this draft is already in progress.",
        {
          status: res.status, code: "send_in_flight", retryable: true,
          retryAfterMs: retryAfterMsOf(res),
        },
      );
    }

    /**
     * An unreadable answer on this route is AMBIGUITY, not failure. Reached when the status says the server acted
     * (`res.ok`, or 409) but `wire.status` is none of the five it speaks — a truncated body, a proxy rewrite. The old
     * fall-through read 200/202/409 as not-retryable → `rolled_back` → the composer unlocking on a send whose
     * reservation may be committed; the next press mints a FRESH key, and on the mobile path there is no `draftId`
     * for the server's 409 guard to see — a second delivery. So: retryable, under the SAME key, `draftForKey` KEPT —
     * the same-key replay verifies by reservation and by Sent before doing anything, which is why retrying is the
     * safe act and giving up the dangerous one. `send_queued` at 202, `send_in_flight` otherwise — the vocabulary the
     * ceiling already exempts as a modelled wait.
     */

    /**
     * A typed refusal is NOT ambiguity, which this guard could not see: a `ServiceError` from `reserve` has no
     * `status` field — it rides the ordinary `{error:{code,message}}` envelope — so every typed 409 landed here and
     * was rewritten into a retryable `send_in_flight`: wrong twice, saying "a send is already in progress" about an
     * outright refusal, and putting a terminal-by-construction refusal back on the outbox to be replayed and refused
     * for ever. Not hypothetical: `mailbox_disabled` is thrown at 409, and `SendStatus` has its own sentence keyed on
     * that code — which could not arrive. An envelope with a `code` is a READ answer and belongs to the branch below;
     * the guard keeps its original case (no `error.code`) and stops claiming the ones the server named.
     */
    const envelopeCode = (wire as WireError).error?.code;
    if (
      (res.ok || res.status === 409)
      && !SEND_WIRE_STATUSES.has(wire.status ?? "")
      && typeof envelopeCode !== "string"
    ) {
      throw new MutationRejectedError(
        "We could not read the server's answer to this send. It may already be on its way — "
        + "ohmail will ask again under the same key.",
        {
          status: res.status,
          code: res.status === 202 ? "send_queued" : "send_in_flight",
          retryable: true,
          retryAfterMs: retryAfterMsOf(res),
        },
      );
    }

    this.draftForKey.delete(idempotencyKey);
    if (wire.status === "failed") {
      // A definitively-undelivered prior attempt under this key. Terminal, never retryable.
      throw new MutationRejectedError(
        wire.message ?? "A prior send under this key failed and was not delivered.",
        { status: res.status, code: "send_failed", retryable: false },
      );
    }
    // NO `status` FIELD AT ALL ⇒ this rejection did not come from `SendService`; it came from
    // the pipeline in front of it, which speaks the ordinary `{error:{code,message}}`
    // envelope — auth, CSRF, the spend/verification gate, a 5xx. Reading it as the envelope
    // rather than flattening it to "HTTP 403" is what puts the server's own sentence in front
    // of the user, which is the entire content of the `failed` state on screen.
    const env = wire as WireError;
    throw new MutationRejectedError(env.error?.message ?? `HTTP ${res.status}`, {
      status: res.status,
      code: env.error?.code ?? null,
      retryable: env.error?.retryable ?? (res.status >= 500 || res.status === 429),
      // AND THE HEADER. This branch rebuilds the envelope by hand instead of going through
      // `rejectionFor`, and it silently omitted `Retry-After` — so eight `503 db_busy` answers on
      // the SEND route counted as unmodelled failures and abandoned a send the server had merely
      // asked us to wait for. A hand-rolled copy of a shared rule that drops one field is exactly
      // the drift the shared function exists to prevent; the field is named here rather than
      // inferred so the omission cannot recur silently.
      retryAfterMs: retryAfterMsOf(res),
      // The refusal's structured facts, forwarded verbatim and unread here. A surface that has its
      // OWN words for a code needs the facts that go with it — `duplicate_send` carries the first
      // attempt's state and time, which decides which of three sentences is true — and quoting the
      // server's English instead would put an untranslated sentence into a translated interface.
      //
      // Beside `retryAfterMs` and not instead of it: that field is MODELLED and branched on, this
      // one is opaque cargo. The line above is exactly the omission its own comment warns about, so
      // adding a second field here is the moment to check both survive — the census below does.
      ...(env.error?.details !== undefined ? { details: env.error.details } : {}),
    });
  }

  /**
   * Stage this send's attachment bytes, or answer `null` for "send them inline as always". Three conditions, all
   * required: the host asked ({@link HttpAdapterOptions.stageAttachments}), the send has files, and their total
   * exceeds {@link SEND_INLINE_MAX_TOTAL_BYTES}. The threshold rather than "always" is deliberate: staging every send
   * routes the common case through two extra round trips and a storage dependency for no gain, and under the ceiling
   * the request left alone is byte-for-byte what this client has always sent — the shape the server must keep
   * accepting for installed desktop builds. All or nothing: the server keeps the strict body cap for any send
   * carrying an inline attachment, so a mixed send would be refused for exactly the reason staging exists to remove.
   */

  /**
   * A failure is a refusal, not a fallback: this path only runs when the total is already over what inline can carry,
   * so falling back would produce a request the server refuses — a second, more confusing failure in place of the
   * real one.
   */
  private async stagedIdsFor(
    m: Extract<EngineMutation, { kind: "mail_send" }>,
    sendKey: string,
  ): Promise<string[] | null> {
    const files = m.attachments ?? [];
    if (!this.stageAttachments || files.length === 0) return null;
    const total = files.reduce((n, a) => n + base64ByteLength(a.contentBase64), 0);
    if (total <= SEND_INLINE_MAX_TOTAL_BYTES) return null;
    if (!m.mailboxId) {
      // The mint refuses the file against the SENDING MAILBOX's announced limit, so it needs to
      // know which mailbox. A send that could not resolve one cannot be staged — and it could not
      // have been composed against a real cap either.
      throw new MutationRejectedError(
        "This message was not sent: no sending address was resolved for its attachments.",
        { code: "staging_failed", retryable: false },
      );
    }

    const ids: string[] = [];
    for (const [index, file] of files.entries()) {
      const bytes = base64ToBytes(file.contentBase64);
      const minted = await this.request("POST", "/attachments/staging", {
        // THE UPLOAD TICKET'S KEY, DERIVED AND NOT MINTED: A mint writes a durable row and a grant to put bytes in
        // the server's storage, so a retry after a lost response would otherwise mint a second ticket and upload a
        // second copy — a duplicate the client cannot see, on every attempt, for as long as the send keeps failing.
        // The server's answer to that is to make the ticket's identity the key it was minted under, and this is the
        // client's half of it. The key is the SEND's own idempotency key plus the file's position. Both halves are
        // load-bearing:

        // · the send key is already durable and is RESUMED on a retry rather than re-minted (the send lock is
        //   persisted with the compose lane), so this key is stable across a reload, a crash, and a fresh tab.
        //   Minting one here — a random per attempt, or one held in a field — would be the defect this closes, one
        //   layer up;
        // · the INDEX is what keeps two attachments distinct. Without it, the same file attached twice would
        //   resolve to one ticket and the send route — which walks the DISTINCT ids — would deliver one copy of a
        //   file the composer showed twice. A message that quietly leaves without something the sender attached is a
        //   wrong send, and it is the worse failure of the two.
        idempotencyKey: `${sendKey}:att:${index}`,
        body: {
          mailboxId: m.mailboxId,
          filename: file.filename,
          contentType: file.contentType,
          sizeBytes: bytes.byteLength,
        },
      });
      if (!minted.ok) throw await this.rejectionOf(minted);
      const grant = await readJsonOrAmbiguous<{
        id?: string; uploadUrl?: string; uploadMethod?: string;
        uploadHeaders?: Record<string, string>;
      }>(minted, "attachment upload ticket");
      if (!grant.id || !grant.uploadUrl) {
        throw new MutationRejectedError(
          "This message was not sent: the upload could not be prepared. Try again.",
          {
            code: "staging_failed", status: minted.status, retryable: true,
            retryAfterMs: retryAfterMsOf(minted),
          },
        );
      }

      // THE UPLOAD DOES NOT GO THROUGH `request()`. It carries no session cookie, no CSRF token
      // and none of this client's headers: its authority is the signed URL and nothing else, and
      // sending a credential to a URL the server handed us would widen what that URL can do. The
      // method and headers are used VERBATIM — the storage wire is the server's business, and a
      // client that reconstructed them would be a second implementation of a one-sided contract.
      let put: Response;
      try {
        put = await this.fetchImpl(grant.uploadUrl, {
          method: grant.uploadMethod ?? "PUT",
          headers: grant.uploadHeaders ?? {},
          body: bytes as unknown as BodyInit,
        });
      } catch {
        throw new MutationRejectedError(
          "This message was not sent: an attachment could not be uploaded. Check your connection and try again.",
          { code: "staging_failed", retryable: true },
        );
      }
      if (!put.ok) {
        throw new MutationRejectedError(
          "This message was not sent: an attachment could not be uploaded. Try again.",
          {
            status: put.status,
            code: "staging_failed",
            // 429 joins 5xx: the generic path has always read a rate limit as retryable and this
            // one did not, so a throttled storage backend was a terminal send failure here and a
            // patient retry everywhere else. One rule, both roads.
            retryable: put.status >= 500 || put.status === 429,
            // Storage throttles with `Retry-After` too; without it eight of them abandon a send
            // that was only ever being asked to slow down.
            retryAfterMs: retryAfterMsOf(put),
          },
        );
      }
      ids.push(grant.id);
    }
    return ids;
  }
}

/**
 * THE CEILING THE INLINE TRANSPORT CAN CARRY, in raw attachment bytes. A fact about the REQUEST PIPELINE, not about
 * mail: inline bytes travel base64 on one JSON request, so their total has to clear the hosted API's serverless body
 * limit (~4.5 MB) with room for the envelope and the ~1.33× base64 inflation. 3 MB of raw bytes encodes to about 4
 * MB. It is the same number as `SEND_ATTACHMENT_MAX_TOTAL_BYTES` (the send service's) and
 * `COMPOSE_ATTACH_MAX_TOTAL_BYTES` (the compose form's), and the three are pinned to each other by the repository's
 * `compose-attach-cap-parity` suite. Three copies because the three live in bundles that may not import each other;
 * one value because a client that staged at a different threshold than the server refuses at would send a request
 * nothing accepts.
 */
export const SEND_INLINE_MAX_TOTAL_BYTES = 3 * 1024 * 1024;

/** Decoded byte length of a base64 string, without decoding it. */
function base64ByteLength(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * base64 → raw bytes. `atob` rather than `Buffer`, because this module is bundled for a browser
 * and `Buffer` is not a thing there; Node has had `atob` as a global since 16.
 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
