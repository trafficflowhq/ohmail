import {
  CursorExpiredError,
  FOLDER_OF_VIEW,
  MutationRejectedError,
  UnsupportedMutationError,
  type EngineMessage,
  type EngineMutation,
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
import type { ListOlderWire, ServerSearchWire } from "../engine.js";
import type { AttachmentWire, EngineAdapter, MutationOutcome, SyncParams } from "./adapter.js";

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
  /** Extra headers on every request (e.g. Authorization for bearer mode). */
  headers?: () => Record<string, string>;
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
  error?: { code?: string; message?: string; retryable?: boolean };
}

// ── the two view vocabularies ──────────────────────────────────────────────
//
// THERE ARE TWO NAMES FOR EVERY PILE, AND THEY OVERLAP IN EXACTLY ONE PLACE.
//
// The client's own vocabulary is {@link OhmailView} — `ohbox`, `reads`, `receipts`, `screener`,
// `screened`, `spam` — the words the product uses on screen. The server's message-list route
// speaks a different one, and the only name the two share is `screened`. That single overlap is
// what makes the mistake so easy to make and so hard to see: a client that puts its OWN word on
// the wire works for one view out of six and is refused for the rest.
//
// So the translation happens HERE, in the wire client, because wire vocabulary is what a wire
// client is for. Nothing above this file — not the engine, not a surface — should have to know
// that the server has its own words for the piles.

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
 * CLIENT VIEW → SERVER VIEW, the one place the two vocabularies meet.
 *
 * `null` means the server has no message-list for that view, which is a real answer rather than a
 * gap: `screener` is a queue of SENDERS waiting at the door, not a pile of mail with a paging
 * cursor behind it. A request for it would be refused, so none is made — the capability reports
 * the same "there is nothing behind this list" it reports for a client with no server at all.
 *
 * Exhaustive by `Record<OhmailView, …>`: adding a view to the client's vocabulary without
 * deciding what the server calls it does not compile.
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
 * How long the client waits for `GET /messages/:id/attachments` before it stops waiting.
 *
 * ## WHY THERE HAD TO BE ONE AT ALL
 *
 * `fetch` has no default deadline. A request the server accepts and never answers — a dead proxy,
 * a half-open TCP connection, a lambda killed between the handshake and the reply — leaves a
 * promise that neither resolves nor rejects, so `loadAttachments` holds `{state: "loading"}` and
 * the strip renders that as nothing, on purpose, for as long as the tab is open. A REFUSAL is a
 * state the surface can say out loud, and it at least arrives; this is the case where nothing
 * arrives, and before this constant existed the whole path had no bound of any kind: not here,
 * not in the engine, not in the browser. (`DEFAULT_NET_TIMEOUTS` bounds imapflow's sockets inside
 * the worker and is not reachable from a client.)
 *
 * ## WHY TWELVE SECONDS
 *
 * NOT derived from `apps/api-vercel`'s `maxDuration = 60`. That bounds how long our own handler
 * may run and says nothing about the failure this exists for, which happens at the network layer
 * where no server budget applies. The number is chosen against the user instead: the route is
 * `cost: "read"`, one indexed row, and the effect behind it fires on every message OPEN — so the
 * cost of being wrong is 12 s of silence per message against a sick backend. Twelve leaves room
 * for a cold lambda on a slow mobile link (the floor is around 8 s) and is well short of the point
 * where somebody has concluded the app is broken and reloaded it.
 */
export const ATTACHMENT_LIST_TIMEOUT_MS = 12_000;

/**
 * How long the client waits for `GET /messages/:id/body` before it stops waiting.
 *
 * ## THE SAME SILENCE AS THE ATTACHMENT LIST, ON THE ROUTE THAT SHOWS IT TO EVERY READER
 *
 * The argument on {@link ATTACHMENT_LIST_TIMEOUT_MS} applies here word for word — `fetch` has no
 * default deadline, and a request the server accepts and never answers leaves a promise that
 * neither resolves nor rejects — but the consequence is worse, because this route is what a
 * MESSAGE is. `Engine.hydrateBody` writes `{state: "loading"}` before it asks, the surfaces
 * render that as "Loading the full message…", and the only exits from that state are the two
 * arms of `fetchBodyInto`'s try/catch. Neither runs if the promise never settles.
 *
 * And the spinner is not merely stuck, it is UNRECOVERABLE: `hydrateBody`'s single-flight map is
 * cleared from the request's own `.finally`, so a hung request keeps its entry for the life of
 * the tab, and every later call — INCLUDING the Retry button, which passes `{retry: true}` —
 * short-circuits on `if (inFlight) return inFlight` and joins the promise that is never coming
 * back. No surface offers a control for `loading` either, because `loading` was designed to be a
 * state that ends. This constant is what makes that true.
 *
 * ## WHY TWELVE, AND WHY NOT LONGER — WHICH IS THE HALF THAT LOOKS SETTLED AND IS NOT
 *
 * This was written as 20 s first, on the argument that the route returns a whole html part
 * (`prepareHtmlForStorage` caps it at 256 KiB) and so deserves longer than its sibling. That
 * argument is wrong, and both of its halves are:
 *
 *   - The route is not slow. It is `cost: "read"`, one indexed row, and it holds no IMAP slot —
 *     the same cost class as its sibling, answering in well under a second whenever the server
 *     is answering at all. There is no long tail here for a longer deadline to cover.
 *   - The response is served GZIPPED. 256 KiB of newsletter html is 30–50 KB on the wire, so
 *     even a bad mobile link spends about two seconds in that stream, not eight. The payload
 *     premise does not survive the content encoding.
 *
 * And the two failure modes are ASYMMETRIC, which is what settles it. Timing out early costs one
 * wasted round trip and a Retry that works. Timing out late costs the reader that many seconds of
 * "Loading the full message…" before anything at all is offered — because, per the paragraph
 * above, this deadline is the ONLY thing that makes the state recoverable. The route's importance
 * reads at first like an argument for the long end of the range; it is an argument for the short
 * end.
 *
 * So it is the same figure as its sibling — one number for one cost class, carrying the same room
 * for a cold lambda on a slow link that the docblock above reasons through, rather than a
 * difference resting on a premise gzip erases.
 */
export const BODY_FETCH_TIMEOUT_MS = 12_000;

/**
 * NARROW ONE BODY OFF THE WIRE — shared by `GET /messages/:id/body` and by the batch route,
 * because they serve the same stored row and a second narrowing is a second place for it to be
 * wrong. (It already was: this adapter returned `{ text }` and dropped the rest, which is where
 * the html part of every message died — see {@link MessageBodyWire}.)
 *
 * Forward-compatible parsing (§8): a body row that was never ingested answers `text: ""`, and a
 * server that one day stops sending a field must never become `undefined` rendered into the page.
 *
 * ── THE ABSENT `html` CASE IS `null`, NOT `""` ─────────────────────────────────────────────
 *
 * The type test is the whole parse: the endpoint answers `string | null`, an older or partial
 * server answers `undefined`, and all three mean "there is no html to render" to a caller that
 * checks for null. Coercing to `""` instead would make an html-less message indistinguishable
 * from one whose html is an empty document, and the renderer's "fall back to text" branch would
 * then be chosen by a falsy check rather than by a stated absence.
 *
 * NOTHING IS VALIDATED BEYOND THE TYPE, deliberately. The html is hostile bytes and this is the
 * wrong place to decide what is safe in them: a partial sanitization at the adapter would be a
 * second, weaker gate that makes the real one (`MessageBody.tsx`, DOMPurify + a sandboxed frame)
 * impossible to prove on its own. What arrives here is what the sender wrote, and it is treated
 * as such all the way to the one component that knows how.
 *
 * ── AND THE UNSUBSCRIBE POSTURE, NARROWED THE SAME WAY ─────────────────────────────────────
 *
 * The server DERIVES it from the raw headers (which never cross the wire) and sends the enum plus,
 * for `not_one_click` only, the sender's https page. An OLDER server sends neither field, and the
 * correct reading of "the server said nothing" is `"no_header"` (offers no route) and `null` (no
 * link) — never a claim that some route exists. The value is trusted only if it is one of the four
 * known strings; anything else, including a future state this build does not know, reads as
 * `"no_header"`.
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
  };
}

/** `POST /drafts/:id/send` answers this shape at 200 AND at 409 — never the error envelope. */
interface SendWire {
  status?: "sent" | "unverified" | "failed" | "in_flight";
  providerMessageId?: string | null;
  message?: string;
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
  private readonly getCookie: (name: string) => string | null;
  private readonly csrfCookieName: string;
  private readonly extraHeaders: () => Record<string, string>;
  /** Highest X-Sync-Seq observed across mutations — converged once the /sync cursor reaches it. */
  lastSyncSeq: number | null = null;
  /**
   * `Idempotency-Key → draftId` for in-flight sends.
   *
   * A send is TWO requests — create the draft, then send it — and only the second is
   * idempotent server-side (`POST /drafts` is not `idempotent`-marked, so `withIdempotency`
   * short-circuits and a replay writes a SECOND draft). Remembering the draft this key
   * already created means the engine's retry — same key, same envelope — re-sends the same
   * draft instead of minting another.
   *
   * It is in-memory ON PURPOSE and needs no more durability than that: the engine's retry
   * queue lives in the same object graph and dies on the same reload. The worst case when
   * the memo is missed is one orphan `drafts` row that nobody sees — NEVER a second
   * delivery, because `outbound_sends` is UNIQUE on `(accountId, idempotencyKey)` and a
   * same-key request replays the first reservation's outcome without touching SMTP.
   */
  private readonly draftForKey = new Map<string, string>();

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
    this.getCookie = opts.getCookie ?? defaultGetCookie;
    this.csrfCookieName = opts.csrfCookieName ?? "tf_csrf";
    this.extraHeaders = opts.headers ?? (() => ({}));
  }

  /** The SSE wake-signal attach point (same origin/base as the sync API). */
  eventsUrl(): string {
    return `${this.baseUrl}/events`;
  }

  /**
   * `signal` is OPTIONAL AND UNSET BY DEFAULT, and that is the blast-radius decision.
   *
   * This method is shared by every call the client makes — sync drains, bodies, search, the byte
   * fetches, and every mutation. A deadline installed HERE would bound all of them at one number,
   * and they do not deserve one number: a `/sync` drain legitimately runs longer than a list read,
   * a mutation aborted mid-flight is ambiguous in a way a GET never is (`POST /rules` has no
   * server-side idempotency claim — see `rule_create` below — so abort-then-retry writes a second
   * rule), and the two `cost: "connection"` byte routes hold a slot in `imap-admission` that a
   * CLIENT giving up does not hand back, so a deadline there plus the retry it invites
   * double-counts against the per-mailbox cap and produces a `mailbox_busy` the user caused.
   *
   * So the mechanism is here and the POLICY is at the call site. Exactly one caller passes a
   * signal today: {@link HttpAdapter.listAttachments}, via {@link HttpAdapter.withDeadline}.
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
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
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
   * Run one request-and-parse under a deadline, ABORTING it when the deadline fires.
   *
   * ## IT IS A RACE *AND* AN ABORT, AND BOTH HALVES ARE LOAD-BEARING
   *
   * The ABORT is what makes the sentence true about the socket and not merely about our own
   * patience: a timeout that left the request running would tell the user it failed while it may
   * yet succeed — the opposite lie to the silence this exists to end — and would leak one
   * connection per hung message opened. A real browser cancels on `signal`.
   *
   * The RACE is what makes the bound unconditional. A transport that ignores `signal` would
   * otherwise hang exactly as before, one indirection down, and "a transport that does not answer"
   * is the entire class this gap is about. Every injected `fetch` in this repo's suites is such a
   * transport, which is also why abort-only could never have been proven.
   *
   * ## WHAT IT WRAPS, AND WHY IT IS NOT JUST `request()`
   *
   * The whole method body, `res.json()` included. A deadline that ended when the `Response` object
   * arrived would miss a server that sends headers and then stalls the body stream — same silence,
   * one layer in.
   *
   * ## THE LOSER'S REJECTION IS SWALLOWED AT MINT TIME
   *
   * The abandoned request rejects later — immediately, from the abort we just raised, or eventually
   * from a proxy giving up — with nobody awaiting it, and an unhandled rejection in a browser is a
   * console error about a request the app deliberately dropped.
   *
   * `Promise.race` ALREADY registers a rejection handler on `attempt`, so the explicit `.catch()`
   * below is redundant TODAY and no test can distinguish its presence from its absence — stated
   * plainly rather than dressed up as a guard, because a line nobody has watched fail is not
   * evidence of anything. It is kept because the swallow is a property of this method and not of
   * the operator it currently uses: express the bound any other way (a `then` pair, an
   * `AbortSignal`-driven resolve) and the handler goes away silently along with it.
   *
   * The thrown error is `code: "timeout"`, `retryable: true`. Retryable is not a hedge: nothing was
   * established about the server, the call is a side-effect-free GET, and asking again costs one
   * indexed row — so the surface must offer the button (`AttachmentStrip`'s failure row reads
   * exactly this flag).
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
    });
  }

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
   * `GET /sync/snapshot` — CURRENT STATE at one consistent point, instead of replaying the log
   * from `since=0`. See {@link SyncSnapshotPage} for what the three fields promise.
   *
   * It is an OPTIONAL capability on the engine's side and deliberately not a member of
   * `EngineAdapter`: the FixturesAdapter has no server, and an adapter that lacks this simply
   * takes the `since=0` path. An adapter WRAPPER must forward it explicitly — see
   * `SnapshotCapableAdapter` in `engine.ts` for why that is the one thing this shape can get
   * wrong.
   *
   * ## FORWARD-COMPATIBLE PARSING (§8), AND ONE PLACE IT IS STRICT
   *
   * `nextCursor` and `window` degrade: a missing `nextCursor` means "last page", which is the
   * safe reading — the client commits and moves to deltas rather than paging forever against a
   * server that stopped sending the field. `window` is informational and defaults to zeroes.
   *
   * `asOfSeq` does NOT degrade. It is the value the client writes as its `/sync` cursor, and a
   * missing or non-finite one coerced to 0 would commit a cursor of "0" — indistinguishable from
   * a cold mirror, so the next drain would re-snapshot forever, or worse would resume deltas from
   * the beginning of the log while holding a full mirror. A response without a usable `asOfSeq`
   * is not a snapshot, so it throws and the engine's fallback path is what runs.
   *
   * There is no 410 branch: a snapshot is read at the server's own current point and has no
   * client-supplied cursor to expire. `nextCursor` is the server's opaque paging token and is
   * echoed back untouched.
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
   * `GET /messages/:id/body` — the endpoint that existed, spend-gated and contract-tested,
   * and had ZERO client callers for the whole of Stage 2. That is the entire reason a live
   * account rendered one line of every newsletter: the wire `MessageDTO` carries `snippet`
   * and never `body`, so `m.body ?? m.snippet` had nothing else to reach for.
   *
   * The route declares `cost: "read"`, so it is open to an unverified session by the same
   * argument every read is: a 403 costs the same serverless invocation as the read it refuses,
   * so gating reads takes nothing off a hostile poller. That is NOT licence to prefetch: the
   * engine calls this on explicit intent only — a selection, an expand, a Screener row somebody
   * is deciding about — and never pile-wide. Reads being open because refusing one costs the
   * same as serving it is not a licence to manufacture requests nobody asked for.
   *
   * The text comes back ALREADY REDACTED for a sensitive message and is passed through
   * untouched: sensitive mail is redacted once, server-side, and a second implementation of
   * that rule here would be a second place for it to be wrong. This method does not know, and
   * must not learn, what an OTP looks like.
   *
   * A non-2xx THROWS, through the same `rejectionOf` reader every mutation uses, so a 402
   * from the spend gate arrives with the server's own sentence in it rather than as
   * `HTTP 402`. The engine turns the throw into a `failed` record and the surface says the
   * body could not be loaded — which is the one thing the shipped `body ?? snippet` branch
   * could never say.
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
   * `GET /messages/bodies?ids=…` — every body a conversation needs, in ONE request.
   *
   * SAME ROUTE as the mirror's keyset page and the same `cost: "read"`; the `ids` parameter is
   * what selects the mode. The server answers ONLY ids this account owns and omits the rest
   * silently, so the response is not an existence oracle — which is why the rows carry their own
   * `messageId` and the engine matches on it rather than on position.
   *
   * UNDER THE SAME DEADLINE AS `fetchBody`, and for the same reason: this call is what a thread
   * IS, the engine writes `loading` markers before it, and a request the server accepts and never
   * answers would leave every one of those markers as a permanent spinner
   * ({@link BODY_FETCH_TIMEOUT_MS} — the state is only recoverable because the deadline exists).
   * One batch is one round trip, so it earns the same twelve seconds one body does rather than a
   * multiple of it.
   *
   * A non-2xx THROWS, through the same `rejectionOf` reader everything else uses; the engine turns
   * that into a `failed` record for each id in the batch. An unrecognised payload narrows to an
   * empty list rather than throwing, so the engine's per-id fallback covers a server that does not
   * understand the parameter — the old behaviour, not an empty thread.
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
  async searchServer(query: string, opts: { limit?: number } = {}): Promise<ServerSearchWire> {
    const q = new URLSearchParams({ q: query });
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const res = await this.request("GET", `/search?${q.toString()}`);
    if (!res.ok) throw await this.rejectionOf(res);
    const wire = (await res.json()) as { items?: EngineMessage[]; total?: number };
    // Forward-compatible (§8): `facets` is deliberately unread — its folder keys are raw IMAP
    // paths, and the client keys its own facets by view id.
    return {
      items: Array.isArray(wire.items) ? wire.items : [],
      total: typeof wire.total === "number" ? wire.total : (wire.items?.length ?? 0),
    };
  }

  /**
   * `GET /messages?view=&cursor=` — one keyset page of a view, oldest-ward.
   *
   * The route this reaches has existed since Stage 2 and, like `/search` and
   * `/messages/:id/body` before it, had no client caller: the mirror held the whole mailbox, so
   * there was never anything past the end of a list to ask for. A windowed client changes that —
   * see `StorePolicy` in `engine.ts` — and this is the only way back to the mail it chose not to
   * keep.
   *
   * OPTIONAL on the engine's side and deliberately not a member of `EngineAdapter`, for the reason
   * `snapshot` and `searchServer` are not: a client with no server, or one holding the whole
   * mailbox already, must read as "there is nothing beyond this list" rather than as broken. An
   * adapter WRAPPER must forward it explicitly.
   *
   * `cursor` is the server's own opaque keyset token, echoed back untouched — it is not a `/sync`
   * cursor and the two must never be conflated. Forward-compatible parsing (§8): a missing or
   * empty `nextCursor` means "last page", which is the safe reading, and a missing `items` is an
   * empty page rather than a crash. A non-2xx THROWS through `rejectionOf`, so a 402 from the
   * spend gate arrives carrying the server's own sentence.
   *
   * ── THE VIEW NAME IS TRANSLATED, NOT FORWARDED ──────────────────────────────────────────────
   *
   * Through {@link SERVER_VIEW_OF}, for the reason set out where that table is declared: the
   * client and the server have different words for the same six piles and share exactly one of
   * them. Putting the client's word on the wire is not a mismatch that fails loudly — five of the
   * six views are refused with a validation error whose text names the server's internal
   * vocabulary, and the sixth works, so it reads as an intermittent fault rather than a wrong
   * name.
   *
   * A view the server has no list for resolves `null` — the same "there is nothing behind this
   * list" a client with no server at all reports, and deliberately not a request that would be
   * refused nor an error a surface would have to render.
   */
  async listMessages(
    view: OhmailView,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<ListOlderWire | null> {
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

  // ── attachments ──────────────────────────────────────────────────────────

  /**
   * `GET /messages/:id/attachments` — the metadata read, no bytes, no IMAP connection.
   *
   * The route declares `cost: "read"`, unlike the two byte methods below, whose routes declare
   * `cost: "connection"` because serving them opens a socket to the user's mail
   * server. That difference is the whole reason metadata is a separate call: the strip can render
   * names, types and sizes for every part of a message without anything reaching IMAP.
   *
   * Forward-compatible parsing (§8): every field is guarded, because a row that predates a column
   * or a server that stops sending one must degrade to a rendered fallback rather than put
   * `undefined` on the screen. `inline` defaults FALSE-ish per row and is filtered in the engine.
   *
   * ## THE ONLY BOUNDED CALL IN THIS FILE
   *
   * {@link ATTACHMENT_LIST_TIMEOUT_MS} via {@link HttpAdapter.withDeadline}, and it is the only
   * one for a reason rather than by omission — see `request()` for the three arguments against a
   * blanket deadline. This call earns one because it is the cheapest thing to abandon in the whole
   * protocol: a GET, `cost: "read"`, one indexed row, no server-side effect and no IMAP slot. A
   * request we walk away from costs nothing, and a retry after one is unambiguous.
   *
   * It is also the one whose silence is total. The engine holds `{state: "loading"}` and the strip
   * renders that as nothing (deliberately: a skeleton on every message open would be noise), so a
   * hang here draws a paperclip over an empty message for as long as the tab lives.
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
          messageId: typeof r.messageId === "string" ? r.messageId : messageId,
        };
      }).filter((a) => a.id !== "");
    });
  }

  /**
   * `GET /attachments/:id` — the bytes, live from the user's IMAP mailbox.
   *
   * ## The response is TWO different content types and the branch order matters
   *
   * This route is `raw`: on success it answers `application/octet-stream` with the file, but on
   * failure it answers the ordinary JSON error envelope. So `res.ok` has to be checked BEFORE
   * `blob()` — reading the body as a Blob first would turn a 413's explanatory JSON into a
   * "file" the surface would happily hand the user as a download named after their PDF.
   *
   * `rejectionOf` carries the server's `code` through, which is what lets the engine tell the size
   * ceiling (`payload_too_large` → the `too_large` state, a sentence about the limit) apart from
   * a mail server that is simply down (`upstream_unavailable` → `failed`, a retry is reasonable).
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
            // ── THE DESTINATION, TRANSLATED TO THE SERVER'S VOCABULARY ────────────────────
            //
            // `dest` is a VIEW on this side (`reads`) and a FOLDER on the wire
            // (`ohmail/Reads`), because every other endpoint that names a place already takes
            // a folder: `POST /messages/:id/move` takes `{folder}` and `POST /rules` takes
            // `{destination}`. A second spelling reachable only here is a translation somebody
            // has to remember; this is the one line that does it.
            //
            // OMITTED when absent rather than sent as `null`: the server reads an absent
            // `dest` as the two-folder default it has always had, which is what keeps a client
            // that predates this field working unchanged.
            ...(m.dest ? { dest: FOLDER_OF_VIEW[m.dest] } : {}),
            ...(m.scope ? { scope: m.scope } : {}),
          },
          idempotencyKey: opts.idempotencyKey,
        });
        if (!res.ok) throw await this.rejectionOf(res);
        // Response is { messageId, appliedFolder, createdRuleId } — the moved
        // held mail + promoted rule arrive authoritatively via /sync.
        return { changes: [], seq: this.noteSeq(res) };
      }

      case "feed_mark_seen": {
        // No batch endpoint — one PATCH per message (idempotent by definition,
        // §1.6); each echoes the updated DTO + X-Sync-Seq.
        const changes: SyncChange[] = [];
        let seq: number | null = null;
        for (const id of m.messageIds ?? []) {
          const res = await this.request("PATCH", `/messages/${id}`, { body: { unread: false } });
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
        // ONE capped batch request — `PATCH /messages { ids, unread }`. The per-message loop
        // `feed_mark_seen` runs above is what this replaces: N requests meant N transactions and
        // N chances to leave a selection half-flipped, and it could not carry one
        // Idempotency-Key for one user intent.
        //
        // No echo is turned into changes. The route emits one `change_log` row per message at
        // DISTINCT seqs, and `X-Sync-Seq` can only carry the last of them, so fabricating N
        // changes at one seq would write the mirror's cursor past deltas it never applied. The
        // engine's `dispatch` sees `changes: []` and pulls the authoritative drain instead —
        // the same contract `triage_set` and `screener_decide` already use, and the overlay
        // holds the user's view steady until it lands.
        const res = await this.request("PATCH", "/messages", {
          body: { ids: m.messageIds, unread: m.unread },
          idempotencyKey: opts.idempotencyKey,
        });
        if (!res.ok) throw await this.rejectionOf(res);
        return { changes: [], seq: this.noteSeq(res) };
      }

      case "mail_send":
        return this.mailSend(m, opts.idempotencyKey);

      /**
       * THIS CASE IS WHERE TAGS REACH THE WIRE. It threw `UnsupportedMutationError` until it
       * existed, which made a fully-built tag UI do nothing on every real account: the picker,
       * the `t` shortcut and the bulk verb all called `mutate`, the optimistic effect painted
       * the tag on the row, and the adapter then rejected it — so the overlay rolled back and
       * the tag vanished, with no error a user could see. Fixtures served it in place and
       * stayed green throughout.
       *
       * THE BODY IS A DELTA, NOT `m.labels`. The mutation carries a full next-labels array
       * (filled by `Engine.enrich`) for the OPTIMISTIC effect, and sending that array to the
       * server would be a read-modify-write: two concurrent toggles of DIFFERENT tags on one
       * message each compute their array from the same starting state, and whichever request
       * lands second silently erases the other's tag. So the local effect uses the array and
       * the wire uses `{ tagId, assigned }` — one row, idempotent in both directions
       * (`INSERT … ON CONFLICT DO NOTHING` / `DELETE`), and immune to that race.
       *
       * No echo is turned into changes, matching `triage_set` and `mark_seen`: the route emits
       * a `message` update, `dispatch` sees `changes: []` and pulls the authoritative drain,
       * and the overlay holds the user's view steady until it lands.
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
       * THE TAG CRUD REACHES THE WIRE. `POST /tags`, `PATCH /tags/:id` and `DELETE /tags/:id`
       * have been mounted and contract-tested since the tags backend landed, with no caller —
       * the same "built, tested, unreachable" shape the rules CRUD below was in, and the one
       * `tag_assign`'s own comment in `types.ts` records for `tag_assign` itself.
       *
       * ── THE ID IS NOT SENT, AND THAT IS THE `rule_create` PRECEDENT, NOT AN OVERSIGHT ────
       *
       * `POST /tags` takes `{ name, hue? }` and the database mints the id (`TagsService.create`
       * inserts without one). So the optimistic row's `tagId` is a CLIENT-LOCAL name for a row
       * that does not exist yet, exactly as `rule_create`'s `ctx.uuid()` is: the overlay is
       * deleted the moment the mutation confirms, and the server's own row arrives in the
       * `create` change returned here. The two ids never have to agree because they never
       * coexist. Sending the client's id would be worse than useless — the server ignores it,
       * and a reader of this code would believe the row was created under it.
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
       * THE RULES CRUD REACHES THE WIRE. `DELETE /rules/:id` and `PATCH /rules/:id` have been
       * mounted and contract-tested since the rules backend landed, with no caller anywhere in
       * the product until this case existed.
       *
       * ── A 204 CARRIES NO BODY, SO THERE IS NOTHING TO ECHO ────────────────────────────────
       *
       * `DELETE` answers `204` with `X-Sync-Seq` and no JSON at all, so `changes: []` is not
       * the "we chose not to echo" of `tag_assign` — there is literally no DTO. `dispatch`
       * turns an empty `changes` into an immediate `syncOnce()`, which pulls the
       * authoritative `rule` delete at its real seq; the optimistic tombstone holds the row
       * off the screen until it lands. `PATCH` DOES return the updated `RuleDTO`, and it is
       * echoed, because a rule is one row at one seq — the objection that stops `mark_seen`
       * from echoing (N changes at one seq would move the cursor past deltas the mirror never
       * applied) does not arise for a single entity.
       *
       * ── A 404 ON A DELETE IS THE OUTCOME THAT WAS ASKED FOR ───────────────────────────────
       *
       * `RulesService.remove` throws `not_found` when the UPDATE matches zero rows, and every
       * rule lookup is scoped to the calling account, so an id belonging to somebody else is
       * indistinguishable from a missing one — 404 therefore means exactly "no such rule on
       * this account", which is the state a revoke is trying to reach. Three ordinary paths
       * produce it: a second tab that revoked first, a queued retry after a response was lost
       * in transit (the `Idempotency-Key` covers the write, not the reply), and a double-click.
       * Treating it as a rejection would roll the optimistic tombstone back — the revoked rule
       * REAPPEARS on screen — and then the next drain would remove it again. The user watches
       * their own successful action fail and then un-fail.
       *
       * So it is swallowed HERE and not at the call site, because every caller is equally
       * right to be told the rule is gone, and because HTTP already says DELETE is idempotent.
       * `seq: null` is honest about what it is: nothing was written this time, so there is no
       * sequence number to converge on, and the drain that follows reconciles from the cursor.
       *
       * NOTHING ELSE is swallowed. A 403, a 429 and a 500 all still throw — the first two
       * because the user genuinely may not do this, the last because the rule may well still
       * be there.
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
       * `POST /rules` — MOUNTED SINCE §5.6 AND CALLED BY NOTHING.
       *
       * The rules surface reached DELETE and PATCH; nothing in the product had ever
       * created a rule except the Screener's own endpoint, server-side. This is the case that
       * makes "rule this sender" reachable from the Ohbox, the Reads and the Receipts — where
       * `POST /screener/:id` answers 404 because the mail has left the gate.
       *
       * ── THE BODY IS THREE FIELDS, AND `priority` IS DELIBERATELY NOT ONE ──────────────────
       *
       * `CreateRuleBody` also takes `priority` and `enabled`. Neither is sent: `validPriority`
       * defaults to 0 and `enabled` defaults to true, which is what the optimistic row claims,
       * and a client that asserted a ranking would be choosing precedence on the user's behalf
       * (`core/src/rules.ts#compareRules` ranks priority FIRST) from a sheet that offers no such
       * control.
       *
       * ── THE ECHO, AND WHY IT IS SAFE HERE ────────────────────────────────────────────────
       *
       * 201 returns the created `RuleDTO` and `X-Sync-Seq`, so the real row is applied straight
       * away — the same reasoning `rule_update` uses: one entity at one seq, so echoing cannot
       * move the cursor past deltas the mirror never applied (the objection that stops
       * `mark_seen`). A missing or non-finite header degrades to `changes: []` and `dispatch`
       * pulls the authoritative drain instead.
       *
       * ── THE KEY IS HONOURED NOW, AND THIS PARAGRAPH USED TO SAY IT WAS NOT ────────────────
       *
       * It said: *"the route does NOT honour it: `POST /rules` carries no
       * `options: { idempotent: true }`"*, so a retryable failure replayed by `flushPending`
       * (`apps/webapp/app/shell/mail-send.ts` drains the whole queue) wrote a SECOND identical
       * rule. That was true when this verb first shipped and is not true now: the route marks
       * the POST `idempotent`, AND — the half that marking alone would not have supplied —
       * `RulesService.create` claims the key with `claimIdempotencyKey` INSIDE its own insert
       * transaction, storing the verbatim 201. `withIdempotency` only EXPOSES
       * `deps.idempotency`; a claim outside the mutation's transaction still lets the concurrent
       * case (both lookups miss in autocommit) mint two rows, which is why the service does it
       * and not the middleware.
       *
       * So a replayed key now hands back the FIRST rule, and the same key aimed at a different
       * body is a 409 rather than a silent second rule. Nothing on this line changed for that to
       * become true — the key was already being forwarded against the day the claim landed.
       */
      case "rule_create": {
        const res = await this.request("POST", "/rules", {
          body: {
            kind: m.ruleKind, match: m.match, destination: m.destination,
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
       * AUTOSAVE — `POST /drafts` on a create, `PUT /drafts/:id` on an update.
       *
       * Both routes have been mounted since the drafts backend landed; `POST` had exactly one
       * caller ({@link HttpAdapter.mailSend}, on its way to sending) and `PUT` had none at all —
       * the "built, tested, unreachable" shape this file keeps finding. A compose that saves
       * itself is what they were for.
       *
       * ── THE CREATE RETURNS ITS ID, AND THAT IS THE POINT ────────────────────────────────
       *
       * `entityId` carries the server's id back so the surface can adopt it: the next autosave
       * PUTs the same row, and the send sends it. Without it, every two seconds of typing would
       * be a new `drafts` row and pressing Send would leave a heap of abandoned twins behind.
       * The echo also goes into `changes` so the mirror holds the real row immediately, under
       * the real id — the optimistic overlay was under a client-local one and is dropped at the
       * same moment.
       *
       * ── ONE OF `body` / `html`, NEVER BOTH ─────────────────────────────────────────────
       *
       * Identical to the send path and for the identical reason: `DraftsService` derives the
       * text/plain alternative from the sanitized markup and refuses a request carrying a `body`
       * beside it, so a client that sent both would be asserting what plaintext readers see.
       *
       * ── NO `Idempotency-Key` REPLAY IS RELIED ON ───────────────────────────────────────
       *
       * The key is forwarded (both routes are unmarked, so the middleware returns early), and a
       * retry of an autosave is harmless either way: a PUT is set-to-a-value, and a duplicated
       * POST would leave one extra empty-ish draft rather than a duplicated effect. Nothing here
       * sends anything.
       */
      case "draft_save": {
        const fields = {
          subject: m.subject,
          ...(m.html ? { html: m.html } : { body: m.body }),
          to: m.to,
          cc: m.cc,
          bcc: m.bcc,
        };
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
          const dto = (await res.json()) as { id?: string; updatedAt?: string; createdAt?: string };
          if (!dto.id) {
            throw new MutationRejectedError("draft create returned no id", { code: "draft_save_failed" });
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
          body: fields,
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
         * THE TOMBSTONE IS ECHOED, and `rule_delete` next door deliberately does not do this —
         * so the difference is worth the paragraph.
         *
         * An empty `changes` sends the engine to the authoritative drain, which is correct
         * whenever the drain can express what happened. A BOOTSTRAP cannot: `GET /sync/snapshot`
         * emits every live row as `op: "create"` and has no way to say "and this one is gone",
         * and it fixes the delta cursor at the CURRENT high water — so a delete that happened
         * before the snapshot is skipped by the delta that follows it. Any drain that bootstraps
         * therefore loses the tombstone, the optimistic overlay is dropped when this resolves,
         * and the draft the reader just discarded comes back on screen and stays.
         *
         * Echoing it makes the removal a read-your-writes fact that does not depend on which
         * path the next drain takes. Measured, not reasoned: the mirror really did keep the row
         * (`mail-send.test.ts`, "draft_discard removes the row"), and the delete really was in
         * `change_log` the whole time.
         */
        return {
          changes: seq === null ? [] : [{
            type: "draft", op: "delete", id: m.draftId, seq, updatedAt: "", entity: null,
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
   * SENDING IS TWO REQUESTS: `POST /drafts` then `POST /drafts/:id/send`.
   *
   * There is no compose-and-send endpoint and adding one is a server change; composing from
   * the two that exist is safe because ALL the danger lives in the second. The send route is
   * deliberately not `idempotent`-marked — `SendService` owns the reservation itself and
   * reads `Idempotency-Key` directly — so the key this adapter forwards is what makes a
   * retry replay instead of re-deliver.
   *
   * ── THE BODY IS EXACTLY WHAT THE USER TYPED ────────────────────────────────────────────
   *
   * No quoted original, and that is a decision rather than an omission of convenience.
   * Quoting would put the PARENT's body into outgoing mail, and a message the pipeline
   * marked sensitive carries `no_forward` with its stored body redacted — a client-side
   * quote block is exactly the seam through which an OTP leaves the account.
   * The editor still SHOWS the conversation, because that is the author's context, not the
   * payload. A quote block that could be trusted to redact would be a feature in its own right;
   * until there is one, this sends what was typed and nothing else.
   *
   * ── `inReplyToMessageId` IS THE ONLY FORK BETWEEN A REPLY AND A COMPOSE ────────────────
   *
   * `m.inReplyTo` is written straight through, `null` included, and that null is what makes a
   * compose a new conversation: `SendService.reserve` mints `In-Reply-To`/`References` only
   * inside `if (d.inReplyToMessageId)`. Nothing else in this method behaves differently for
   * the two callers, which is the point of there being one method.
   *
   * ── READING THE OUTCOME ────────────────────────────────────────────────────────────────
   *
   * `rejectionOf` is not used here and must not be: the send route answers `{status,
   * message}` at both 200 and 409, never the `{error:{…}}` envelope, so the generic reader
   * would report `HTTP 409` with a null code and — worse — would treat the 200 `unverified`
   * answer as a success. A 200 from this endpoint is INSPECTED, never trusted.
   */
  private async mailSend(
    m: Extract<EngineMutation, { kind: "mail_send" }>,
    idempotencyKey: string,
  ): Promise<MutationOutcome> {
    /**
     * ── THE MESSAGE MAY ALREADY BE A ROW ──────────────────────────────────────────────────
     *
     * A compose autosaves through `draft_save`, so by the time Send is pressed the account
     * usually already holds this message. `m.draftId` names it, and then this method PUTs the
     * final text and sends THAT row — one draft from the first keystroke to delivery, instead of
     * an abandoned twin left behind by every send.
     *
     * The PUT is not optional and the reason is the debounce: autosave settles two seconds after
     * the last keystroke, so the last thing typed may not have reached the row. Sending without
     * writing the mutation's own fields first would deliver a message that is not the one on
     * screen — the kind of defect nobody finds twice, because they stop trusting the product.
     *
     * A FAILED PUT DOES NOT STOP THE SEND. The row is already there and its stored text is at
     * most a couple of seconds stale; refusing to send somebody's message because a settings-
     * shaped write blipped would be the worse failure, and the send route reads the row it finds.
     * The staleness is bounded by the debounce and by the fact that the composer wrote on every
     * pause; a network that cannot take a PUT is unlikely to take the send either, and that
     * failure IS reported.
     */
    let draftId = this.draftForKey.get(idempotencyKey) ?? m.draftId;
    if (draftId && !this.draftForKey.has(idempotencyKey)) {
      this.draftForKey.set(idempotencyKey, draftId);
      const wantsBcc = (m.bcc?.length ?? 0) > 0;
      let echoed: { bcc?: unknown } | null = null;
      try {
        const put = await this.request("PUT", `/drafts/${encodeURIComponent(draftId)}`, {
          body: {
            subject: m.subject ?? "",
            ...(m.html ? { html: m.html } : { body: m.body }),
            to: m.to ?? [],
            cc: m.cc ?? [],
            bcc: m.bcc ?? [],
          },
        });
        if (put.ok) echoed = (await put.json()) as { bcc?: unknown };
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
      const draft = (await created.json()) as { id?: string; bcc?: unknown };
      if (!draft.id) {
        throw new MutationRejectedError("draft create returned no id", { code: "send_failed" });
      }
      // ── VERSION-SKEW GUARD: a dropped Bcc must NEVER become a silent send ──────────────────
      //
      // `bcc` is the newest field on `POST /drafts`. An API that predates it does not 400 an
      // unknown key — `DraftsService` reads named fields and ignores the rest — it stores the draft
      // WITHOUT the blind recipients and echoes a DTO with no `bcc` array. If this client then went
      // on to `/send`, the mail would leave addressed to To/Cc only and the sender would believe
      // three people were blind-copied who never were. That is a correctness failure the user
      // cannot see, so it is caught HERE, before the irreversible second request: a server that
      // accepted bcc echoes the array (possibly empty); one that did not omits the key entirely.
      //
      // Only fires when bcc was actually asked for — a plain or To/Cc-only send is unaffected and
      // still works against any server. The draft the old API stored is an orphan (the same cost
      // the create-lost path already documents), never a wrong delivery. Non-retryable: retrying
      // the same key against the same old API repeats the same drop.
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

    // ATTACHMENTS AND `forwardOf` RIDE THE SEND, not the draft. Attachment bytes are base64 on this
    // one request; the server decodes them, caps the total, hands them to the transport, and stores
    // none of them. `forwardOf` is just the original's id — the server reads the original, refuses a
    // no_forward one, builds the quoted MIME and streams its attachments. Omitted when neither is
    // set, so a plain send stays the bodyless request it has always been.
    const sendBody: { attachments?: typeof m.attachments; forwardOf?: string } = {};
    if (m.attachments && m.attachments.length) sendBody.attachments = m.attachments;
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
      // AMBIGUOUS, and it stays ambiguous: SMTP threw AND the Sent-folder probe found
      // nothing. Non-retryable because the server will replay this same answer for this key
      // forever; the user decides whether to compose a fresh send, with the warning on
      // screen. An automatic resend here would be the second delivery this whole path is
      // built to make impossible: one press is one delivery.
      this.draftForKey.delete(idempotencyKey);
      throw new MutationRejectedError(
        wire.message ?? "We couldn't confirm this send. Check your Sent folder before retrying.",
        { status: res.status, code: "send_unverified", retryable: false },
      );
    }

    if (wire.status === "in_flight") {
      // A genuinely concurrent attempt under this key is still running. Retryable: the same
      // key will replay the terminal outcome once it lands, and past SEND_STALE_AFTER_MS it
      // triggers the server's verify-by-Sent recovery instead.
      throw new MutationRejectedError(
        wire.message ?? "A send for this draft is already in progress.",
        { status: res.status, code: "send_in_flight", retryable: true },
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
    });
  }
}
