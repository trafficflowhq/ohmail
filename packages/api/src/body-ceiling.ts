import { matchRoute, type Route } from "./router.js";

/**
 * WHAT MAY THIS REQUEST'S BODY WEIGH — decided from the ROUTE, before a byte is read.
 *
 * ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────────────────────
 *
 * Both hosts canonicalize the request path and then buffer the whole body
 * (`apps/server/src/handler.ts`, `apps/api-vercel/src/prefix.ts`: `await req.arrayBuffer()` for
 * every non-GET). That buffer is allocated BEFORE route matching and long before
 * authentication, against ONE ceiling that is the largest any route could ever need — 50 MiB on
 * the self-host adapter. So an anonymous client that never presents a credential, and never
 * names a path this API serves, can make the process allocate 50 MiB per connection and hold it
 * for the length of the transfer. N connections is N × 50 MiB of a long-running process's heap,
 * and the request that pays for it is refused a moment later with a 404.
 *
 * The ceiling was not wrong; it was UNCONDITIONAL. It exists for exactly one route
 * ({@link LARGE_BODY_ROUTES}) and was being applied to all of them, including the ones that do
 * not exist.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────────────────
 *
 * The path is enough to decide this, and the path costs nothing: `matchRoute` reads the URL and
 * no body at all. So the door matches first and buffers second, under the ceiling THAT route
 * declares:
 *
 *   · no route matches the method+path  ⇒ **0 bytes**. Nothing is read. `app.handle` matches the
 *     same table a moment later and answers its own 404/405, which is byte-identical to what it
 *     answered before — the handler never ran, so a body nobody was going to read is not missed.
 *   · GET / HEAD                        ⇒ **0 bytes**, as before.
 *   · a route in {@link LARGE_BODY_ROUTES} ⇒ the host's large ceiling, its own number.
 *   · everything else                   ⇒ {@link JSON_BODY_MAX_BYTES}.
 *
 * ── WHY THE LARGE SET IS A LIST AND NOT A ROUTE FLAG ──────────────────────────────────────
 *
 * A `bodyMax` on {@link RouteOptions} would be OPTIONAL, and an optional bound is the shape
 * `router.ts` already argues against for `cost`: *"opt-IN, so route 125 was ungated by default
 * and 122 of 124 routes were ungated in fact"*. Here the default is the SAFE direction — a route
 * that declares nothing gets the small ceiling — so the risk runs the other way: a genuinely
 * large route added later would be refused at {@link JSON_BODY_MAX_BYTES}. That fails LOUDLY (a
 * 413 naming the limit on the developer's first send) rather than quietly, which is the right way
 * round.
 *
 * And the list is not trusted on its own word: `input-bounds-census.test.ts` derives the set of
 * routes whose handler decodes inline bytes from the handlers' own source and asserts it equals
 * this constant, in both directions. A new route that takes `contentBase64` and is not listed
 * here reddens the build; a listed route that stops taking bytes reddens it too.
 */

/**
 * The ceiling for every route that carries a JSON body — every route but one.
 *
 * `POST /drafts/:id/send` carries JSON too; it is the exception because its JSON contains
 * attachment BYTES, and it gets the host's own large number instead. See
 * {@link LARGE_BODY_ROUTES}.
 *
 * ── THE NUMBER IS DERIVED FROM THE LARGEST BODY THE TABLE ITSELF DECLARES LEGAL ───────────
 *
 * A door ceiling under the largest request the routes accept would refuse a request the service
 * was going to serve — a 413 for a correct call, which is a worse failure than the one being
 * fixed because it is silent about which of the two limits it broke. So the number is the worst
 * LEGAL body plus headroom, and `input-bounds-census.test.ts` recomputes that product from the
 * constants and fails if a future bump makes them collide:
 *
 *   · `POST /drafts` — `DRAFT_HTML_CAP_BYTES` (256 KiB), the request's recipient TOTAL at
 *     `DRAFT_MAX_RECIPIENTS` × (`RECIPIENT_ADDRESS_MAX_CHARS` + `RECIPIENT_NAME_MAX_CHARS`), and
 *     `DRAFT_SUBJECT_MAX_CHARS`. This is the largest. The recipient factor is ONE and not three
 *     because `DraftsService.boundRecipientTotal` bounds to/cc/bcc together — which it does
 *     BECAUSE of this arithmetic: per-field, at the send ceiling, the product was 4 832 016 and
 *     no door both admitted it and was worth having.
 *   · `PATCH /consent/settings` — `SETTINGS_MAX_MAILBOX_ENTRIES` signatures at
 *     `MAILBOX_SIGNATURE_MAX_CHARS` (10 000) each.
 *   · `PATCH /messages` — the largest COUNT-shaped body, `MARK_SEEN_MAX_IDS` message ids.
 *
 * **Every character is counted at SIX bytes, not four.** UTF-8's own maximum is four, but
 * `JSON.stringify` escapes a control character as `\u00xx` — six wire bytes for one character that every
 * validator here accepts. Two review rounds corrected this number: the first found the
 * four-byte factor, the second found it applied to the recipient strings and not to the html.
 * A formula that undercounts the worst legal body certifies a compatibility the door does not
 * have, which is worse than not checking at all.
 *
 * 4 MiB clears the largest (≈2.56 MB, `POST /drafts`) with real headroom, and is still 12x
 * under what the
 * self-host door used to admit from an anonymous caller who had named no route at all.
 *
 * **AND IT MUST STAY UNDER THE SMALLEST DOOR IN THE FLEET, which is not ours.** The managed host
 * is capped by the platform at {@link HOSTED_LARGE_BODY_MAX_BYTES} — 4.5 MB — whatever this
 * constant says. A number above that would certify a compatibility the deployment does not have:
 * the request would die at the platform edge with an error neither host wrote, and this door
 * would never see it. The census asserts the ordering (worst legal body < this < the platform's
 * ceiling) rather than leaving it to whoever next raises a field cap.
 *
 * **`POST /consent/seed` is deliberately NOT in that product, and the reason is worth stating.**
 * Its `SEED_MAX_ADDRESSES` ceiling is a coarse count whose job is to stop an unbounded list being
 * folded before the review intersects it; the number of BYTES that list weighs is this door's
 * question, not that ceiling's. A confirmation of 50 000 maximal addr-specs is 16 MB and is
 * refused here, by a 413 that names this limit in bytes — which is the actionable answer for a
 * request whose problem is its size. The two bound different things and whichever binds first
 * says so in its own units.
 *
 * ── AND IT IS A BACKSTOP, NOT THE BOUND ──────────────────────────────────────────────────
 *
 * Every field that reaches a query, a loop or a per-row predicate with a cost PROPORTIONAL to
 * its size carries its own named ceiling (see the census). What this number closes is the class
 * of value that has no per-field bound of its own — a snippet's text, a note's body, a mailbox's
 * signature.
 *
 * **Two of the examples this used to give were wrong, and the correction is the point.** It
 * named a KB entry's `content` and a workflow step's `args` as values whose *"only sink is one
 * column write"*. Neither is: KB content is indexed and read back by `KbService.retrieve`'s
 * tsquery and trigram arms, and a step's `args` are resolved and executed by the worker. They are
 * still bounded by this door and by nothing else — that part was true — but calling their column
 * the terminal sink understates what they reach, and an understated sink is how a value stops
 * getting a bound of its own. The census's `door:` entries name the real downstream sink for each.
 */
export const JSON_BODY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The routes whose body may legitimately carry attachment BYTES inline (base64), and so may not
 * be held to {@link JSON_BODY_MAX_BYTES}.
 *
 * Exactly one, and it is derived-checked rather than asserted: `POST /drafts/:id/send` decodes
 * `contentBase64` entries in `routes/drafts.ts#decodeSendAttachments`. The per-request TOTAL of
 * those bytes is bounded separately and more tightly by `SEND_ATTACHMENT_MAX_TOTAL_BYTES` (or a
 * self-host deployment's own `SELF_HOST_SEND_MAX_TOTAL_BYTES`) inside `SendService.reserve`;
 * this is only the door's permission for the request to be big at all.
 */
export const LARGE_BODY_ROUTES: ReadonlySet<string> = new Set<string>([
  "POST /drafts/:id/send",
]);

/** A body that crossed its route's ceiling. Both hosts answer it as 413. */
export class BodyOverCeilingError extends Error {
  constructor(readonly maxBytes: number, readonly sawBytes: number | null) {
    super("request body exceeds this route's ceiling");
    this.name = "BodyOverCeilingError";
  }
}

/**
 * The ceiling in bytes for one request, from its method and CANONICAL pathname. `0` means
 * "read nothing" — a body-less method, or a path this table does not serve.
 *
 * `largeBodyMaxBytes` is the host's own number for the send surface, because the two hosts
 * differ: a self-host process sets `BODY_MAX_BYTES` (50 MiB) and the managed host is capped by
 * the platform at 4.5 MB whatever we write here.
 */
export function bodyCeilingFor(
  routes: Route[], method: string, pathname: string, largeBodyMaxBytes: number,
): number {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return 0;
  const match = matchRoute(routes, m, pathname);
  if (!match.matched) return 0;
  return LARGE_BODY_ROUTES.has(`${match.route.method.toUpperCase()} ${match.route.pattern}`)
    ? largeBodyMaxBytes
    : JSON_BODY_MAX_BYTES;
}

/**
 * Read at most `maxBytes` of `req`'s body, or throw {@link BodyOverCeilingError}.
 *
 * ── WHY THIS IS NOT `req.arrayBuffer()` WITH A CHECK AFTERWARDS ───────────────────────────
 *
 * A check afterwards is a check on bytes already in the heap, which is precisely the cost being
 * refused. The declared `Content-Length` is consulted first — that refuses an honest oversized
 * request for nothing — and then the stream is counted as it arrives, because a chunked body
 * may declare no length at all or declare one that is a lie. The running total is compared
 * BEFORE the chunk is retained, so the peak is one chunk over the ceiling and never the whole
 * body.
 *
 * A `null` body is `undefined`, never a zero-length buffer: undici gives a Request constructed
 * with an empty body a non-null `body`, and `withRequestGuard` then demands a `Content-Type`
 * from a legitimately body-less `POST /auth/logout`. Both hosts' `normalizeRequest` already
 * carried that rule; it is kept here verbatim rather than restated at each call site.
 */
export async function readBodyWithin(
  req: Request, maxBytes: number,
): Promise<ArrayBuffer | undefined> {
  if (maxBytes <= 0) {
    // Nothing may be read. Release the socket rather than leaving it half-consumed: an
    // unmatched POST's body is drained by the platform either way, and cancelling says so.
    await req.body?.cancel().catch(() => { /* already gone */ });
    return undefined;
  }

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await req.body?.cancel().catch(() => { /* already gone */ });
    throw new BodyOverCeilingError(maxBytes, declared);
  }

  const body = req.body;
  if (!body) return undefined;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      // BEFORE the chunk is retained — see the docstring. Retaining it first would make the
      // peak the whole body for a client that sends it in one chunk, which is the normal case.
      if (total > maxBytes) throw new BodyOverCeilingError(maxBytes, total);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => { /* already closed, or already errored */ });
  }

  if (total === 0) return undefined;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out.buffer as ArrayBuffer;
}
