import { and, eq, inArray } from "drizzle-orm";
import { messageBodies, messages } from "@trafficflow/db/mail";
import {
  messageService, threadService, searchService, mailboxService, tagsService, rulesService,
  syncService, SEARCH_SORTS, isSearchSort, ServiceError,
  type SearchFilters, type SearchOptions, type ServiceContext,
} from "@trafficflow/services/mail";

/**
 * THE CLOUD-MODE LOCAL READ SURFACE — the full mail READ routes, served from the mirror in PGlite.
 *
 * ── WHY THIS FILE EXISTS INSTEAD OF `packages/api`'s ROUTE TABLE ───────────────────────────────
 *
 * The Swift client speaks the same `GET /messages`, `/threads/:id`, `/search`, `/mailboxes`,
 * `/tags`, `/rules` surface it does against the hosted API. The obvious move — mount
 * `packages/api`'s `localRoutes` — is exactly the one Cloud mode may not make: those route modules
 * import `routes/shared.ts`, which imports `deps.ts`, which carries the IMAP admission port; and
 * `/mailboxes`, `/attachments`, `/drafts` reach the IMAP adapter itself. Pulling that table in
 * would put the organizer's machinery back in the Cloud engine's graph — the one thing
 * `test/cloud-engine-census.test.ts` forbids by construction.
 *
 * So this is a curated, READ-ONLY route table that reaches ONLY the read services
 * (`messageService`, `threadService`, `searchService`, `mailboxService`, `tagsService`,
 * `rulesService`) — every one of them already in the census-clean `@trafficflow/services/mail`
 * graph the Cloud engine imports, so importing them here adds NOTHING new to reach. There is no
 * IMAP adapter, no lease, no worker loop behind any handler in this file, and the expanded census
 * proves it: add an IMAP import to this module and the census goes red.
 *
 * ── A MIRROR IS READ-ONLY, SO THIS TABLE IS GET-ONLY ──────────────────────────────────────────
 *
 * The hosted worker is the single organizer of the mailbox; a Cloud-mode install mutates nothing
 * locally. Every mutation the client issues is a WRITE against the hosted account and is forwarded
 * by the write-through proxy (`cloud-proxy.ts`), never served here. This table therefore carries
 * only reads — the projection the mirror already holds — and a request that matches nothing here
 * falls through to the proxy.
 *
 * ── AND ONLY READS THE MIRROR CAN ANSWER TRUTHFULLY ───────────────────────────────────────────
 *
 * The converse boundary, learned from the folder-contents defect: a read whose QUESTION is about
 * what the mirror does NOT hold must forward, however read-shaped it looks. `GET /messages` (the
 * list route) is the reach-past door — a page of mail beyond the local window — and is therefore
 * absent from this table on purpose; see the note at its former position below. The same rule
 * gives `GET /messages/:id/body` a fall-through in `cloud-engine.ts`: served from the mirror when
 * the message is mirrored, forwarded to the hosted account when it is a reach-past row the mirror
 * never held.
 *
 * ── AND A MIRRORED MESSAGE IS NOT THE SAME FACT AS A MIRRORED BODY ────────────────────────────
 *
 * That rule was applied to one half of the question and the other half is where the first load
 * went wrong. A mirrored install fills in TWO passes — `cloud-mirror.ts`: bodies "are not a
 * `/sync` entity", so `backfillBodies` runs only after `drainSync` has returned to the horizon —
 * and the gap between them is not an edge case, it is every first launch, running for hours on a
 * large account. In that gap `messages` holds the row and `message_bodies` does not.
 *
 * `MessageService.getBody` is written for the HOSTED server, where an absent body row can only
 * mean "never ingested", and its documented answer is the honest one there: "a message with no
 * ingested body yields an empty body" — `200 {text: "", html: null}`. Served out of a MIRROR the
 * same bytes are a fabrication, because here an absent row means "not copied yet" about mail the
 * hosted account is holding in full.
 *
 * The client cannot tell those apart and does not treat either as provisional: an answered body is
 * `ready`, and `OhmailEngine.bodyPlan` never re-fetches a `ready` record. So one empty answer in
 * that window is permanent — the desktop window's mirror is in memory, so quitting and reopening
 * the app is what "fixes" it, which is why this reads as flakiness rather than as a defect.
 * {@link mirroredBodyIds} is the distinction the read surface was missing, and both body routes
 * now ask it before they answer.
 */

export interface ReadRoute {
  method: string;
  /** e.g. `/messages/:id/body`. `:name` is a single-segment parameter. */
  pattern: string;
  handler: (req: Request, ctx: ServiceContext, params: Record<string, string>) => Promise<Response>;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A numeric query param, or undefined when absent/blank (the service applies its own default). */
const num = (v: string | null): number | undefined => (v != null && v !== "" ? Number(v) : undefined);

/** "true"/"1" → true, "false"/"0" → false, else undefined (filter omitted). Mirrors `routes/search.ts`. */
function boolParam(v: string | null): boolean | undefined {
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

/**
 * WHICH OF THESE MESSAGES THIS MIRROR ACTUALLY HOLDS A BODY FOR — the fact the body routes were
 * answering without.
 *
 * A row's PRESENCE is the whole signal, and its contents are deliberately not consulted. A body
 * the hosted account is withholding (`storage_cap`, `junk_filed`, `expunged`) is stored as a real
 * row carrying its marker, and an ordinarily empty message is a real row too — both are settled
 * answers the mirror genuinely holds, and both must keep being served from here. What must not be
 * served is the case with no row at all, which in a mirror means the copy has not arrived.
 *
 * Scoped through `messages.account_id` for the reason `MessageService.getBody` gives about the
 * same join: `message_bodies` has no account column, so the join IS the authorization, and asking
 * this question about an id must not become a way to learn that somebody else's message exists.
 */
async function mirroredBodyIds(ctx: ServiceContext, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await ctx.db
    .select({ messageId: messageBodies.messageId })
    .from(messageBodies)
    .innerJoin(messages, eq(messages.id, messageBodies.messageId))
    .where(and(eq(messages.accountId, ctx.accountId), inArray(messageBodies.messageId, [...ids])));
  return new Set(rows.map((r) => r.messageId));
}

/**
 * The read table. `GET /messages/bodies` is listed before `GET /messages/:id` for readability only:
 * {@link matchReadRoute} resolves the most specific pattern regardless of order, so the static
 * `bodies` segment (specificity 1) always beats the `:id` parameter (specificity 0) and a request
 * for `/messages/bodies` can never bind `id = "bodies"`.
 */
export const READ_ROUTES: ReadRoute[] = [
  /**
   * THE COLD-START READ, AND THE ONE ROUTE WHERE FORWARDING IS WRONG RATHER THAN SLOW.
   *
   * `GET /sync/snapshot` answers with the account's current state — newest first — plus `asOfSeq`,
   * the point it was read at, which the client commits as its `/sync` cursor. Two sequences exist
   * in a mirrored install and they are unrelated numbers: the hosted account's, which the mirror's
   * own pull is counted in, and this database's local `change_log`, which is what `GET /sync` is
   * answered from. Forwarding this route returns a cursor in the first and hands it to a client
   * whose next request is answered in the second, so the mailbox bootstraps once, looks complete,
   * and never receives another change.
   *
   * It was forwarded, and the desktop client compensated by refusing to use the route at all —
   * which is why a cold start filled OLDEST first, a page of the change log at a time, instead of
   * painting the newest mail immediately. Serving it here is what let that capability come back.
   *
   * `syncService` is a read service like every other one in this table: it selects rows for the
   * caller's own account and writes nothing, and it is already in the Cloud engine's graph, so the
   * census over this module is unchanged.
   */
  {
    method: "GET",
    pattern: "/sync/snapshot",
    handler: async (req, ctx) => {
      const url = new URL(req.url);
      const cursor = url.searchParams.get("cursor");
      const limitRaw = url.searchParams.get("limit");
      const limit = num(limitRaw);
      return json(
        await syncService.getSnapshot(ctx, {
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined && !Number.isNaN(limit) ? { limit } : {}),
        }),
      );
    },
  },
  /*
   * `GET /messages` (the LIST route) is DELIBERATELY NOT IN THIS TABLE, and its absence is the
   * folder-contents fix, so it is recorded here rather than left to be re-derived.
   *
   * The JS client calls that route for exactly one thing: the reach-past door
   * (`HttpAdapter.listMessages` — "one keyset page of a view, oldest-ward"), which by definition
   * asks for mail BEYOND what the local store kept. The mirror in this database is a window over
   * the hosted account, so serving the route from the mirror answers the one question the mirror
   * cannot answer: it re-serves the rows the client already renders and then says `nextCursor:
   * null` — "your mail ends here" — about a mailbox whose older mail is all on the hosted
   * account. Worse for folders: this table's handler predated `view=folder` and dropped
   * `folderId`/`beforeId`/`beforeDate` on the floor, so the service answered
   * `400 view=folder requires folderId` and every folder on the desktop's hosted door rendered
   * nothing but the reach-past failure line.
   *
   * So the list ask falls through to the write-through proxy and is answered by the hosted
   * account — the same treatment as the attachment/media byte reads the mirror never holds.
   * The hosted ids are the local ids (the mirror stores hosted entity ids verbatim), so the
   * answered rows compose with the mirror-preferred merge on the client. Offline, the proxy
   * answers `503 offline_read_only`, which the reach-past surface renders as its honest failed
   * state with a retry — a paused door, never a claim that the mail ends here.
   */
  /**
   * THE BATCH BODY READ — and it has TWO modes, which this door used to collapse into one.
   *
   * `MessageService.getBodies` selects its mode from the `ids` option: with ids it answers those
   * messages, without them it keyset-pages the account. This handler read only `after` and `limit`,
   * so `ids` was dropped on the floor and every `?ids=` ask — which is what `HttpAdapter.fetchBodies`
   * sends, the door a thread open and the eager recent-window pass both use — was answered as the
   * KEYSET WALK: a page of the account's bodies from the beginning, about other messages entirely.
   * The client matches rows by `messageId` and never by position, so it found none of what it asked
   * for and fell back to asking per message; the visible cost was a wasted page on every thread
   * open, and the invisible one was that the batch door never worked on this door at all.
   *
   * ── AND THE IDS MODE OMITS WHAT THE MIRROR HAS NO BODY FOR ────────────────────────────────
   *
   * Same distinction as the single-body route above, expressed the way THIS route already
   * expresses absence. Omission is not a new shape here: the ids mode omits ids the account does
   * not own (deliberately, so the route is not an existence oracle), the wire rows carry their own
   * `messageId`, and `HttpAdapter.fetchBodies`' contract says a short answer is normal and the
   * engine "asks for what is missing per message". So a body the mirror has not copied yet drops
   * out of the batch and the reader's next ask goes down the per-message door, which forwards.
   * Answering `text: ""` for it instead is the fabrication the header describes, and it would be
   * cached as a settled body exactly as the single-body one was.
   *
   * The KEYSET mode is left exactly as it was. It is a walk over what this database holds — its
   * question is "what have you got", not "what does this message say" — and a caller paging it is
   * asking about the mirror rather than about the mail.
   */
  {
    method: "GET",
    pattern: "/messages/bodies",
    handler: async (req, ctx) => {
      const url = new URL(req.url);
      const idsRaw = url.searchParams.get("ids");
      const after = url.searchParams.get("after");
      const limit = num(url.searchParams.get("limit"));
      if (idsRaw !== null) {
        const ids = idsRaw.split(",").map((v) => v.trim()).filter((v) => v !== "");
        const page = await messageService.getBodies(ctx, { ids });
        const held = await mirroredBodyIds(ctx, page.items.map((i) => i.messageId));
        return json({ items: page.items.filter((i) => held.has(i.messageId)), nextCursor: null });
      }
      const page = await messageService.getBodies(ctx, {
        ...(after ? { after } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return json({ items: page.items, nextCursor: page.nextCursor });
    },
  },
  {
    method: "GET",
    pattern: "/messages/:id",
    handler: async (_req, ctx, params) => json(await messageService.get(ctx, params.id!)),
  },
  /**
   * ONE BODY — from the mirror when the mirror has it, and NOT INVENTED when it does not.
   *
   * The `not_found` is what routes this to the hosted account: `cloud-engine.ts` already forwards
   * exactly this route on exactly this code, for the reach-past row whose MESSAGE the mirror never
   * held. A mirrored message whose BODY has not been copied yet is the same question wearing a
   * different hat — "is this something the mirror can answer truthfully?" — and it takes the same
   * answer, so it is expressed as the same signal rather than as a second forwarding path.
   *
   * The cost is one forwarded round trip per body the reader opens ahead of the walk, against a
   * hosted account that holds the mail; the walk keeps filling the mirror behind it and later
   * opens are local again. Offline, the proxy answers `503 offline_read_only`, which the reading
   * pane renders as "couldn't load the full message" with a Retry — a stated failure the reader
   * can act on, and one the engine re-asks on its next launch, rather than a blank message that
   * looks like mail with nothing in it.
   */
  {
    method: "GET",
    pattern: "/messages/:id/body",
    handler: async (_req, ctx, params) => {
      const id = params.id!;
      if (!(await mirroredBodyIds(ctx, [id])).has(id)) {
        throw new ServiceError("not_found", 404, "message not found");
      }
      return json(await messageService.getBody(ctx, id));
    },
  },
  {
    method: "GET",
    pattern: "/threads/:id",
    handler: async (_req, ctx, params) => json(await threadService.get(ctx, params.id!)),
  },
  {
    method: "GET",
    pattern: "/search",
    handler: async (req, ctx) => {
      const url = new URL(req.url);
      const q = url.searchParams.get("q") ?? "";
      const limit = num(url.searchParams.get("limit"));

      /**
       * The SAME refusal `packages/api/src/routes/search.ts` makes, and it has to be repeated
       * here for the reason this whole file exists: a Cloud-mode install may not import that
       * route table (it drags the IMAP admission port into the engine's graph and the census
       * goes red), so the two doors are held together by shape rather than by shared code.
       * `test/cloud-search-sort.test.ts` drives both and asserts they answer alike — an order this
       * door accepted and ignored would make the desktop quietly disagree with the web client
       * about what the same query means.
       */
      const sortRaw = url.searchParams.get("sort");
      if (sortRaw !== null && !isSearchSort(sortRaw)) {
        return json(
          { error: { code: "validation_failed", message: `sort must be one of ${SEARCH_SORTS.join(", ")}` } },
          400,
        );
      }

      const filters: SearchFilters = {};
      const folder = url.searchParams.get("folder");
      const sender = url.searchParams.get("sender");
      const dateFrom = url.searchParams.get("dateFrom");
      const dateTo = url.searchParams.get("dateTo");
      const unread = boolParam(url.searchParams.get("unread"));
      const hasAttachments = boolParam(url.searchParams.get("hasAttachments"));
      if (folder) filters.folder = folder;
      if (sender) filters.sender = sender;
      if (dateFrom) filters.dateFrom = dateFrom;
      if (dateTo) filters.dateTo = dateTo;
      if (unread !== undefined) filters.unread = unread;
      if (hasAttachments !== undefined) filters.hasAttachments = hasAttachments;

      const opts: SearchOptions = {
        q,
        filters,
        ...(limit !== undefined ? { limit } : {}),
        ...(sortRaw !== null ? { sort: sortRaw } : {}),
      };
      const result = await searchService.search(ctx, opts);
      return json(result);
    },
  },
  {
    method: "GET",
    pattern: "/mailboxes",
    handler: async (_req, ctx) => json({ items: await mailboxService.list(ctx) }),
  },
  {
    method: "GET",
    pattern: "/tags",
    handler: async (_req, ctx) => json({ items: await tagsService.list(ctx) }),
  },
  {
    method: "GET",
    pattern: "/rules",
    handler: async (_req, ctx) => json({ items: await rulesService.list(ctx) }),
  },
  {
    method: "GET",
    pattern: "/rules/:id",
    handler: async (_req, ctx, params) => json(await rulesService.get(ctx, params.id!)),
  },
];

const segsOf = (p: string): string[] => p.split("/").filter((s) => s.length > 0);

/** Percent-decode a segment without throwing (a malformed escape simply matches nothing). */
function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/**
 * Try one pattern against the path. Returns extracted params + a per-segment specificity vector
 * (1 = static literal, 0 = `:param`), or null. Copied — deliberately, not imported — from
 * `packages/api/src/router.ts`: importing it would drag `router.ts → deps.ts` into this module's
 * graph, and the whole point of this file is to reach nothing in `packages/api`.
 */
function tryMatch(patternSegs: string[], pathSegs: string[]): { params: Record<string, string>; spec: number[] } | null {
  if (patternSegs.length !== pathSegs.length) return null;
  const params: Record<string, string> = {};
  const spec: number[] = [];
  for (let i = 0; i < patternSegs.length; i++) {
    const ps = patternSegs[i]!;
    const val = pathSegs[i]!;
    if (ps.startsWith(":")) {
      params[ps.slice(1)] = safeDecode(val);
      spec.push(0);
    } else if (ps === val) {
      spec.push(1);
    } else {
      return null;
    }
  }
  return { params, spec };
}

/** Lexicographic compare: > 0 iff `a` is strictly more specific than `b` (static beats param). */
function cmpSpec(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

/**
 * Resolve a method + path to the single most-specific READ route, or null when nothing matches —
 * which is the signal to forward the request to Cloud. Only exact method matches are considered;
 * this table is GET-only, so a mutation never resolves here and is always forwarded.
 */
export function matchReadRoute(
  method: string,
  pathname: string,
): { route: ReadRoute; params: Record<string, string> } | null {
  const pathSegs = segsOf(pathname);
  const wanted = method.toUpperCase();
  let best: { route: ReadRoute; params: Record<string, string>; spec: number[] } | null = null;
  for (const route of READ_ROUTES) {
    if (route.method.toUpperCase() !== wanted) continue;
    const m = tryMatch(segsOf(route.pattern), pathSegs);
    if (!m) continue;
    if (!best || cmpSpec(m.spec, best.spec) > 0) best = { route, params: m.params, spec: m.spec };
  }
  return best ? { route: best.route, params: best.params } : null;
}
