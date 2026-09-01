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
  ...consentRoutes,
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
