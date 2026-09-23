import { RELAY_ALLOWLIST, relayVerdict } from "@trafficflow/api/relay-allowlist";
import { offlineResponse, type CloudAuth } from "./cloud-auth.js";
import type { CloudMirror } from "./cloud-mirror.js";
import type { Diagnostic } from "./log.js";
import { writeRowsOf } from "./cloud-write-rows.js";

/**
 * The write-through proxy — a Cloud-mode install owns no mailbox, so every WRITE is against the
 * HOSTED account, forwarded here with the bearer. Reads come from the mirror (`cloud-read.ts`);
 * everything else — a move, a mark-read, a rule edit, and the byte reads the mirror never holds
 * (`/attachments/:id`, `/img`) — relays to `api.ohmail.app` over the mirror's `authedFetch` and
 * returns the answer. A 2xx write waits (1.5 s bound) until the local copy holds it (THE
 * ECHO-AWAIT below); past the bound the window's shadow holds the row the person acted on.
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
}

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

export function createWriteThroughProxy(cfg: WriteThroughProxyConfig): WriteThroughProxy {
  const echoDeadlineMs = cfg.echoDeadlineMs ?? DEFAULT_ECHO_DEADLINE_MS;
  /* An empty allowlist would refuse every write and read as an offline install. */
  if (RELAY_ALLOWLIST.length < ALLOWLIST_MIN) {
    throw new Error(`the relay allowlist holds ${RELAY_ALLOWLIST.length} routes; this build is incomplete`);
  }

  const forward = async (req: Request): Promise<Response> => {
    // PRIMARY OFFLINE GATE. Refused BEFORE the forward, so an offline write reaches neither Cloud
    // nor the local database — the "offline writes nothing" invariant, held by construction.
    if (!cfg.mirror.online()) return offlineResponse();

    const url = new URL(req.url);
    const path = `${url.pathname}${url.search}`;
    const method = req.method.toUpperCase();

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

    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? await req.arrayBuffer() : undefined;

    let res: Response;
    try {
      res = await cfg.auth.authedFetch(path, {
        method,
        headers,
        ...(body && body.byteLength > 0 ? { body } : {}),
      });
    } catch (err) {
      // The forward could not reach Cloud: mark the mirror offline so the next request short-
      // circuits, and answer the same 503. Nothing was written anywhere.
      cfg.mirror.markConnectivity(false);
      cfg.log?.("cloud_forward_failed", {
        err,
        reason: "a write could not be delivered to the hosted account; the install is offline and " +
          "the mutation is refused rather than dropped",
      });
      return offlineResponse();
    }

    // THE ECHO-AWAIT, by what the write changes here (`cloud-write-rows.ts`): nothing (its reads
    // relay) answers at once; a seq waits for the mirror to pull that far; no seq waits for a page
    // asked after the answer; mailbox rows for a list asked after it. The window re-drains local
    // `/sync` next, so a covered write is already in it; what the bound cuts, its shadow holds.
    const target = res.ok ? parseSeq(res.headers.get("x-sync-seq")) : null;
    const write = res.ok && method !== "GET" && method !== "HEAD";
    const rows = write ? writeRowsOf(method, url.pathname)?.rows ?? "sync" : "none";
    if (target === null && rows === "none") return res;
    const boxes = rows === "mailboxes" || rows === "sync+mailboxes";
    const [seqCovered, freshCovered] = await Promise.all([
      target !== null ? cfg.mirror.awaitCloudSeq(target, echoDeadlineMs) : Promise.resolve(true),
      target === null || boxes
        ? cfg.mirror.awaitFreshPull(echoDeadlineMs, { sync: target === null && rows !== "mailboxes", mailboxes: boxes })
        : Promise.resolve(true),
    ]);
    const covered = seqCovered && freshCovered;
    if (!covered) {
      cfg.log?.("cloud_write_echo", {
        reason: "the mirror did not catch up to the write within the echo bound; answering anyway and reconciling on the next poll",
      });
    }
    return target === null ? res : restamped(res, covered ? null : await cfg.mirror.localSeq());
  };

  return { forward };
}
