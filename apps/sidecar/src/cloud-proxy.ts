import type { CloudAuth } from "./cloud-auth.js";
import type { CloudMirror } from "./cloud-mirror.js";
import type { Diagnostic } from "./log.js";

/**
 * THE WRITE-THROUGH PROXY — a Cloud-mode install owns no mailbox, so every WRITE it is asked to
 * make is a write against the HOSTED account, forwarded here with the bearer.
 *
 * The local surface serves reads out of the mirror (`cloud-read.ts`) and `/sync` out of the local
 * `change_log`. Everything else — a move, a mark-read, a rule edit, a tag toggle, AND the byte
 * reads the mirror never holds (`/attachments/:id`, `/img`) — reaches this proxy, which relays it
 * to `api.ohmail.app` over the same `CloudAuth.authedFetch` the mirror pulls with (single-flight
 * 401 refresh included) and returns the hosted answer verbatim.
 *
 * ── THE ECHO-AWAIT, AND WHY ANSWERING TOO EARLY BREAKS EVERY WRITE ────────────────────────────
 *
 * `apps/macos`'s `EngineSource` re-drains the local `/sync` immediately after each write
 * (`EngineSource.swift:361`). In Cloud mode that local `/sync` is fed by the mirror's pull, which
 * is asynchronous — so if the proxy answered a mutation the instant Cloud accepted it, the client's
 * re-drain would run BEFORE the mirror had pulled the change, find nothing, and render the write as
 * refused-then-later-applied: a flicker on every single mutation.
 *
 * So on a 2xx that echoes `X-Sync-Seq` (the hosted `change_log` seq of the change the mutation
 * emitted — contract §3.4), the proxy WAITS: it drives the mirror to pull until its cloud cursor
 * covers that seq (bounded, ~5s), and only then returns. The comparison is cloud-seq to
 * cloud-cursor; the local `change_log` is a DIFFERENT sequence and is not what is being waited on.
 * If the bound elapses first the answer still goes back — the write succeeded on Cloud regardless,
 * and the next poll will reconcile the mirror.
 *
 * ── OFFLINE IS A MODE, NOT A FAULT ────────────────────────────────────────────────────────────
 *
 * The mirror flips `online` false when a pull fails. While offline this proxy forwards NOTHING and
 * answers `503 offline_read_only`: the read surface keeps serving what the mirror holds, but a
 * write must not be silently dropped, and — the invariant — an offline write touches NO local row.
 * That is structural here: the proxy never writes to the local database at all (a write only lands
 * locally by being pulled back through the mirror), so a request refused before the forward leaves
 * the mirror byte-for-byte unchanged. A forward that itself fails to reach Cloud marks the mirror
 * offline and answers the same 503.
 */

/** The error `code` a forwarded route answers with while the hosted account is unreachable. */
export const OFFLINE_READ_ONLY = "offline_read_only";

/** How long the echo-await drives the mirror before answering anyway. */
export const DEFAULT_ECHO_DEADLINE_MS = 5_000;

export interface WriteThroughProxyConfig {
  auth: CloudAuth;
  mirror: CloudMirror;
  log?: Diagnostic;
  /** Overridable for tests; production uses {@link DEFAULT_ECHO_DEADLINE_MS}. */
  echoDeadlineMs?: number;
  /**
   * TRUE when this install's server is NOT the one the browser hand-off page belongs to — i.e. a
   * server the person runs themselves. See {@link HANDOFF_CLAIM_PATHS}.
   */
  handoffForeign?: boolean;
}

/**
 * THE HOSTED SIGN-IN CEREMONY'S OWN ENDPOINTS, WHICH THIS PROXY MUST NOT RELAY TO A FOREIGN SERVER.
 *
 * This is a CATCH-ALL relay: everything the mirror cannot answer locally is forwarded to the
 * configured base with the bearer. That is right for mail, and wrong for exactly these two, because
 * the credential they carry is minted by the HOSTED service and is spendable there.
 *
 * The engine guards `/cloud/signin` and `/cloud/signin/challenge` — its own sign-in surface — and
 * review found those guards bypassable straight through here: `POST /auth/desktop-claim` with a
 * hosted hand-off code is neither of those paths, falls through the engine's route table, and is
 * relayed verbatim to whatever server the door names. The operator receives a live code (and the
 * verifier, if the caller has one) before their server has even answered.
 *
 * The lesson is the one the previous two rounds taught, arriving a third time: a guard placed at
 * the ROUTE somebody is expected to use is not a guard on the PROPERTY. This one sits at the relay,
 * so every caller of {@link WriteThroughProxy.forward} is covered rather than the one call site
 * that was known about.
 *
 * DELIBERATELY NOT ALL OF `/auth/*`. Step-up, the audit log, e-mail verification and sign-out are
 * ordinary Settings traffic that a self-hosted account must be able to perform against its OWN
 * server — refusing those would break the door rather than protect it. These two are the whole of
 * the hand-off surface, and nothing else in the API's `/auth` table carries a credential minted
 * elsewhere.
 *
 * ── ONE VECTOR THIS DOES NOT CLOSE, NAMED RATHER THAN LEFT TO BE FOUND ────────────────────────
 *
 * `fetch` follows redirects, and re-sends the body on a 307/308. So a server could answer some
 * OTHER, unrefused path with a redirect to the claim route and receive the body that way. Review
 * raised it and it is real.
 *
 * It is accepted, for two reasons that are worth having written down. The FIRST is that the
 * redirecting server is the operator's own: reaching this vector needs a hostile window to post a
 * hosted code to a path of its choosing, and a window that hostile has no need of a redirect — it
 * is already choosing where the request goes. The redirect adds nothing it did not have. The SECOND
 * is what closing it would cost: `redirect: "manual"` on this relay, and this relay is also how
 * attachment and media bytes are read, which the hosted API answers with a redirect to a
 * presigned storage URL. Blocking redirects here would break every attachment on both cloud doors
 * to narrow a vector that a hostile window does not need. If the byte reads ever stop redirecting,
 * `redirect: "manual"` becomes free and should be taken.
 */
export const HANDOFF_CLAIM_PATHS = ["/auth/desktop-claim", "/auth/desktop-link"] as const;

/**
 * A request path reduced to what this refusal may compare — the spellings that reach the SAME
 * hosted route must not reach different answers here.
 *
 * A bare `includes(url.pathname)` was the first version and it is one character from useless: the
 * hosted API answers `/auth/desktop-claim/` and `/auth/desktop-claim` the same way, so a trailing
 * slash would have walked straight past the guard and been relayed. Case is folded for the same
 * reason and costs nothing. Repeated slashes collapse.
 *
 * PERCENT-ENCODING IS DECODED, and the first version of this said it deliberately was not. That
 * reasoning covered only `%2F` — where leaving it encoded is right, because the hosted router reads
 * it as one literal segment — and ignored every OTHER escape: `/auth/desktop%2Dclaim` is
 * `/auth/desktop-claim` to anything that decodes, and this guard did not. Review named it.
 *
 * Decoding is also the safe DIRECTION, which is what settles it. An escape that the hosted router
 * would not have decoded now matches this refusal, so the worst case is refusing a request that
 * would have 404'd — nothing lost. Not decoding meant relaying a live credential. A malformed
 * escape throws in `decodeURIComponent`, and that too is refused rather than passed: an
 * undecodable path is not a path this relay can reason about.
 *
 * Traversal needs no handling: the URL standard resolves `..` before `pathname` is read, so
 * `/x/../auth/desktop-claim` arrives already normalised — asserted rather than assumed, because it
 * is a claim about the platform.
 */
export function normalizeRefusalPath(pathname: string): string {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    /* Undecodable. Fall through with the raw value; a path this cannot read is a path it refuses
       rather than reasons about — see above. */
  }
  const collapsed = decoded.replace(/\/{2,}/g, "/").toLowerCase();
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

const REFUSED_PATHS = new Set<string>(HANDOFF_CLAIM_PATHS.map(normalizeRefusalPath));

export interface WriteThroughProxy {
  /** Relay one request to Cloud (or 503 while offline), echo-awaiting a 2xx mutation. */
  forward(req: Request): Promise<Response>;
}

/** Hop-by-hop / re-authored headers that must not be relayed to Cloud. */
const STRIP_HEADERS = ["authorization", "host", "content-length", "connection"];

function offlineResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: OFFLINE_READ_ONLY,
        message:
          "this install is offline — the hosted mailbox cannot be reached, so writes are paused " +
          "until it returns; what is already mirrored keeps reading",
        retryable: true,
      },
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
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

  const forward = async (req: Request): Promise<Response> => {
    // PRIMARY OFFLINE GATE. Refused BEFORE the forward, so an offline write reaches neither Cloud
    // nor the local database — the "offline writes nothing" invariant, held by construction.
    if (!cfg.mirror.online()) return offlineResponse();

    const url = new URL(req.url);
    const path = `${url.pathname}${url.search}`;
    const method = req.method.toUpperCase();

    /* THE HAND-OFF CEREMONY IS NEVER RELAYED TO A SERVER THE PERSON RUNS. See
       {@link HANDOFF_CLAIM_PATHS} — the credential these carry is the HOSTED service's, and this
       relay would hand it to whoever runs the configured one. Matched on the PATHNAME, so a query
       string cannot slip past it. */
    if (cfg.handoffForeign === true && REFUSED_PATHS.has(normalizeRefusalPath(url.pathname))) {
      return new Response(
        JSON.stringify({
          error: {
            code: "handoff_not_available",
            message:
              "Signing in through a browser only works with the hosted ohmail service. On your " +
              "own server, sign in with your password and authenticator code.",
          },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
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

    // THE ECHO-AWAIT. A 2xx mutation carries the hosted seq of the change it emitted; wait for the
    // mirror to pull that far before answering, so the client's immediate local /sync re-drain
    // already contains its own write.
    const target = res.ok ? parseSeq(res.headers.get("x-sync-seq")) : null;
    if (target !== null) {
      const covered = await cfg.mirror.awaitCloudSeq(target, echoDeadlineMs);
      // Only the miss earns a line: the mirror did not catch up within the bound, so the answer
      // goes back ahead of the local echo and the next poll reconciles it.
      if (!covered) {
        cfg.log?.("cloud_write_echo", {
          reason: "the mirror did not catch up to the write within the echo bound; answering anyway and reconciling on the next poll",
        });
      }
    }
    return res;
  };

  return { forward };
}
