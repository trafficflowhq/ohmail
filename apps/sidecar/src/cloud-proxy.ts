import { createHash } from "node:crypto";
import { RELAY_ALLOWLIST, relayVerdict } from "@trafficflow/api/relay-allowlist";
import { offlineResponse, REQUEST_DEADLINE_MS, type CloudAuth } from "./cloud-auth.js";
import type { CloudMirror } from "./cloud-mirror.js";
import type { Diagnostic } from "./log.js";
import { leftOf } from "./pair-undo.js";
import { routeKeyOf, writeRowsOf } from "./cloud-write-rows.js";

/**
 * The write-through proxy — a Cloud-mode install owns no mailbox, so every WRITE is against the
 * HOSTED account, forwarded here with the bearer. Reads come from the mirror (`cloud-read.ts`);
 * everything else — a move, a mark-read, a rule edit, and the byte reads the mirror never holds
 * (`/attachments/:id`, `/img`) — relays to `api.ohmail.app` over the mirror's `authedFetch` and
 * returns the answer. A 2xx write waits (1.5 s bound) until the local copy holds it (THE
 * ECHO-AWAIT below); past the bound the window's shadow holds the row the person acted on, and the
 * mirror's follow-up chain keeps asking until the copy has it.
 * Offline is a MODE not a fault: it forwards nothing and answers `503 offline_read_only`.
 */

/** The relay carries this many routes. Read at construction so an empty projection cannot pass. */
const ALLOWLIST_MIN = 100;

/** How long the echo-await waits inside the mirror's pull before answering anyway. */
export const DEFAULT_ECHO_DEADLINE_MS = 1_500;

export interface WriteThroughProxyConfig {
  auth: CloudAuth;
  mirror: CloudMirror;
  log?: Diagnostic;
  /** Overridable for tests; production uses {@link DEFAULT_ECHO_DEADLINE_MS}. */
  echoDeadlineMs?: number;
  /**
   * TRUE when this install's server is NOT the one the browser hand-off page belongs to — i.e. a
   * server the person runs themselves. Chooses the wording of a refusal, never whether to refuse.
   */
  handoffForeign?: boolean;
  /**
   * The Idempotency-Keys of the window's writes the account answered 2xx, kept by the engine across
   * sessions: a kept outbox row whose key is here is applied and waits only for its echo. Bounded.
   */
  applied?: Set<string>;
}

/** How many applied keys are kept, the oldest dropped first: a dropped key's row counts as waiting again. */
export const APPLIED_KEYS_KEPT = 4_096;

/**
 * WHAT MAY BE FORWARDED — an allowlist, and a non-member is a 404. The relayable routes are the
 * API route table's own `Route.relay`, reaching here as `RELAY_ALLOWLIST`; `relayVerdict`
 * canonicalizes and matches with the server's own routines, so a spelling that reaches a hosted
 * route reaches the same verdict here. `handoffForeign` chooses the wording, never whether to
 * refuse.
 */

export interface WriteThroughProxy {
  /** Relay one request to Cloud (or 503 while offline), echo-awaiting a 2xx mutation. */
  forward(req: Request): Promise<Response>;
  /** Wait until every write already accepted has its server's answer, or until `by`, whichever is first. */
  settled(by: number): Promise<void>;
}

/** Hop-by-hop / re-authored headers that must not be relayed to Cloud. */
const STRIP_HEADERS = ["authorization", "host", "content-length", "connection"];

/**
 * THE ANSWER SPEAKS THIS INSTALL'S SEQUENCE. The hosted `X-Sync-Seq` counts the hosted change log;
 * the window stamps an echo with it and drains THIS install's `/sync`, a different count, so a
 * relayed seq outranked every later local change to the row (or lost to older ones). Covered: no
 * seq, and the window's drain carries the write. Not covered: the local head, which every older
 * local row is below and the write's own later row is above.
 */
function restamped(res: Response, local: bigint | null): Response {
  const headers = new Headers(res.headers);
  if (local === null) headers.delete("x-sync-seq");
  else headers.set("x-sync-seq", local.toString());
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Parse an `X-Sync-Seq` header to a cloud seq, or null when it is absent/unparseable. */
function parseSeq(raw: string | null): bigint | null {
  if (!raw) return null;
  try {
    const n = BigInt(raw.trim());
    return n >= 0n ? n : null;
  } catch {
    return null;
  }
}

/** The route PATTERN a write matched — `:id` placeholders only, never an id — or `other`. */
function routeClassOf(method: string, pathname: string): string {
  const key = routeKeyOf(method, pathname);
  return key === null ? "other" : key.slice(key.indexOf(" ") + 1);
}

/** A prefix of the Idempotency-Key's sha256, so a line can be matched to the account's record. */
function keyHashOf(req: Request): string | null {
  const key = req.headers.get("idempotency-key");
  return key ? createHash("sha256").update(key).digest("hex").slice(0, 16) : null;
}

/** The account's own `error.code`, held to an identifier grammar, from a CLONE of the answer. */
async function refusalCodeOf(res: Response): Promise<string | null> {
  try {
    const code = ((await res.clone().json()) as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

export function createWriteThroughProxy(cfg: WriteThroughProxyConfig): WriteThroughProxy {
  const echoDeadlineMs = cfg.echoDeadlineMs ?? DEFAULT_ECHO_DEADLINE_MS;
  /* An empty allowlist would refuse every write and read as an offline install. */
  if (RELAY_ALLOWLIST.length < ALLOWLIST_MIN) {
    throw new Error(`the relay allowlist holds ${RELAY_ALLOWLIST.length} routes; this build is incomplete`);
  }

  /**
   * ONE READ MAY ASK AFTER THIS DOOR'S OWN FORWARD FAILED. That failure marks the mirror offline,
   * and every relayed read answered 503 unasked until the next good pull. So the next read asks the
   * account: an answer clears the flag, a failure leaves offline mode as the pull found it.
   */
  let probeOwed = false;
  /**
   * THE WRITES THIS DOOR HAS ACCEPTED and not yet had answered: from before the body is read (a
   * slow upload is accepted work) to the server's answer, never the echo-await after it. A sign-out
   * waits on these, bounded, so a write already on its way lands under the session it was made in.
   */
  const accepted = new Set<Promise<void>>();
  const applied = cfg.applied ?? new Set<string>();

  const forward = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = `${url.pathname}${url.search}`;
    const method = req.method.toUpperCase();
    const mutation = method !== "GET" && method !== "HEAD";

    // PRIMARY OFFLINE GATE. Refused BEFORE the forward, so an offline write reaches neither Cloud
    // nor the local database — the "offline writes nothing" invariant, held by construction.
    if (cfg.mirror.online()) probeOwed = false;
    else if (mutation || !probeOwed) return offlineResponse();
    else probeOwed = false;

    /* Matched on the pathname, so a query string cannot slip past it, and refused before the body
       is read — a refused request reaches neither the network nor a buffer. */
    const verdict = relayVerdict(method, url.pathname);
    if (verdict !== "forward") {
      /* Logged: a route added without a verdict would otherwise be a 404 indistinguishable from a
         server that does not have the route. The FIRST SEGMENT only, and only when it is
         id-shaped — a whole pathname carries message ids, and the logger drops `path` for that
         reason. `other` when it is anything else, so no caller-chosen text reaches the line. */
      const head = url.pathname.split("/").filter((x) => x.length > 0)[0] ?? "";
      cfg.log?.("cloud_relay_refused", {
        method,
        route: /^[A-Za-z0-9._~-]{1,32}$/.test(head) ? head : "other",
        reason: "this route is not in the relay allowlist",
      });
      const handoff = verdict === "handoff" && cfg.handoffForeign === true;
      return new Response(
        JSON.stringify({
          error: {
            code: handoff ? "handoff_not_available" : "not_found",
            message: handoff
              ? "Signing in through a browser only works with the hosted ohmail service. On your " +
                "own server, sign in with your password and authenticator code."
              : "this install does not forward that request",
          },
        }),
        { status: handoff ? 409 : 404, headers: { "content-type": "application/json" } },
      );
    }

    const headers = new Headers(req.headers);
    for (const h of STRIP_HEADERS) headers.delete(h);

    let answered: () => void = () => {};
    if (mutation) {
      const entry: Promise<void> = new Promise<void>((r) => { answered = r; });
      accepted.add(entry);
      const done = answered;
      answered = () => { accepted.delete(entry); done(); };
    }

    const hasBody = method !== "GET" && method !== "HEAD";
    let body: ArrayBuffer | undefined;
    try {
      body = hasBody ? await req.arrayBuffer() : undefined;
    } catch (err) {
      answered();
      throw err;
    }

    let res: Response;
    const started = Date.now();
    try {
      res = await cfg.auth.authedFetch(path, {
        method,
        headers,
        ...(body && body.byteLength > 0 ? { body } : {}),
        /* A WRITE THE WINDOW MADE IS THE WINDOW'S. Its own signal keeps it out of what the session's
           stop ends: a sign-out pressed while it is out lets it finish on this deadline, and the
           account receives it once. A read stays the session's, and a sign-out ends it. */
        ...(mutation ? { signal: AbortSignal.timeout(REQUEST_DEADLINE_MS) } : {}),
      });
    } catch (err) {
      // The forward could not reach Cloud: mark the mirror offline so the next request short-
      // circuits, and answer the same 503. Nothing was written anywhere. A failed probe owes none.
      probeOwed = cfg.mirror.online();
      cfg.mirror.markConnectivity(false);
      cfg.log?.("cloud_forward_failed", {
        err,
        reason: "a request could not reach the hosted account; the install is marked offline and the " +
          "window is answered 503, which keeps a change for its next try",
      });
      return offlineResponse();
    } finally {
      answered();
    }

    // The account answered, so it is reachable whatever it said.
    if (!cfg.mirror.online()) cfg.mirror.markConnectivity(true);
    /* A send's draft create carries the send's own key (http-adapter.ts mailSend) and is not the
       send's verdict, so its 2xx records nothing; every other relayed write is one request. */
    const firstHalf = method === "POST" && url.pathname === "/drafts";
    const key = mutation && res.ok && !firstHalf ? req.headers.get("idempotency-key") : null;
    if (key !== null && key !== "") {
      applied.delete(key);
      applied.add(key);
      if (applied.size > APPLIED_KEYS_KEPT) applied.delete(applied.values().next().value!);
    }

    /* ONE LINE PER FORWARDED WRITE, the only record of it on this machine: the route's pattern,
       the account's status, the round trip and the key's hash — never the body, the path's ids or
       the key. A refusal also names the account's code, so it can be told from a transport fault. */
    if (mutation) {
      const routeClass = routeClassOf(method, url.pathname);
      const keyHash = keyHashOf(req);
      cfg.log?.("cloud_write_forwarded", { method, routeClass, status: res.status, ms: Date.now() - started, keyHash });
      if (res.status >= 400) {
        cfg.log?.("cloud_write_refused", { method, routeClass, status: res.status, code: await refusalCodeOf(res), keyHash });
      }
    }

    /* A WRITE ANSWERED 401 WAS NOT JUDGED: its session ended at the server (removed elsewhere, the
       refresh refused). The window is answered the signed-out wait and keeps it for that session. */
    if (mutation && res.status === 401) {
      void res.body?.cancel().catch(() => undefined);
      return new Response(JSON.stringify({
        error: { code: "not_signed_in", message: "this install is not signed in to a hosted account yet", retryable: true },
      }), { status: 409, headers: { "content-type": "application/json", "retry-after": "30" } });
    }

    // THE ECHO-AWAIT, by what the write changes here (`cloud-write-rows.ts`): nothing (its reads
    // relay) answers at once; a seq waits for the mirror to pull that far; no seq waits for a page
    // asked after the answer; mailbox rows for a list asked after it. The window re-drains local
    // `/sync` next, so a covered write is already in it. What the bound cuts, the route's follow-up
    // chain keeps asking for, and the window's drain waits on that chain (`cloud-engine.ts`).
    const target = res.ok ? parseSeq(res.headers.get("x-sync-seq")) : null;
    const write = res.ok && mutation;
    const rows = write ? writeRowsOf(method, url.pathname)?.rows ?? "sync" : "none";
    if (target === null && rows === "none") return res;
    const boxes = rows === "mailboxes" || rows === "sync+mailboxes";
    const route = routeKeyOf(method, url.pathname) ?? `${method} other`;
    const [seqCovered, freshCovered] = await Promise.all([
      target !== null ? cfg.mirror.awaitCloudSeq(target, echoDeadlineMs, route) : Promise.resolve(true),
      target === null || boxes
        ? cfg.mirror.awaitFreshPull(echoDeadlineMs, { sync: target === null && rows !== "mailboxes", mailboxes: boxes }, route)
        : Promise.resolve(true),
    ]);
    const covered = seqCovered && freshCovered;
    if (!covered) {
      cfg.log?.("cloud_write_echo", {
        reason: "the mirror did not catch up to the write within the echo bound; answering anyway, and a follow-up pull carries it",
      });
    }
    return target === null ? res : restamped(res, covered ? null : await cfg.mirror.localSeq());
  };

  return {
    forward,
    settled: async (by) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<void>((r) => { timer = setTimeout(r, leftOf(by)); });
      try {
        await Promise.race([Promise.allSettled([...accepted]), bound]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
