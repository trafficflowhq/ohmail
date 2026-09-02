import type { Route } from "../router.js";
import { syncRoutes } from "./sync.js";
import { eventsRoutes } from "./events.js";
import { pushRoutes } from "./push.js";
import { mailboxRoutes } from "./mailboxes.js";
import { rulesRoutes } from "./rules.js";
import { messageRoutes } from "./messages.js";
import { threadRoutes } from "./threads.js";
import { screenerRoutes } from "./screener.js";
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
 * THE MAIL-ONLY ROUTE TABLE — what a single-user engine on the user's own machine serves.
 *
 * A SEPARATE ARRAY rather than a filter over {@link apiRoutes}, and the difference matters: a
 * filter would still `import` every route module to build the list it then discards, so the
 * artifact would carry the billing handler, the Stripe webhook and the cross-account admin reads
 * whether or not anything could route to them. Only a distinct import list actually leaves them
 * out of the module graph. `routes/index.ts` is untouched and still owns the hosted table.
 *
 * ── WHAT IS ABSENT, AND WHY EACH ONE ──────────────────────────────────────────────────────
 *
 *  · the 20 AUTH routes — registration, password login, WebAuthn, TOTP, recovery, OAuth, devices.
 *    There is nobody to register: the engine mints one session per launch for the shell that
 *    spawned it, and the machine's own login is the boundary. The routes are not merely
 *    unreachable, they are not built.
 *  · `billing`, `waitlist` — Cloud is what you pay for and there is no funnel to join on a laptop.
 *  · `account` — Art. 17 erasure is a hosted-account operation. Here, deleting the data directory
 *    IS the erasure, and it takes nothing from the mailbox on the user's own server.
 *  · `ai-settings` — the managed-AI off switch governs OUR spend on OUR models. Desktop is BYO.
 *  · `internal`, `admin` — an operator surface on one person's machine is only attack surface.
 *
 * ── AND ONE THAT LOOKS ABSENT AND IS NOT: `screening` ───────────────────────────────────────
 *
 * `screeningRoutes` serves `GET/PATCH /account/screening` and IS mounted here, one line below the
 * Screener it configures. It shares a path prefix with the `account` module above and shares
 * nothing else: that module is erasure, this one is two columns on `account_settings` — the Ohbox
 * posture and the mailbox owner's own words, the BAR. Both columns are mail-half (`mail 0042`), so every
 * standalone install already has them, `getScreeningPreference` already reads them exactly as the
 * hosted service does, and the bar already reaches the model in the user turn of the screening
 * question. What was missing was the ability to WRITE one: the words were readable-and-unwritable
 * on the one tier whose owner supplies the model that reads them.
 *
 * Its PATCH is `cost: "work"`, which classifies nothing here — the spend gate is a hosted concern
 * and this host runs no gate — and is kept because `cost` is a property of the handler, not of the
 * table it is mounted in. Cloud-mode desktop is untouched: that engine mounts `cloud-read.ts` plus
 * a write-through proxy and never this array, so a mirrored account still reads and writes its
 * preference on the hosted account, where `account_settings` actually lives.
 *
 * `events` STAYS despite SSE being disabled in this host. Disabled, `GET /events` answers a
 * finite 503 that the client adapter already tolerates as "no wake signal, keep polling `/sync`".
 * Dropping the module would answer 404 instead, which is a different contract for no gain.
 */
/**
 * THE CONSENT GROUP WITH THE FOLDERS FLAG TAKEN OUT — for every door built from this table.
 *
 * That is the STANDALONE door and the SELF-HOST one, because `selfHostRoutes` spreads
 * `localRoutes` whole (which is why `consentRoutes` was removed from its own list as a double
 * mount). Both are correct to strip, and for one reason: `foldersRoutes` is spread at
 * `routes/index.ts` and NOWHERE else, so the four verbs exist on the HOSTED table alone. Neither
 * door built from this one can serve them, so on neither may the flag be raised.
 *
 * ── WHY THIS EXISTS, AND WHAT mail 0083 BROKE ON ITS WAY PAST ──────────────────────────────
 *
 * The sidecar's client-route coverage census exempts four `/folders` verbs from the LOCAL
 * census, and the exemption is DERIVED rather than declared: it re-measures a chain and hands back
 * nothing when any link stops holding. Link four was *"the standalone engine cannot answer
 * `GET /consent`"* — the read whose answer is the only thing that can raise `foldersEnabled` off
 * its resting `false`.
 *
 * Mounting `consentRoutes` here (the screening window, above) broke that link on purpose and did
 * not notice this one. It is not theoretical: `apps/desktop/src/local-consent.ts` composes
 * `PATCH /consent/settings { foldersEnabled }`, so a standalone user could switch folders ON, the
 * rail would mount, and all four verbs would answer 404 — this table serves NO folder route at
 * all, not even the summary.
 *
 * ── WHY THE FLAG AND NOT THE VERBS ────────────────────────────────────────────────────────
 *
 * Serving the four verbs is the other repair and it is a FEATURE, not a fix: the standalone engine
 * owns the IMAP connection, so folder create/rename/delete there is real work with real failure
 * modes, and mounting the routes without it would be a larger lie than the one being closed. The
 * rule this codebase already keeps is the smaller one — a control wired to nothing is worse than
 * an absent one — so the flag is withheld until the verbs exist.
 *
 * ── WHY AT THE ROUTE AND NOT IN THE WINDOW ────────────────────────────────────────────────
 *
 * Gating the desktop's toggle would work today and is a check somebody can forget. Here it is
 * structural: on this table the field cannot be written and cannot be read as anything but off, so
 * no client — this one, a future one, or a hand-made request with the launch bearer — can raise it.
 * That is also what re-licenses the census exemption, on a link that is true again.
 *
 * The HOSTED table is untouched: it spreads `consentRoutes` directly (`routes/index.ts`) and it is
 * the table that actually serves the verbs, so the flag means something there.
 *
 * READ AND WRITE BOTH, because either alone is a half-truth: a GET that reported `on` over a PATCH
 * that refused would show a rail the server had just declined to enable.
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
  ...screeningRoutes,
  /* -- THE SCREENING WINDOW REACHES THE FREE DESKTOP (mail 0083) --------------------------
   *
   * `consentRoutes` was mounted by `selfHostRoutes` and by the hosted table, and NOT here — so
   * the standalone install, which is the funnel and the tier most people meet first, had:
   *
   *  · no `GET /consent`, so no way to READ `dormancy_days`, `screening_scope` or
   *    `screening_baseline_at`;
   *  · no `PATCH /consent/settings`, so no way to WRITE any of them;
   *  · and therefore no window at all — `apps/sidecar/src/engine.ts` had zero occurrences of
   *    `screeningCutoff`, so its cycle screened EVERY backfilled message regardless of age. A
   *    person with a decade of mail got a decade of it in `ohmail/Screener`, one physical IMAP
   *    move at a time, and there was nowhere in the product to say otherwise.
   *
   * Mounting it here is half the fix; the other half is `engine.ts` threading the resolved cutoff
   * into its `runSyncCycle` deps exactly as the hosted `index.ts#screeningFor` does. Both are in
   * this commit, because either alone is a surface that does nothing (the mount without the
   * thread is a dial that stores a value nothing reads).
   *
   * `POST /consent/reset` and `/consent/seed` come with it, which is correct rather than
   * incidental: they are the same account state, they are already reachable on every other door,
   * and a standalone user who can choose a window can also re-run the seed review and clear
   * screening state. The routes are account-scoped and this host serves exactly one account.
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
