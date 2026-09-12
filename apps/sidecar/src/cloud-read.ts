import { and, eq, inArray } from "drizzle-orm";
import { messageBodies, messages } from "@trafficflow/db/mail";
import {
  messageService, threadService, searchService, mailboxService, tagsService, rulesService,
  syncService, SEARCH_SORTS, isSearchSort, ServiceError,
  ADDRESS_DIRECTIONS, isAddressSearchDirection,
  type AddressSearchOptions,
  type SearchFilters, type SearchOptions, type ServiceContext,
} from "@trafficflow/services/mail";

/**
 * The Cloud-mode local read surface — the full mail READ routes, served from the mirror in PGlite.
 * Not `packages/api`'s `localRoutes`: those import `deps.ts` (the IMAP admission port) and reach the
 * adapter, which would put the organizer's machinery back in the graph `cloud-engine-census.test.ts`
 * forbids. So this is a curated GET-only table reaching only the census-clean read services. And only
 * reads the mirror can answer truthfully: a read whose QUESTION is about what the mirror does NOT
 * hold must forward — `GET /messages` (the reach-past list) is absent on purpose, and
 * `/messages/:id/body` falls through for a reach-past row. A mirrored MESSAGE is not a mirrored BODY:
 * bodies fill in a second pass, so an absent body row means "not copied yet", not empty ({@link mirroredBodyIds}).
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
 * Which of these messages this mirror actually holds a body for — the fact the body routes were
 * answering without. A row's PRESENCE is the whole signal, its contents deliberately not consulted:
 * a withheld body (`storage_cap`, `junk_filed`, `expunged`) is a real row carrying its marker, and
 * an ordinarily empty message is a real row too — both settled answers the mirror genuinely holds.
 * What must not be served is the case with NO row, which in a mirror means the copy has not arrived.
 * Scoped through `messages.account_id` for `MessageService.getBody`'s reason: `message_bodies` has no
 * account column, so the join IS the authorization, and this question must not become a way to learn
 * that somebody else's message exists.
 */
/**
 * Both questions under one snapshot — presence and content, or the fix reintroduces the defect.
 * `MessageService.getBodies` reads inside its own `repeatable read` transaction, so asking it for
 * bodies and then asking THIS database which ids have a row are two snapshots with a gap — and the
 * mirror's backfill runs in this same process and fills that gap: a body absent when `getBodies`
 * read it (so the wire item carries the left join's `text: ""`) and present when the presence query
 * ran (so the id is admitted) would be answered as an ordinary empty body and cached as settled,
 * the very failure this file prevents in a narrower window. One transaction, `read only` at the same
 * isolation, so the two answers describe one instant.
 */
async function inSnapshot<T>(ctx: ServiceContext, fn: (snap: ServiceContext) => Promise<T>): Promise<T> {
  const tx = ctx.db as unknown as {
    transaction<R>(
      run: (t: ServiceContext["db"]) => Promise<R>,
      opts: { isolationLevel: "repeatable read"; accessMode: "read only" },
    ): Promise<R>;
  };
  return tx.transaction(
    async (t) => fn({ ...ctx, db: t }),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

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
   * The cold-start read, and the one route where forwarding is wrong rather than slow.
   * `GET /sync/snapshot` answers the account's current state newest-first plus `asOfSeq`, which the
   * client commits as its `/sync` cursor. Two unrelated sequences exist in a mirrored install — the
   * hosted account's (the mirror's pull is counted in it) and this database's local `change_log`
   * (what `GET /sync` is answered from) — so forwarding returns a cursor in the first to a client
   * whose next request is answered in the second: the mailbox bootstraps once, looks complete, and
   * never receives another change. It was forwarded, so a cold start filled OLDEST first; serving it
   * here from `syncService` (a read service already in the graph) is what let newest-first come back.
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
  /* `GET /messages` (the LIST route) is deliberately NOT in this table, and its absence is the
   * folder-contents fix, recorded here rather than re-derived. The JS client calls it for one thing:
   * the reach-past door (`HttpAdapter.listMessages`, "one keyset page oldest-ward"), which by
   * definition asks for mail BEYOND what the local store kept. The mirror is a window over the hosted
   * account, so serving it from the mirror re-serves rows the client already renders and then says
   * `nextCursor: null` about a mailbox whose older mail is all hosted — worse for folders, where the
   * handler predated `view=folder` and answered `400 view=folder requires folderId`. So the list ask
   * falls through to the write-through proxy and the hosted account answers it (ids are verbatim, so
   * rows compose with the client's mirror-preferred merge); offline it is `503 offline_read_only`. */
  /**
   * The batch body read — and it has TWO modes, which this door used to collapse into one.
   * `MessageService.getBodies` selects its mode from `ids`: with ids it answers those, without them
   * it keyset-pages the account. This handler read only `after`/`limit`, so `ids` was dropped and
   * every `?ids=` ask (what `HttpAdapter.fetchBodies` sends) was answered as the KEYSET WALK — a page
   * from the account's beginning, about other messages; the client matched by `messageId`, found
   * none, and fell back to per-message. The ids mode also OMITS what the mirror has no body for (a
   * body not copied yet drops out and the next ask forwards); answering `text: ""` would be the
   * fabrication cached as settled. The KEYSET mode is left as it was — a walk over what this database holds.
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
        const items = await inSnapshot(ctx, async (snap) => {
          const page = await messageService.getBodies(snap, { ids });
          const held = await mirroredBodyIds(snap, page.items.map((i) => i.messageId));
          return page.items.filter((i) => held.has(i.messageId));
        });
        return json({ items, nextCursor: null });
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
   * One body — from the mirror when the mirror has it, and NOT INVENTED when it does not. The
   * `not_found` routes this to the hosted account: `cloud-engine.ts` already forwards this route on
   * this code for the reach-past row whose MESSAGE the mirror never held, and a mirrored message
   * whose BODY has not been copied yet is the same question ("can the mirror answer truthfully?"),
   * so it takes the same signal. The cost is one forwarded round trip per body opened ahead of the
   * walk; the walk keeps filling behind it and later opens are local. Offline the proxy answers
   * `503 offline_read_only`, which the pane renders as "couldn't load the full message" with Retry —
   * a stated failure, not a blank message that looks like mail with nothing in it.
   */
  {
    method: "GET",
    pattern: "/messages/:id/body",
    handler: async (_req, ctx, params) => {
      const id = params.id!;
      return json(await inSnapshot(ctx, async (snap) => {
        if (!(await mirroredBodyIds(snap, [id])).has(id)) {
          throw new ServiceError("not_found", 404, "message not found");
        }
        return messageService.getBody(snap, id);
      }));
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

      /**
       * `?address=` — the same arm `packages/api/src/routes/search.ts` grew, repeated here for the
       * reason the `sort` refusal below is: this door cannot import that route table, so the two are
       * held together by shape. The cost of NOT repeating it is the defect that comment names:
       * `address` would fall through to the text search with `q: ""`, which `SearchService.search`
       * answers with `emptyResult()` — so the desktop's address view would show an empty archive for
       * a person it holds mail from, with a 200 and nothing to say why, while the web client showed
       * the rows. A door that accepts a parameter and ignores it is worse than one that refuses it.
       */
      const address = url.searchParams.get("address");
      if (address !== null) {
        const directionRaw = url.searchParams.get("direction");
        if (!isAddressSearchDirection(directionRaw)) {
          return json(
            { error: { code: "validation_failed", message: `direction must be one of ${ADDRESS_DIRECTIONS.join(", ")}` } },
            400,
          );
        }
        const addrLimit = num(url.searchParams.get("limit"));
        // The unsupported-direction refusal is the SERVICE's and is not re-spelled here: it
        // throws a `ServiceError` and `cloud-engine.ts`'s dispatch answers its own status and
        // code, so both doors refuse `to` with the same sentence.
        const addrOpts: AddressSearchOptions = {
          address,
          direction: directionRaw,
          ...(addrLimit !== undefined ? { limit: addrLimit } : {}),
        };
        return json(await searchService.searchByAddress(ctx, addrOpts));
      }

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
