import {
  messageService, threadService, searchService, mailboxService, tagsService, rulesService,
  syncService, type SearchFilters, type ServiceContext,
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
  {
    method: "GET",
    pattern: "/messages",
    handler: async (req, ctx) => {
      const url = new URL(req.url);
      const view = url.searchParams.get("view") ?? "";
      const cursor = url.searchParams.get("cursor");
      const limit = num(url.searchParams.get("limit"));
      const page = await messageService.list(ctx, {
        view,
        ...(cursor ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return json({ items: page.items, nextCursor: page.nextCursor });
    },
  },
  {
    method: "GET",
    pattern: "/messages/bodies",
    handler: async (req, ctx) => {
      const url = new URL(req.url);
      const after = url.searchParams.get("after");
      const limit = num(url.searchParams.get("limit"));
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
  {
    method: "GET",
    pattern: "/messages/:id/body",
    handler: async (_req, ctx, params) => json(await messageService.getBody(ctx, params.id!)),
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

      const result = await searchService.search(ctx, {
        q,
        filters,
        ...(limit !== undefined ? { limit } : {}),
      });
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
