import type { Route } from "../router.js";
import { syncRoutes } from "./sync.js";
import { eventsRoutes } from "./events.js";
import { pushRoutes } from "./push.js";
import { mailboxRoutes } from "./mailboxes.js";
import { rulesRoutes } from "./rules.js";
import { messageRoutes } from "./messages.js";
import { threadRoutes } from "./threads.js";
import { screenerRoutes } from "./screener.js";
import { trashRoutes } from "./trash.js";
import { screeningRoutes } from "./screening.js";
// Mail 0083. See the mount below: THE STANDALONE DOOR HAD NO SCREENING WINDOW AT ALL.
import { consentRoutes } from "./consent.js";
import { approvalRoutes } from "./approvals.js";
import { triageRoutes } from "./triage.js";
import { searchRoutes } from "./search.js";
import { privacyRoutes } from "./privacy.js";
import { unsubscribeRoutes } from "./unsubscribe.js";
import { contactsRoutes } from "./contacts.js";
import { snippetsRoutes } from "./snippets.js";
import { notifyRoutes } from "./notify.js";
import { awayRoutes } from "./away.js";
import { attachmentRoutes } from "./attachments.js";
import { kbRoutes } from "./kb.js";
import { tagsRoutes } from "./tags.js";
import { draftsRoutes } from "./drafts.js";
import { workflowsRoutes } from "./workflows.js";
import { healthRoutes } from "./health.js";
// `GET /hello` — server identity + capability negotiation, mounted in EVERY composition so a
// client never has to learn what a server is by probing routes that exist on one table and not
// another. This host answers `flavor: "local"` from the descriptor its composition root injects.
import { helloRoutes } from "./hello.js";

/**
 * The mail-only route table — what a single-user engine serves. A separate array, not a filter
 * over {@link apiRoutes}: a filter still imports every route module into the artifact. Absent:
 * the auth routes (the engine mints one session per launch; the machine's login is the boundary);
 * `billing`/`waitlist`; `account` (deleting the data directory IS the erasure); `ai-settings`
 * (desktop is BYO); `internal`/`admin` (attack surface on one person's machine). `screening`
 * looks absent and is not: `GET/PATCH /account/screening` is mounted here. `events` stays despite
 * SSE off: a finite 503 the adapter tolerates; dropping the module would answer 404 — a different
 * contract for no gain.
 */
/**
 * The consent group with the folders flag taken out — for both doors built from this table.
 * `foldersRoutes` is spread at `routes/index.ts` and nowhere else, so the verbs exist on the
 * hosted table alone; on neither door here may the flag be raised — `local-consent.ts` composes
 * `PATCH /consent/settings { foldersEnabled }`, so a standalone user could switch folders on and
 * meet four 404s. The flag and not the verbs: serving them is a feature (the standalone engine
 * owns the IMAP connection), and a control wired to nothing is worse than an absent one. At the
 * route, not in the window: the field cannot be written and cannot read as anything but off, for
 * any client. Read and write both: either alone is a half-truth.
 */
function withoutFoldersFlag(routes: Route[]): Route[] {
  return routes.map((r) => {
    const isSettings = r.method === "PATCH" && r.pattern === "/consent/settings";
    const isRead = r.method === "GET" && r.pattern === "/consent";
    if (!isSettings && !isRead) return r;
    return {
      ...r,
      handler: async (req, deps, params) => {
        if (isSettings) {
          /* The body is read ONCE by the wrapped handler, so the field is removed by handing it a
             request whose body no longer carries it rather than by reading it here first — a
             second `readBody` on the same request would consume the stream the handler needs.
             An absent field is "untouched", which is exactly the semantics `applyConsentSettings`
             already gives it; a PRESENT `foldersEnabled` is dropped silently rather than refused,
             because a 400 would be a worse answer to a client asking for a feature this door does
             not have — and no shipped client asks for it on this door except through a toggle that
             is going away. */
          const body = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;
          if ("foldersEnabled" in body) {
            const { foldersEnabled: _dropped, ...rest } = body;
            const stripped = new Request(req.url, {
              method: req.method,
              headers: req.headers,
              body: JSON.stringify(rest),
            });
            return r.handler(stripped, deps, params);
          }
          return r.handler(req, deps, params);
        }
        /* THE READ. `foldersEnabledAt` is forced to null so the flag reads OFF whatever the row
           holds — a row written on another door before this install was pointed at the database,
           or by a build that predates this wrapper. */
        const res = await r.handler(req, deps, params);
        if (res.status !== 200) return res;
        const wire = (await res.clone().json().catch(() => null)) as Record<string, unknown> | null;
        if (wire === null || !("foldersEnabledAt" in wire)) return res;
        return new Response(JSON.stringify({ ...wire, foldersEnabledAt: null }), {
          status: res.status,
          headers: res.headers,
        });
      },
    };
  });
}

export const localRoutes: Route[] = [
  ...healthRoutes,
  ...helloRoutes,
  ...syncRoutes,
  ...eventsRoutes,
  ...pushRoutes,
  ...mailboxRoutes,
  ...rulesRoutes,
  ...messageRoutes,
  ...threadRoutes,
  ...screenerRoutes,
  ...trashRoutes,
  ...screeningRoutes,
  /**
   * The screening window reaches the free desktop (mail 0083). `consentRoutes` was mounted by
   * `selfHostRoutes` and the hosted table, not here — so the standalone install had no `GET
   * /consent`, no `PATCH /consent/settings`, and no window at all: the engine's cycle screened
   * every backfilled message regardless of age — a decade of mail into `ohmail/Screener`, one
   * physical move at a time. Mounting it here is half the fix; the other half is `engine.ts`
   * threading the resolved cutoff into its cycle deps, and both land together. `POST
   * /consent/reset` and `/seed` come with it, correctly: the same account state, and this host
   * serves exactly one account.
   */
  ...withoutFoldersFlag(consentRoutes),
  ...approvalRoutes,
  ...triageRoutes,
  ...searchRoutes,
  ...privacyRoutes,
  ...unsubscribeRoutes,
  ...contactsRoutes,
  ...snippetsRoutes,
  ...notifyRoutes,
  ...awayRoutes,
  ...attachmentRoutes,
  ...kbRoutes,
  ...tagsRoutes,
  ...draftsRoutes,
  ...workflowsRoutes,
];
