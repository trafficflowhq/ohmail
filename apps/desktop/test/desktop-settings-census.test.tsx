/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate } from "../src/DesktopGate.js";
import { ACCOUNT_AI_PATH } from "../src/DesktopAiAccount.js";
import { MANAGE_LINK_PATH } from "../src/DesktopSubscription.js";
import { desktopPaneLabel } from "../src/DesktopSettings.js";
import messages from "../../webapp/messages/en.json";
import { PANE_IDS, type PaneId } from "../../webapp/app/shell/routing";
import type { EngineStatus } from "../src/bridge-fetch.js";

/**
 * ═══ THE SETTINGS CENSUS — EVERY PANE, EVERY DOOR, WITH A REASON ═══════════════════════════
 *
 * ── WHAT WAS WRONG, AND WHY NO EXISTING GUARD SAW IT ────────────────────────────────────────
 *
 * An install signed in to a hosted account was missing six Settings panes and three Screener
 * controls, and the cause was one stale field. Every account-shaped surface on the cloud door was
 * gated on `status.credentialState === "ready"`. That value is the engine's LAUNCH frame — the
 * protocol says so in as many words, *"the value AT LAUNCH … never updated in place"* — and the
 * shell re-emits it from the one `ready` frame on every status read. An install that started
 * pre-auth and signed in through the window's own sign-in surface therefore ran the whole session
 * reported as signed OUT: the mail arrived, the mirror pulled, and the away responder, signatures,
 * folders, subscription, security and account panes were simply absent, with the Desktop pane
 * telling the person they were "Signed out" beside a mailbox that was filling.
 *
 * The pane-parity guard that already existed could not see it — the web shell's own guard that
 * every settings section reaches the door it belongs to. It asserts that `DesktopGate` HANDS IN
 * each section, over hand-built prop sets. Every one of those assertions was true. What was false
 * was the CONDITION in front of them, and a condition is only visible from a rendered window.
 *
 * ── SO THIS FILE RENDERS THE REAL GATE ──────────────────────────────────────────────────────
 *
 * `DesktopGate` is mounted over a stand-in shell, per door, and the Settings nav is read off the
 * DOM. Nothing here restates a prop list: the claim under test is what a person sees after the
 * window has routed itself, which is the level the defect lived at.
 *
 * TWO of the five doors are rendered — `desktopCloud` and `desktopStandalone`. The two WEB columns
 * are rulings: a browser tab's shell needs the Next runtime and a live api-client, neither of which
 * belongs in the desktop suite, and the parity file above already asserts the web's gated
 * expressions from source. What the web columns are here FOR is the comparison: a cell that is
 * present on the web and absent on the connected desktop has to carry a reason, or it is the defect
 * this file exists to stop.
 *
 * `desktopSelfHost` is a ruling for a different reason, and the reason is itself a finding: the
 * window CANNOT TELL that door from `desktopCloud`. Both are `{ mode: "cloud" }`, `status` carries
 * no field naming the configured server, and the ready frame's `baseUrl` is the local bridge. So
 * the column cannot be rendered, and its `inert` cells are what that costs.
 *
 * ── THE TABLE IS THE POINT ──────────────────────────────────────────────────────────────────
 *
 * Every id in `PANE_IDS` × every door carries a state and a sentence. The key set is asserted
 * against `PANE_IDS` itself, so a new pane fails this file until somebody has decided what each
 * door does about it — the failure is a question, not a chore. And `inert` is a real state,
 * distinct from `present`: a pane that renders over a route table that cannot store what it
 * writes is not a pass, and recording it as one is how it would stay.
 *
 * ── HOW TO WATCH IT FAIL ────────────────────────────────────────────────────────────────────
 *
 * Every mutation below was run against the implementation and restored:
 *
 *  · put `status.credentialState === "ready"` back into `accountDoorFor` → the cloud door's
 *    signed-in-after-launch case loses six panes and goes red;
 *  · the same in `awayDoorFor` → the away responder alone goes;
 *  · drop the `accountDoor` arm from `devicesSection` in `DesktopGate` → the RENDERED cloud-door
 *    cases go red, because the nav loses Devices. Attributed here to the wrong case for one
 *    round: the "no pane the managed web draws is absent on the connected desktop" case reads
 *    only the table and can never see a change to `DesktopGate`, so nothing it does could have
 *    been moved by that mutation. A mutation credited to a case it cannot reach is the same
 *    defect as a guard that cannot fail — it is just harder to spot, because something DID go
 *    red;
 *  · flip `consentOverBridgeStandalone.foldersStorable` to true → the standalone door grows the
 *    Folders pane it cannot store and goes red;
 *  · drop `!consent.foldersStorable` from `AppShell`'s `foldersSection` gate → the same;
 *  · delete one door's cell from one pane → the completeness case names the pane. That guard
 *    exists because `Record<Door, Cell>` is NOT checked here: `apps/desktop`'s typecheck covers
 *    `src` only, so a forgotten cell would read as `undefined` and be silently treated as drawn;
 *  · add a member to `DOORS` and to nothing else → the same case names every pane. This is the
 *    mutation the guard FAILED before the door list became a value, and the one worth keeping in
 *    front of whoever reads it: the earlier shape derived its list from the table it was checking,
 *    so a door forgotten everywhere was a door it had never heard of.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

/* ── THE TABLE ─────────────────────────────────────────────────────────────────────────────── */

/**
 * The five surfaces a settings pane can be asked about. They are doors and not builds: `managedWeb`
 * and `selfHostWeb` run the same bundle against different route tables, and the three desktop doors
 * run the same bundle against different engines.
 *
 * ── THE DESKTOP HAS THREE DOORS AND `mode` HAS TWO VALUES ───────────────────────────────────
 *
 * `desktopSelfHost` is the one a reader will not expect and the one this census exists to keep
 * visible: `configureSelfHostDoor` opens a server the person runs themselves as
 * `{ mode: "cloud", cloudUrl: <their origin> }`, so every door rule that asks `mode === "cloud"`
 * answers the same for it as for an install connected to the managed service — while the route
 * table behind it is `selfHostRoutes`, which is a different table. Anything true of `desktopCloud`
 * because of what the MANAGED API mounts has to be asked again here, and a four-door table would
 * have let that question go unasked.
 *
 * This column is a ruling and not a render: the two are indistinguishable to `DesktopGate` today
 * (`status` carries no field naming the configured server, and the ready frame's `baseUrl` is the
 * local bridge), which is the finding rather than a limitation of the harness.
 *
 * ── AND THE LIST IS A VALUE, WITH THE TYPE DERIVED FROM IT ─────────────────────────────────
 *
 * It was a bare union, and the completeness check below read its door list off `MATRIX.general` —
 * a guard that cannot fail in the case its own docstring named. Add a door to the union and forget
 * it in EVERY row, and the derived list is the old five, every row agrees with `general`, and the
 * file is green over a `Door` the table does not answer. It was proved by adding a sixth member
 * and nothing else. Derived this way the union cannot gain a member without the list gaining one,
 * and the list is what every row is checked against.
 */
const DOORS = [
  "managedWeb", "selfHostWeb", "desktopCloud", "desktopSelfHost", "desktopStandalone",
] as const;
type Door = (typeof DOORS)[number];

/**
 *  · `present` — the pane renders and its controls reach something that stores what they write.
 *  · `absent`  — it does not render, and `why` says what is missing rather than that it is missing.
 *  · `inert`   — it renders and its controls CANNOT DO WHAT THEY SAY: a switch whose write the
 *                route table drops, a read the server does not serve, a door out to a service
 *                this install has no account on. Never an acceptable resting state: every `inert`
 *                cell has to name the SIGNAL that would let the surface withhold it honestly,
 *                which is what turns the word from a shrug into a piece of work. Recorded as its
 *                own state because folding it into `present` is how a dead control survives a
 *                census — and the word covers "cannot act", not only "cannot store", because the
 *                self-host doors turned out to hold both kinds.
 */
interface Cell {
  state: "present" | "absent" | "inert";
  why: string;
}

const MATRIX: Record<PaneId, Record<Door, Cell>> = {
  general: {
    managedWeb: { state: "present", why: "drawn by the shared view for every host" },
    selfHostWeb: { state: "present", why: "drawn by the shared view for every host" },
    desktopCloud: { state: "present", why: "drawn by the shared view for every host" },
    desktopSelfHost: { state: "present", why: "drawn by the shared view for every host" },
    desktopStandalone: { state: "present", why: "drawn by the shared view for every host" },
  },
  notifications: {
    managedWeb: { state: "present", why: "drawn by the shared view for every host" },
    selfHostWeb: { state: "present", why: "drawn by the shared view for every host" },
    desktopCloud: {
      state: "present",
      why: "the OS answer comes from the shell (`notificationHost`), not from `Notification`",
    },
    desktopSelfHost: {
      state: "present",
      why: "the OS answer comes from the shell (`notificationHost`), not from `Notification`",
    },
    desktopStandalone: { state: "present", why: "same host-supplied OS answer as the cloud door" },
  },
  mailboxes: {
    managedWeb: { state: "present", why: "`MailboxSection` over `GET /mailboxes`" },
    selfHostWeb: { state: "present", why: "`MailboxSection` against the server the tab is on" },
    desktopCloud: {
      state: "present",
      why: "`DesktopMailboxes` over the bridge; the account's own list, forwarded",
    },
    desktopSelfHost: {
      state: "present",
      why: "`DesktopMailboxes` over the bridge; the account's own list, forwarded",
    },
    desktopStandalone: {
      state: "present",
      why: "`DesktopMailboxes` names its mode — the mailboxes this computer opens",
    },
  },
  screener: {
    managedWeb: { state: "present", why: "posture, dormancy, auto-suggest, auto-unsubscribe, seed" },
    selfHostWeb: { state: "present", why: "same four controls; the seed review needs the web client" },
    desktopCloud: {
      state: "present",
      why:
        "`DesktopScreening` plus the three the shell builds over `consentTransport` and " +
        "`suggestWire`. The sent-mail seed review is the one row absent: `SeedReviewView` calls " +
        "`app/api-client` directly and no injected wire substitutes for it",
    },
    desktopSelfHost: {
      state: "present",
      why:
        "`DesktopScreening` plus the three the shell builds over `consentTransport` and " +
        "`suggestWire`. The sent-mail seed review is the one row absent: `SeedReviewView` calls " +
        "`app/api-client` directly and no injected wire substitutes for it",
    },
    desktopStandalone: {
      state: "present",
      why:
        "posture and the dormancy dial over the standalone consent row. Auto-suggest and " +
        "auto-unsubscribe stay out: no ledger to price a batch against, and the standalone " +
        "screener wires no unsubscribe service at all",
    },
  },
  away: {
    managedWeb: { state: "present", why: "the hosted pass sends from the account's row" },
    selfHostWeb: { state: "present", why: "`apps/server`'s send clock runs the same pass" },
    desktopCloud: {
      state: "present",
      why: "`awayOverBridge`; the engine forwards the route to the account with the bearer",
    },
    desktopSelfHost: {
      state: "present",
      why: "`awayOverBridge`; the engine forwards the route to the account with the bearer",
    },
    desktopStandalone: {
      state: "present",
      why:
        "the pass lives in the engine's own bundle and the sidecar drain sends through this " +
        "machine's SMTP; the pane says replies go out while the window is open",
    },
  },
  /**
   * THE ACCOUNT'S AI SWITCH. Present on every door that HAS an account, and that is the whole
   * shape of it: `GET/PATCH /account/ai` is mounted by the managed table AND by
   * `selfHostRoutes` (the operator supplies the key and pays the model bill, so the switch is
   * more meaningful there, not less). The standalone door has no account; its local-model form
   * lives on the Desktop pane instead, which is a different setting.
   */
  ai: {
    managedWeb: { state: "present", why: "`AiSection` over the two routes on the hosted table" },
    selfHostWeb: {
      state: "present",
      why:
        "the same pane over the same two routes — `selfHostRoutes` mounts `aiSettingsRoutes`, so "
        + "this is one of the panes that is NOT a managed-client leftover here",
    },
    desktopCloud: {
      state: "present",
      why: "`DesktopAiAccount` over the forwarded `/account/ai`; a write, not a door out",
    },
    desktopSelfHost: {
      state: "present",
      why: "the same forwarded routes; this door's server mounts them for the same reason the tab's does",
    },
    desktopStandalone: {
      state: "absent",
      why:
        "no account to hold the flag. The local model is configured on the Desktop pane through "
        + "`/local/ai`, which is a provider key rather than an account setting",
    },
  },
  billing: {
    managedWeb: {
      state: "present",
      why:
        "one row linking to the page the service operator serves, from the URL " +
        "`POST /account/manage-link` answers. The pane holds nothing else: no plan, no balance " +
        "and no payment method are this program's to state",
    },
    selfHostWeb: {
      state: "absent",
      why:
        "no manage page is served here, so the route answers 404, so the shell builds no node and " +
        "the nav grows no entry. ABSENT rather than inert, and that is the whole gain of the " +
        "change: the pane used to render plan cards offering a checkout that could not open, " +
        "because nothing told the client which server it was on. Now the answer to " +
        "`manage-link` IS that signal, and the surface withholds itself on it",
    },
    desktopCloud: {
      state: "present",
      why:
        "`DesktopSubscription` over the forwarded `POST /account/manage-link`; the click leaves " +
        "for the platform's browser through the interceptor every external link uses",
    },
    desktopSelfHost: {
      state: "absent",
      why:
        "the same 404 the browser tab gets, through the proxy. This door could never tell itself " +
        "from the managed one — `{ mode: \"cloud\" }` is both — and it no longer has to: the " +
        "route's own answer decides, so the previously inert pane is simply not drawn",
    },
    desktopStandalone: {
      state: "absent",
      why: "no account and no server to ask, so there is no page to link to and nothing to draw",
    },
  },
  invites: {
    managedWeb: {
      state: "absent",
      why:
        "the managed API mounts the pairing routes but wires no invite bridge, so both invite " +
        "arms refuse; the tab's `/hello` gate withholds the pane",
    },
    selfHostWeb: { state: "present", why: "the mint and the redeem are mounted on this composition alone" },
    desktopCloud: { state: "absent", why: "the desktop talks to the managed service, which mints no invite" },
    desktopSelfHost: {
      state: "absent",
      why:
        "the server behind this door DOES mint invites, and the window still wires no node — " +
        "the web shell's own parity guard asserts `DesktopGate` never names `invitesSection`, " +
        "because the gate cannot tell this door from the managed one. Absent and honest rather " +
        "than inert: nothing is drawn that could refuse",
    },
    desktopStandalone: { state: "absent", why: "no server behind this door to invite anybody onto" },
  },
  tags: {
    managedWeb: { state: "present", why: "drawn by the shared view; tag verbs are engine mutations" },
    selfHostWeb: { state: "present", why: "drawn by the shared view" },
    desktopCloud: { state: "present", why: "drawn by the shared view" },
    desktopSelfHost: { state: "present", why: "drawn by the shared view" },
    desktopStandalone: { state: "present", why: "drawn by the shared view" },
  },
  rules: {
    managedWeb: { state: "present", why: "`rule` is a `/sync` entity; both verbs are engine mutations" },
    selfHostWeb: { state: "present", why: "same mirror, same mutations" },
    desktopCloud: { state: "present", why: "same mirror, same mutations" },
    desktopSelfHost: { state: "present", why: "same mirror, same mutations" },
    desktopStandalone: { state: "present", why: "same mirror, same mutations" },
  },
  folders: {
    managedWeb: { state: "present", why: "`foldersRoutes` are mounted on the hosted table" },
    selfHostWeb: {
      state: "inert",
      why:
        "`selfHostRoutes` spreads `localRoutes` whole, so it inherits `withoutFoldersFlag` and " +
        "mounts no folder verb — the read forces the flag off and the write is dropped. The " +
        "browser's transport cannot interrogate its route table, so the honest signal is a " +
        "`/hello` feature word beside `pairing` — until there is one, a tab against a " +
        "self-hosted server draws a switch that snaps back",
    },
    desktopCloud: {
      state: "present",
      why: "`/folders*` is not served locally, so all four verbs reach the account through the proxy",
    },
    desktopSelfHost: {
      state: "inert",
      why:
        "the same wire as `desktopCloud` — the self-host door is `{ mode: \"cloud\" }` — pointed at " +
        "a server that mounts `selfHostRoutes` and therefore strips the flag. PRE-EXISTING rather " +
        "than introduced by the transport capability: this door drew the pane before the field " +
        "existed and draws it still. It is not closed by a `flavor` probe in the window, because " +
        "the honest signal is the same `/hello` feature word the self-hosted TAB needs — one " +
        "mechanism at the server for all three surfaces, rather than a probe that word deletes",
    },
    desktopStandalone: {
      state: "absent",
      why:
        "the standalone engine serves no folder verb, so its consent wire declares " +
        "`foldersStorable: false` and the shell withholds the pane. It used to draw one: a " +
        "master switch that flipped, stored nothing and snapped back",
    },
  },
  signatures: {
    managedWeb: { state: "present", why: "a `mailboxes` column written through `PATCH /consent/settings`" },
    selfHostWeb: { state: "present", why: "the consent group is mounted; signatures are not stripped" },
    desktopCloud: { state: "present", why: "the same route, forwarded to the account with the bearer" },
    desktopSelfHost: { state: "present", why: "the same route, forwarded to the account with the bearer" },
    desktopStandalone: {
      state: "present",
      why: "`consentRoutes` are on `localRoutes`, so the signature lands in this install's own row",
    },
  },
  about: {
    managedWeb: { state: "present", why: "which mailbox, synced when, which build, who publishes it" },
    selfHostWeb: { state: "present", why: "the same pane against this server" },
    desktopCloud: { state: "present", why: "`DesktopAbout` — the facts a desktop install has to answer" },
    desktopSelfHost: { state: "present", why: "`DesktopAbout` — the facts a desktop install has to answer" },
    desktopStandalone: {
      state: "present",
      why: "`DesktopAbout`; a standalone install is not the hosted service and says so",
    },
  },
  security: {
    managedWeb: { state: "present", why: "recovery codes and the authenticator, step-up gated in place" },
    selfHostWeb: { state: "present", why: "the same ceremony against this server" },
    desktopCloud: {
      state: "present",
      why:
        "`DesktopWebSection` — a door out. Every control behind it needs a second factor asserted " +
        "in the last few minutes and nothing this window can do asserts one",
    },
    /* THE DOOR OUT IS A CONSTANT IN THE SHELL'S TABLE, and the table names ohmail.app. On this
       door the person's account is on their OWN server, so the button opens a sign-in page for a
       service they are not a customer of. PRE-EXISTING and shared by every browser door-out here;
       recorded once with the family named rather than three times. */
    desktopSelfHost: {
      state: "inert",
      why:
        "`DesktopWebSection` opens `https://ohmail.app/…` from the shell's constant `LINKS` table, " +
        "because the window names a PLACE and never a URL — the safety rule that makes the table " +
        "possible is the same rule that makes it unable to name somebody's own server. The account " +
        "behind this door is on their origin, so the door goes to the wrong service. Closed by the " +
        "same thing the folders row asks for: the window knowing which server it is configured for",
    },
    desktopStandalone: { state: "absent", why: "no account, so no password and no second factor" },
  },
  account: {
    managedWeb: { state: "present", why: "the account details and the erase ceremony" },
    selfHostWeb: { state: "present", why: "the same pane against this server" },
    desktopCloud: { state: "present", why: "`DesktopWebSection` — a door out, for security's reason" },
    desktopSelfHost: {
      state: "inert",
      why:
        "the same door out to the same constant, for the reason the security row states in full — " +
        "closed by the window knowing which server it is configured for",
    },
    desktopStandalone: {
      state: "absent",
      why: "no account to act on, so nothing here to name, change or erase",
    },
  },
  desktop: {
    managedWeb: { state: "absent", why: "a browser tab has no native shell to ask" },
    selfHostWeb: { state: "absent", why: "a browser tab has no native shell to ask" },
    desktopCloud: { state: "present", why: "which door, which mailbox, the session, the sign-out" },
    desktopSelfHost: { state: "present", why: "which door, which mailbox, the session, the sign-out" },
    desktopStandalone: { state: "present", why: "the same pane, plus this install's own model settings" },
  },
  devices: {
    managedWeb: { state: "present", why: "the server-side mint, the session list and the revoke" },
    selfHostWeb: { state: "present", why: "the same ceremony; this composition mounts `/pair*` too" },
    desktopCloud: {
      state: "present",
      why:
        "`DesktopWebSection` — a door out to the account's own device list. `POST /pair` and " +
        "`DELETE /devices/:id` are step-up gated, so a form here would collect a password and be " +
        "refused; the absence that stood before this was worse, because it read as 'this product " +
        "does not have that'",
    },
    /* THE NEW PANE JOINS THE FAMILY IT WAS MODELLED ON, including here. It is worth stating
       plainly rather than leaving to the reader: adding this pane widened an existing wrong by
       one, and it was landed that way deliberately — three panes already open the same constant
       on this door, and singling out the fourth would have left the connected desktop without a
       device list to fix a defect none of the four causes. The whole family closes together. */
    desktopSelfHost: {
      state: "inert",
      why:
        "the same door out to the same constant, for the reason the security row states in full — " +
        "closed by the window knowing which server it is configured for",
    },
    desktopStandalone: {
      state: "present",
      why: "host mode — publishing the mailbox THIS computer opens to the person's own devices",
    },
  },
};

/* ── THE SHELL THE TWO DESKTOP DOORS ARE DRIVEN OVER ───────────────────────────────────────── */

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

const EMPTY_PAGE = JSON.stringify({
  changes: { creates: [], updates: [], moves: [], deletes: [] },
  cursor: "MA",
  hasMore: false,
  serverTime: "2026-01-01T00:00:00.000Z",
});
const EMPTY_SNAPSHOT = JSON.stringify({
  asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 },
});
const MAILBOXES = JSON.stringify({
  items: [{ id: "mbx-1", address: "someone@example.com", status: "connected", lastSyncAt: null }],
});
/**
 * A consent row as a HOSTED table answers it. The standalone engine answers the same shape with
 * `foldersEnabledAt` forced null — which is exactly why the folders capability cannot be read off
 * this body, and is declared by the transport instead.
 */
const CONSENT = JSON.stringify({
  seedConfirmedAt: "2026-01-01T00:00:00.000Z",
  screeningResetAt: null,
  dormancyDays: 90,
  screeningBaselineAt: null,
  autoSuggestAt: null,
  blockRemoteImagesAt: null,
  loadTrackingPixelsAt: null,
  blockAutoUnsubscribeAt: null,
  foldersEnabledAt: null,
  folderMailboxesOff: {},
  signatures: {},
  themeFace: null,
});
const AWAY = JSON.stringify({
  enabled: false, text: "", startsAt: null, endsAt: null,
  audience: "screened_in", throttle: "per_day",
});

/**
 * What `POST /account/manage-link` answers for the next mount: a URL, or `null` for the 404 a
 * deployment with no such page gives. Reassigned per case, never captured by the stub.
 */
let manageLink: string | null = "https://account.example/manage?t=abc";

/** `signedIn` is the LIVE answer the window routes off — see the header. */
function fakeShell(status: EngineStatus, signedIn: boolean): void {
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      if (command === "engine_status") return status;
      if (command === "mailto_claim") return null;
      if (command === "plugin:event|listen") return null;
      if (command === "engine_request") {
        const url = String(payload?.url ?? "");
        if (url === "/health") return encode(200, JSON.stringify({ signedIn }));
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        if (url.startsWith("/mailboxes")) return encode(200, MAILBOXES);
        if (url.startsWith("/consent")) return encode(200, CONSENT);
        if (url.startsWith("/away-responder")) return encode(200, AWAY);
        // The Subscription pane's one read. A URL here is the managed answer; `MANAGE_ABSENT`
        // below drives the other arm, where the pane draws nothing at all.
        // The AI pane's read. A boolean either way; the pane draws regardless, because the
        // account HAS the flag — only an unread value makes the switch unpressable.
        if (url === ACCOUNT_AI_PATH) return encode(200, JSON.stringify({ aiEnabled: true }));
        if (url === MANAGE_LINK_PATH) {
          return manageLink === null
            ? encode(404, JSON.stringify({ error: { code: "no_manage_surface" } }))
            : encode(200, JSON.stringify({ url: manageLink }));
        }
        return encode(200, EMPTY_PAGE);
      }
      return null;
    },
  };
}

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

async function settle(turns = 40): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
}

/** Mount the real gate at `#/settings` and hand back the pane names its nav drew. */
async function navFor(status: EngineStatus, signedIn: boolean): Promise<string[]> {
  fakeShell(status, signedIn);
  window.location.hash = "#/settings";
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(
      h(
        NextIntlClientProvider,
        { locale: "en", messages: messages as never, timeZone: "UTC" },
        h(ThemeProvider, { storageKey: "ohmail.theme" }, h(ToastHost, null, h(DesktopGate, null))),
      ),
    );
  });
  await settle();
  return [...mountPoint.querySelectorAll<HTMLElement>(".set-nav button")]
    .map((b) => (b.textContent ?? "").trim());
}

afterEach(async () => {
  manageLink = "https://account.example/manage?t=abc";
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
  window.location.hash = "";
});

/**
 * The nav LABEL each pane id draws, from the catalogue rather than typed out — a census that
 * hard-codes English is a census that fails on a copy edit and says nothing about a pane.
 */
const CATALOGUE = messages.settings as unknown as Record<string, unknown>;
const label = (pane: PaneId): string => {
  if (pane === "desktop") return desktopPaneLabel();
  if (pane === "folders") return (CATALOGUE.folders as { nav: string }).nav;
  if (pane === "signatures") return (CATALOGUE.signatures as { nav: string }).nav;
  return CATALOGUE[pane] as string;
};

/** The panes a door must draw — `present` and `inert` both render; only `absent` does not. */
const drawnOn = (door: Door): PaneId[] =>
  (PANE_IDS as readonly PaneId[]).filter((p) => MATRIX[p][door].state !== "absent");

const CLOUD_SERVING: EngineStatus = {
  state: "serving", mode: "cloud", address: "someone@ohmail.app",
  mailboxId: "mbx-1", credentialState: "ready",
} as EngineStatus;

/**
 * THE SAME INSTALL, ONE FIELD DIFFERENT — and the field is the one that was wrong. A window that
 * launched pre-auth carries `credentialState: "absent"` for the life of the process; a window
 * whose engine predates the field carries none at all. Both are signed in.
 */
const CLOUD_SIGNED_IN_AFTER_LAUNCH: EngineStatus = {
  state: "serving", mode: "cloud", address: "someone@ohmail.app",
  mailboxId: "mbx-1", credentialState: "absent",
} as EngineStatus;
const CLOUD_ENGINE_TOO_OLD: EngineStatus = {
  state: "serving", mode: "cloud", address: "someone@ohmail.app", mailboxId: "mbx-1",
} as EngineStatus;

const LOCAL_SERVING: EngineStatus = {
  state: "serving", mode: "local", address: "someone@example.com",
  mailboxId: "mbx-1", credentialState: "ready",
} as EngineStatus;

describe("SET-C — the census names every pane on every door", () => {
  it("the table's key set is exactly the panes a URL may name", () => {
    expect(
      Object.keys(MATRIX).sort(),
      "a settings pane exists with no census row. Decide, for each door in `DOORS`, whether it " +
        "is present, absent with a reason, or inert — and add the row.",
    ).toEqual([...PANE_IDS].sort());
  });

  it("every cell carries a reason, and no reason merely restates the state", () => {
    for (const pane of PANE_IDS) {
      for (const door of DOORS) {
        const cell = MATRIX[pane][door];
        expect(cell.why.length, `${pane} × ${door} has no reason`).toBeGreaterThan(20);
        /* A PREFIX MATCH, not a whole-string one. It was anchored `…\.?$`, which the `> 20` length
           floor DIRECTLY ABOVE had already made unreachable: the longest string that pattern can
           match is "not applicable." at fifteen characters, so nothing surviving the floor could
           ever hit it. Same shape as the `DOORS.length` check this file deleted for the same
           reason. A reason that BEGINS with a shrug and then rambles is the real thing worth
           catching.

           "Directly above" and not a line count, for the reason the `DesktopGate` comment this
           lane also corrected gives: three places gave three different numbers for one gap, and a
           reference that cannot go stale names the thing rather than the distance to it. */
        expect(
          cell.why.toLowerCase(),
          `${pane} × ${door}'s reason opens by restating the state instead of giving one`,
        ).not.toMatch(/^(not applicable|n\/a|missing|absent)\b/);
      }
    }
  });

  /* INERT IS A DEFECT WITH A REMEDY, NEVER A RESTING STATE. Without this the word would become a
     place to park anything awkward, which is the opposite of what it is for — so each one has to
     name the SIGNAL that would let the surface withhold the pane honestly. On both of the doors
     this census renders, that signal exists and is used (the transport declares it); the one
     `inert` cell is a door this census cannot render, and it names what is missing. */
  it("every inert cell names the signal that would let the surface withhold it", () => {
    for (const pane of PANE_IDS) {
      for (const door of DOORS) {
        const cell = MATRIX[pane][door];
        if (cell.state !== "inert") continue;
        expect(
          cell.why,
          `${pane} × ${door} is inert with no remedy named — a dead pane needs a way out, not a note`,
        ).toMatch(/\/hello|transport|capability|declare|which server/);
      }
    }
  });

  /* AND NEITHER DOOR THIS FILE ACTUALLY RENDERS MAY HOLD ONE. An `inert` cell on a rendered door
     would be a pane the census WATCHED draw over a table that cannot serve it — a defect recorded
     rather than fixed, and this file is the wrong place for that to be comfortable.
     `desktopSelfHost` is exempt because it is a ruling, not a render: `DesktopGate` cannot tell it
     from `desktopCloud` today, which is the finding its cells carry. */
  it("neither RENDERED desktop door holds an inert cell — the transport declares its capability there", () => {
    for (const door of ["desktopCloud", "desktopStandalone"] as const) {
      const inert = (PANE_IDS as readonly PaneId[]).filter((p) => MATRIX[p][door].state === "inert");
      expect(inert, `${door} draws a pane it cannot store into`).toEqual([]);
    }
  });

  /**
   * EVERY CELL EXISTS, ASSERTED AT RUNTIME — because the type does not assert it here.
   *
   * `Record<Door, Cell>` would be a compile-time guarantee in a program that compiles this file,
   * and `apps/desktop`'s typecheck covers `src` only. So a door added to `DOORS` and forgotten in
   * the table would be `undefined` at every read: `drawnOn` would silently treat the pane as
   * drawn, and the reason cases would throw on a property of nothing.
   *
   * THE LIST COMES FROM {@link DOORS} AND NOT FROM THE TABLE, which is the whole of why this case
   * can fail. Reading it off `MATRIX.general` — the shape this started as — meant a door forgotten
   * in every row was a door the check had never heard of, and the assertion compared the table
   * with itself.
   */
  /* THERE IS NO HARNESS-SANITY LINE HERE ANY MORE, and its absence is deliberate. While the door
     list was derived (`Object.keys(MATRIX.general)`) it could genuinely come out empty, and a
     `length > 1` check was doing real work. `DOORS` is an `as const` literal, so its length is a
     compile-time constant and the same check could never fail again — a passing assertion that
     asserts nothing, left behind by the refactor, in the file whose subject was a guard that could
     not fail. The comparison below carries the weight and fails on both partial and total
     forgetting. */
  it("every pane names every door — the type does not check this file", () => {
    for (const pane of PANE_IDS) {
      expect(Object.keys(MATRIX[pane]).sort(), `${pane} does not name every door`)
        .toEqual([...DOORS].sort());
    }
  });

  /**
   * EVERY ABSENCE ON THE CONNECTED DESKTOP NAMES WHAT IT CANNOT REACH — and this is deliberately
   * NOT scoped to the panes the managed web also draws.
   *
   * That scoping is what made the previous two shapes unable to fail. First it was a loop with a
   * `continue` and no other assertion, and nothing reached its `expect`: the only pane absent on
   * `desktopCloud` is `invites`, which the managed web does not draw either, so all sixteen
   * iterations skipped and the case passed having compared nothing. The repair pinned the SET —
   * correctly — but left the reason loop BELOW the set assertion, where it is unreachable in both
   * directions: a non-empty set throws first, and an empty one has nothing to iterate. A guard
   * that cannot fail, reintroduced one line under the fix for a guard that could not fail.
   *
   * So the reason check runs over every pane absent on that door, whatever the web does, and it
   * executes today (`invites`). The set comparison is its own case below.
   */
  it("every pane absent on the connected desktop says what it cannot reach", () => {
    const absent = (PANE_IDS as readonly PaneId[]).filter(
      (p) => MATRIX[p].desktopCloud.state === "absent",
    );
    expect(absent.length, "no pane is absent there at all — this check is looking at nothing")
      .toBeGreaterThan(0);
    for (const pane of absent) {
      expect(
        MATRIX[pane].desktopCloud.why,
        `${pane} is absent on the connected desktop with no reason naming what it cannot reach`,
      ).toMatch(/no account|no server|mints no invite/);
    }
  });

  /**
   * AND THE SET ITSELF IS EMPTY — the claim this whole file exists to hold: there is no pane a
   * browser tab on the managed service offers that a connected desktop does not. A future absence
   * has to be written in here, which is where somebody is asked whether it is a decision or a hole.
   *
   * Its own case rather than a second assertion in the one above, because the first assertion to
   * throw ends the case — which is exactly how the reason check came to be unreachable.
   */
  it("no pane the managed web draws is absent on the connected desktop", () => {
    const missing = (PANE_IDS as readonly PaneId[]).filter(
      (p) => MATRIX[p].managedWeb.state !== "absent" && MATRIX[p].desktopCloud.state === "absent",
    );
    expect(
      missing,
      "a pane the managed web draws is missing on the connected desktop. If that is a decision, " +
        "add it here with a reason naming what the desktop cannot reach; if it is not, it is the " +
        "defect this whole file exists to stop.",
    ).toEqual([]);
  });
});

describe("SET-C — the desktop's two doors draw exactly what the census says", () => {
  it("the cloud door, on an install that was signed in at launch", async () => {
    const nav = await navFor(CLOUD_SERVING, true);
    expect(nav.sort()).toEqual(drawnOn("desktopCloud").map(label).sort());
  });

  /**
   * THE CASE THE OLD GATE FAILED. Same engine, same live session, one launch-time field different
   * — and six panes used to vanish. The nav must be identical to the case above, character for
   * character, because nothing about what this install can reach is different.
   */
  it("…and identically on one that signed in after launch, where the launch frame still says absent", async () => {
    const nav = await navFor(CLOUD_SIGNED_IN_AFTER_LAUNCH, true);
    expect(nav.sort()).toEqual(drawnOn("desktopCloud").map(label).sort());
  });

  it("…and on an engine too old to carry the field at all", async () => {
    const nav = await navFor(CLOUD_ENGINE_TOO_OLD, true);
    expect(nav.sort()).toEqual(drawnOn("desktopCloud").map(label).sort());
  });

  it("the standalone door", async () => {
    const nav = await navFor(LOCAL_SERVING, true);
    expect(nav.sort()).toEqual(drawnOn("desktopStandalone").map(label).sort());
  });

  /**
   * THE `selfHostWeb`/`desktopSelfHost` ROW, DRIVEN. Those two cells read `absent` because the
   * route answers 404 there, and that claim is only worth making if the nav really loses the
   * entry — the pane used to render regardless and offer a checkout that could not open.
   *
   * Same engine, same session, one answer different, so nothing else can explain the difference.
   */
  it("a door whose server serves no manage page draws no Subscription entry", async () => {
    manageLink = null;
    const nav = await navFor(CLOUD_SERVING, true);
    expect(nav, "the entry survived a 404").not.toContain(label("billing"));
    // …and the rest of the nav is untouched, so this is a withheld pane and not a broken mount.
    expect(nav.sort()).toEqual(drawnOn("desktopCloud").filter((p) => p !== "billing").map(label).sort());
  });

  /**
   * AND THE NEGATIVE CONTROL, so "always show everything" cannot pass this file. A cloud engine
   * whose session is gone renders the sign-in surface instead of the mail client — there is no
   * settings nav at all, which is the honest answer and not a shorter one.
   */
  it("a cloud door whose session is gone draws no settings nav, because it draws no mail client", async () => {
    const nav = await navFor(CLOUD_SERVING, false);
    expect(nav).toEqual([]);
  });
});
