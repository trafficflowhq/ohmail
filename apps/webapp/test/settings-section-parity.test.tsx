/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

import { PANE_IDS, SettingsView, type PaneId } from "../app/views/SettingsView";

/**
 * ═══ THE SAME ACCOUNT, THE SAME SETTINGS — BROWSER TAB AND DESKTOP CLOUD DOOR ═══════════════
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────────
 *
 * An install signed in to a hosted account showed a SHORTER settings surface than the same
 * account showed in a browser tab, and nothing on screen said why. Two mechanisms, one cause:
 *
 *  · `apiConfigured()` is false in every desktop build, so every control the shell gates on "is
 *    there a server" was withheld — the auto-suggest opt-in among them, on an account that could
 *    have it switched ON and spending, with no way to see or revoke it in the app doing the
 *    spending;
 *  · three panes were simply never wired — Subscription, Security, Account — so the nav had
 *    three fewer entries than the web client's.
 *
 * Neither absence was a decision. Both read to the person in front of them as "this product does
 * not have that", which for account deletion contradicts what the site promises.
 *
 * ── WHAT THIS FILE IS FOR, AND WHY IT IS A TABLE ────────────────────────────────────────────
 *
 * The rule is: on the CLOUD door the desktop's settings match the web's, and where a ceremony is
 * genuinely browser-only the pane is still THERE with a door out — never silently missing. A
 * guard that only asserted today's pane list would go green forever while a NEW web pane quietly
 * failed to reach the desktop, which is the exact defect being fixed.
 *
 * So every id in {@link PANE_IDS} carries a RULING here, and the table's key set is asserted
 * against `PANE_IDS` itself. Add a pane to the shared view and this file fails until somebody has
 * decided what the desktop does about it. That is the whole point: the failure is a question, not
 * a chore.
 *
 * ── MUTATION WATCH ──────────────────────────────────────────────────────────────────────────
 *
 *  · add a pane id to `PANE_IDS` without a row here → the completeness case goes red;
 *  · drop `billingSection` (or `securitySection`, or `accountSection`, or `consentTransport`,
 *    or `suggestWire`) from `DesktopGate.tsx` → that pane's wiring case goes red;
 *  · wire `desktopSection` into the Cloud client → the web-only case goes red;
 *  · SWAP the two `consentTransport` arms in `DesktopGate.tsx`, so the hosted door takes the
 *    standalone wire → the consent-wire case goes red. This one is listed separately from
 *    "drop `consentTransport`" because the file was blind to it through two spellings: the
 *    literal it searched for survives a swap, moved to the other arm, and only the CONDITION
 *    tells the two apart. Both blind spellings were re-run against a real swap and passed
 *    21/21 before the anchored one was written.
 *
 * AND ONE NEGATIVE CONTROL, which is the half a mutation list usually leaves out:
 *
 *  · REORDER those same two arms — semantics-preserving, since `consentDoorFor`'s three answers
 *    are exclusive → everything stays GREEN. It did not before: `consentTransport` was in the
 *    `accountDoor` prop loop below, which finds the FIRST occurrence of a property and searches
 *    backwards for its gate, so a harmless reorder turned that case red and accused the author of
 *    leaking an account surface onto the standalone door. A guard that fires on a change which
 *    breaks nothing costs as much trust as one that stays silent on a change that does.
 *
 * All five were run.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "");

const read = (p: string): string => stripComments(readFileSync(resolve(process.cwd(), p), "utf8"));

const GATE = read("apps/desktop/src/DesktopGate.tsx");
const CLOUD_SHELL = read("apps/webapp/app/(product)/mailbox/CloudShell.tsx");
const APP_SHELL = read("apps/webapp/app/shell/AppShell.tsx");

/**
 * WHAT THE DESKTOP'S HOSTED DOOR DOES ABOUT EACH SETTINGS PANE.
 *
 *  · `shared`  — `SettingsView` draws it for every host with no prop at all, so both surfaces have
 *                it by construction and there is nothing to wire.
 *  · `wired`   — the desktop supplies the pane. `prop` is what `DesktopGate` must hand to
 *                `AppShell` for it to exist; `via` says what the pane actually is there, because
 *                "present" and "the same pane" are different claims and only one of them is
 *                worth asserting from a nav label.
 *  · `webOnly` — deliberately absent on the desktop, with the reason. Exactly one entry, and it
 *                points the other way: a pane the WEB cannot have.
 */
type Ruling =
  | { kind: "shared" }
  | { kind: "wired"; prop: string; via: string }
  | { kind: "webOnly"; why: string }
  /* Present on the SELF-HOST web client alone: the browser tab against the managed service and
     every desktop door must all lack it, because the machinery behind it is mounted on the
     self-host composition and nowhere else. `prop` is what the self-host web shell hands in;
     the assertions below pin that the desktop never wires it and that the web wires it only
     behind its gate. */
  | { kind: "selfHostWeb"; prop: string; why: string }
  /* Present on the desktop's STANDALONE door (never its hosted door), AND on the web behind a
     runtime capability gate — the two doors that have something real behind the pane, each its
     own node. `guard` is the pure door rule the desktop gate must wire it through; `webWire` is
     the exact gated expression the Cloud client must hand in, so the assertion is about the
     DECISION on both edges and not merely the prop's presence. */
  | { kind: "desktopStandaloneAndGatedWeb"; prop: string; guard: string; webWire: string; why: string }
  /* Built by the SHARED SHELL itself (`AppShell`), handed in by neither host: the pane exists
     wherever the shell can reach the account's consent row — the browser's Cloud client, and the
     desktop's hosted door through `consentTransport` — and is withheld where there is no row to
     read (a standalone install, the demo). `shellWire` is the exact gated expression in
     `AppShell`, so the assertion is about the decision, not the prop's mere presence. */
  | { kind: "shellConsentGated"; shellWire: string; why: string };

const DESKTOP_CLOUD_DOOR: Record<PaneId, Ruling> = {
  // ── Drawn by the shared view for every host ────────────────────────────────────────────────
  general: { kind: "shared" },
  notifications: { kind: "shared" },
  tags: { kind: "shared" },
  rules: { kind: "shared" },

  // ── PARITY: the same control over the same account row, reached by forwarding ──────────────
  mailboxes: { kind: "wired", prop: "mailboxSection", via: "DesktopMailboxes" },
  /* The pane exists as soon as ANY of its nodes is wired. `screeningSection` is the desktop's own
     (the posture and the bar over the pipe); `consentTransport` and `suggestWire` are what bring
     the three the shell builds itself — the dormancy dial, the auto-suggest opt-in and
     auto-unsubscribe — all of which were withheld here because the shell's own reads could not
     run. The opt-in needs BOTH: one wire reads and writes the flag, the other prices the batch
     turning it on would buy. */
  screener: { kind: "wired", prop: "screeningSection", via: "DesktopScreening" },
  away: { kind: "wired", prop: "awayTransport", via: "awayOverBridge" },
  about: { kind: "wired", prop: "aboutSection", via: "DesktopAbout" },

  /* THE ACCOUNT'S AI SWITCH — wired on both surfaces, and the only pane here that is a WRITE
     rather than a door. It is not step-up gated (`ai-settings.ts` argues why: reversible by the
     same request with the opposite boolean, destroys nothing, moves no money), so unlike Security
     and Account there is nothing about it this window cannot do. */
  ai: { kind: "wired", prop: "aiSection", via: "DesktopAiAccount" },

  // ── LINK-OUT: the pane is present and its content lives in a browser. Security and Account
  //    because the ceremony behind them is step-up gated; Subscription because the page belongs
  //    to whoever operates the service. Not an omission papered over — see `DesktopWebSection`
  //    and `DesktopSubscription`. ─────────────────────────────────────────────────────────────
  billing: { kind: "wired", prop: "billingSection", via: "DesktopSubscription" },
  security: { kind: "wired", prop: "securitySection", via: "DesktopWebSection" },
  account: { kind: "wired", prop: "accountSection", via: "DesktopWebSection" },

  // ── The mirror image, and the only entry that is an absence on the WEB ─────────────────────
  desktop: {
    kind: "webOnly",
    why: "every control in it is a call to a native shell, which a browser tab does not have",
  },

  // ── Built by the shared shell over the consent row, on both consent-reachable doors ─────────
  folders: {
    kind: "shellConsentGated",
    shellWire: "foldersSection={demo || !consent.known || !consent.foldersStorable ? undefined : (",
    why: "\"Use folders\" is an account_settings column (FOLDERS-SPEC.md §6). The shell builds " +
      "the row itself because the rail's Folders group is gated on the SAME useConsentState " +
      "answer — a host-injected pane with its own fetch could flip a switch the rail cannot " +
      "see. The desktop's hosted door gets it through consentTransport: /folders* is not served " +
      "locally there, so all four verbs reach the account through the write-through proxy. " +
      "THE SECOND CLAUSE IS THE STANDALONE DOOR, and it used to read 'standalone has no consent " +
      "row and no pane' — which stopped being true when the screening window reached that door. " +
      "consentRoutes are mounted on localRoutes now, so `known` goes true there while the engine " +
      "still serves no folder verb at all: withoutFoldersFlag REMOVES the field from the read and " +
      "drops it silently on the write, and the pane drew a master switch that snapped back. The " +
      "capability is declared by the transport — truthfully on the STANDALONE wire, which is the " +
      "one wire that serves a single table. The desktop's hosted wire serves two doors (the " +
      "self-host door is the same `{ mode: \"cloud\" }` pointed at a server that strips the flag) " +
      "and the browser's constant cannot interrogate its server at all; both are recorded in the " +
      "settings census and settled by a `/hello` feature word rather than by a per-wire guess.",
  },

  // ── Built by the shared shell over the consent row, exactly as folders is ───────────────────
  signatures: {
    kind: "shellConsentGated",
    shellWire: "demo || !consent.signaturesKnown || !facts || facts.length === 0 ? undefined : (",
    why: "the per-mailbox signature is a mailboxes column written through PATCH /consent/settings " +
      "(mail 0075). The shell builds the pane itself because every compose surface's signature " +
      "block reads the SAME useConsentState map — a host-injected pane with its own fetch could " +
      "save a signature an open composer cannot see. BOTH desktop doors get it through a " +
      "consentTransport, and this clause used to end 'standalone has no consent row and no pane' " +
      "— the third copy of a premise that died when consentRoutes were mounted on localRoutes. " +
      "That door answers GET /consent, stores the signature in its own mailboxes row, and draws " +
      "the pane; the settings census records it as present for exactly that reason, and two guard " +
      "files stating opposite facts about one door is worth more than either of them alone. " +
      "Gated additionally on the mailbox facts, because an editor needs an address to belong to.",
  },

  // ── Self-host web only: who else may join the server ────────────────────────────────────────
  invites: {
    kind: "selfHostWeb",
    prop: "invitesSection",
    why: "the INVITE grant is mintable and redeemable on the self-host composition alone (the " +
      "managed service mounts the pairing routes too since the device-pairing slice, but wires " +
      "no invite bridge, so both its invite arms refuse) — the managed web and both desktop " +
      "doors have nothing behind THIS pane, so none may grow the entry",
  },

  /* ── Devices: one pane id, a different node on every door ─────────────────────────────────
   *
   * The desktop half of this row used to end "the hosted door is withheld the entry
   * structurally", and its whole argument was about HOST MODE — publishing the mailbox this
   * computer opens. That argument is right and it answered a question nobody had asked: the web's
   * Devices pane is not host mode, it is the ACCOUNT's own sessions, the pairing mint and the
   * revoke. So a browser tab could see which devices were signed into an account and take one
   * back, and the app mirroring that same account could not, with no entry saying why.
   *
   * `guard` still names the STANDALONE arm, because that is the one this shape can locate (it
   * searches backwards from the first `devicesSection:`); the hosted arm gets its own case
   * below. */
  devices: {
    kind: "desktopStandaloneAndGatedWeb",
    prop: "devicesSection",
    guard: 'hostDoorFor(status) === "local"',
    webWire: "devicesSection={devicePairing ? <DevicesSection /> : undefined}",
    why: "on the desktop's STANDALONE door this is host mode — publishing the mailbox THIS " +
      "computer opens, which only an install holding the whole mailbox has to offer. The web " +
      "has its OWN devices pane since the managed device-pairing mount (a different node: the " +
      "server-side mint/list/revoke), and it must be gated on /hello's features.pairing so an " +
      "older server never grows a dead entry. This row used to read 'the web never does'; that " +
      "claim was retired deliberately when the managed table mounted the ceremony, and the " +
      "gated wire is the new claim under test",
  },
};

describe("SET-P — every settings pane carries a ruling for the desktop's cloud door", () => {
  it("the table names exactly the panes the shared view knows about", () => {
    expect(
      Object.keys(DESKTOP_CLOUD_DOOR).sort(),
      "a settings pane exists with no ruling for the desktop's hosted door. Decide which it is — " +
        "parity (the route is reachable through the engine's forward), link-out (the ceremony " +
        "needs a second factor this app cannot assert), or web-only — and add the row.",
    ).toEqual([...PANE_IDS].sort());
  });

  it("resolved both hosts' real sources", () => {
    expect(GATE).toContain("export function DesktopGate()");
    expect(CLOUD_SHELL).toContain("AppShell");
  });
});

describe("SET-P — the desktop's hosted door wires every pane its ruling says it does", () => {
  for (const [pane, ruling] of Object.entries(DESKTOP_CLOUD_DOOR) as Array<[PaneId, Ruling]>) {
    if (ruling.kind !== "wired") continue;
    it(`${pane}: DesktopGate hands in \`${ruling.prop}\` (${ruling.via})`, () => {
      expect(GATE, `\`${ruling.prop}\` is gone from DesktopGate — the ${pane} pane is missing on the desktop again`)
        .toContain(`${ruling.prop}:`);
      expect(GATE).toContain(ruling.via);
    });
  }

  /* THE GATING WIRES. They produce no pane of their own, which is exactly why they need naming:
     without them the Screener pane still appears (the desktop wires its own section) and is
     silently three controls short of the web's — the shape this whole slice is about. */
  it("…and the two wires that carry the account's own consent row and its spend quote", () => {
    /* ANCHORED ON THE DOOR, AND THE WIRE COMPARED WHOLE. The mutation that matters is a SWAP —
       the hosted door taking the standalone wire, which declares `foldersStorable: false` and
       removes the Folders pane from a door where all four folder verbs reach the account. An
       unanchored `toContain` cannot see it twice over: the literal survives a swap in the other
       arm, and `consentOverBridgeStandalone` carries the hosted wire's name as a prefix. The door
       rule is `consentDoorFor` — `accountDoor ? … : firstRunDoorFor === "local"` had a hole
       exactly where a paired desktop appeared, and got no consent transport at all. */
    const wireFor = (door: string): string =>
      new RegExp(`consentDoorFor\\(status, hostedSession\\) === "${door}"\\s*\\n?\\s*`
        + `\\?\\s*\\{ consentTransport: (\\w+) \\}`).exec(GATE)?.[1] ?? "";
    expect(wireFor("cloud"), "no `consentTransport` on the hosted door — the dormancy dial, the " +
      "auto-suggest opt-in and auto-unsubscribe go back to being withheld on an account that has all three")
      .toBe("consentOverBridge");
    expect(wireFor("standalone"), "no `consentTransport` on the standalone door — this install " +
      "stores its own screening window and would be left with none")
      .toBe("consentOverBridgeStandalone");
    expect(GATE, "no `suggestWire` — `autoOptIn.supported` is false again and the opt-in row, " +
      "which is the control that authorises spending, disappears with no price to show")
      .toContain("suggestWire: cloudSuggestWire");
  });

  /* THE ACCOUNT-ONLY SURFACES ON ONE GATE. A pane that appeared on the standalone door would be a
     pane about an account that install does not have — and `suggestWire` would be a spend control
     with no ledger behind it. One predicate, so they cannot drift apart.

     `consentTransport` IS NOT IN THIS LIST, and its absence is the correction rather than an
     oversight. The comment here used to close "for the two wires it would be a control over a row
     that does not exist", which died when `consentRoutes` were mounted on `localRoutes`: the
     standalone door HAS the row and is wired a transport for it on purpose. Leaving the prop in
     the loop also made the case a trap — it passes only because `indexOf` finds the FIRST
     `consentTransport:`, which happens to sit in the `accountDoor` arm, so reordering the two
     arms of a ternary whose branches are mutually exclusive would turn it red and accuse the
     author of leaking an account surface onto the standalone door. The anchored regex above is
     that wire's guard now, and it names the arm rather than counting on the order. */
  it("…all of them behind `accountDoor`, so none can leak onto the standalone door", () => {
    /* THE SECOND ARGUMENT IS THE POINT, not decoration. `accountDoorFor` used to read the launch
       frame's `credentialState`, which the shell never rewrites — so an install that signed in
       through the window's own surface ran the session reported as signed OUT and lost every pane
       below. The live verdict is `hostedSession`, derived from the same `/health` probe the whole
       window routes off.

       PINNED ON THE DECLARATION, not on one spelling of its first operand. `accountDoor` is now
       read by the subscription offer hook too, which gates the ASK and not only the mount, so it is
       derived above every early return — where the status is read off `shell` directly, the form
       `paired` already uses a few lines below. What must never drift is the SECOND argument: a
       gate that reads a stale field is a gate that is green about the wrong fact. */
    const decl = GATE.indexOf("const accountDoor =");
    expect(decl, "`accountDoor` is not declared in the gate at all").toBeGreaterThan(0);
    const call = GATE.slice(decl, GATE.indexOf(";", decl) + 1);
    expect(call, "`accountDoor` no longer comes from `accountDoorFor`").toContain("accountDoorFor(");
    expect(
      call,
      "`accountDoor` reads something other than the live `hostedSession` verdict",
    ).toContain(", hostedSession) === \"cloud\"");
    for (const prop of ["suggestWire", "billingSection", "securitySection", "accountSection"]) {
      const at = GATE.indexOf(`${prop}:`);
      expect(at, `${prop} is not wired at all`).toBeGreaterThan(0);
      /* The spread that carries it opens with the gate. Searched backwards from the property to
         the nearest `{...(`, which is the whole of the conditional it lives in. */
      const opens = GATE.lastIndexOf("{...(", at);
      expect(
        GATE.slice(opens, at),
        `${prop} is not behind accountDoor — a standalone install would grow an account surface`,
      ).toContain("accountDoor");
    }
  });

  it("the Cloud client never hands in the pane only a native shell can have", () => {
    expect(CLOUD_SHELL).not.toContain("desktopSection");
  });

  /**
   * THE SUBSCRIPTION PANE IS GATED ON BOTH SURFACES — the exact gated expression.
   *
   * BOTH halves are gated on the OFFER rather than on a minted URL, since the address stopped
   * being minted at mount — it is minted by the press — and the gate is the same rule either
   * way: no page, no node.
   *
   * `SettingsView` grows the nav entry from the prop's presence, so a pane that decided its own
   * absence with `return null` would still put "Subscription" in the nav and open an empty pane
   * on it. Asserted as the expression rather than by mounting, for `invitesSection`'s reason
   * above: the mount cannot tell an absent node from a node that rendered nothing.
   *
   * The desktop half of this was built the wrong way first and the census control caught it, so
   * the gate is named here too — both surfaces, one rule.
   */
  it("billing: both surfaces build the node only where there is a page to go to", () => {
    expect(
      CLOUD_SHELL,
      "the web client hands in a Subscription pane unconditionally — the nav grows an entry that "
        + "opens onto nothing",
    ).toContain(
      "billingSection={manageOffered ? <SubscriptionSection onNowhere={withdrawManage} /> : undefined}",
    );
    expect(GATE, "DesktopGate no longer gates the Subscription pane on the offer")
      .toContain("accountDoor && manageOffered");
  });

  /* THE HOSTED DOOR'S DEVICES ARM, which the two-door shape above cannot locate: it finds the
     FIRST `devicesSection:` in the file, and that is host mode's. The account's own device list
     is the second arm, and it exists because the pane's absence read as "this product does not
     have that" on an install mirroring an account that has devices. A door out and not a form,
     for `DesktopWebSection`'s reason — the mint and the revoke are step-up gated. */
  it("devices: the hosted door opens the account's own device list in the browser", () => {
    expect(GATE, "the connected desktop has no Devices entry again").toContain('place="devices"');
    const at = GATE.indexOf('place="devices"');
    const opens = GATE.lastIndexOf("{...(", at);
    expect(
      GATE.slice(opens, at),
      "the hosted devices pane is not behind accountDoor — a signed-out install would grow a " +
        "door to an account it has no session for",
    ).toContain("accountDoor");
    /* THE SHELL'S TABLE HAS TO KNOW THE PLACE, or the button opens nothing and the pane's own
       failure sentence blames the computer for a key that was never added. */
    expect(
      read("apps/desktop/src/native.ts"),
      "`devices` is not one of WEB_PLACES — the button would pass a key the shell refuses",
    ).toContain('"devices"');
  });

  /* THE SELF-HOST-ONLY PANE, both edges. The desktop's doors talk to the managed service (or to
     no server at all), where the pane's every verb would 404 — so `DesktopGate` must never wire
     it. The web wires it, but only behind the compiled-flavor + `/hello features.pairing` gate:
     an unconditional node would grow an Invites entry on the managed web, whose API mounts no
     mint routes. */
  for (const [pane, ruling] of Object.entries(DESKTOP_CLOUD_DOOR) as Array<[PaneId, Ruling]>) {
    if (ruling.kind !== "selfHostWeb") continue;
    it(`${pane}: the desktop never wires \`${ruling.prop}\`, and the web wires it only behind its gate`, () => {
      expect(GATE, ruling.why).not.toContain(ruling.prop);
      expect(CLOUD_SHELL).toContain(`${ruling.prop}={userInvites ? <InvitesSection /> : undefined}`);
    });
  }

  /* THE SHELL-BUILT, CONSENT-GATED PANE. The assertion is the exact gated expression: an
     unconditional `<FoldersRow />` would draw the switch before the server answered (the
     wrong-then-right flash every consent row avoids) and on the demo, which has no row. The
     transport that makes it true on the desktop's hosted door is asserted above already
     (`consentTransport: consentOverBridge`). */
  for (const [pane, ruling] of Object.entries(DESKTOP_CLOUD_DOOR) as Array<[PaneId, Ruling]>) {
    if (ruling.kind !== "shellConsentGated") continue;
    it(`${pane}: the shared shell builds it behind the consent gate`, () => {
      expect(APP_SHELL, ruling.why).toContain(ruling.shellWire);
    });
  }

  /* THE TWO-DOOR PANE, both edges. The desktop gate must wire its node through its pure door
     rule — not merely wire it — because "present" and "present on the one door that can serve
     it" are different claims, and only the second keeps a hosted install from growing a pane
     whose every verb the shell would refuse. The WEB wires its own node too since the managed
     device-pairing mount, and the assertion is the exact gated expression: an unconditional
     `<DevicesSection />` would grow the entry on a tab against an older server whose /hello
     never announced pairing — the dead-button shape the runtime gate exists to prevent. */
  for (const [pane, ruling] of Object.entries(DESKTOP_CLOUD_DOOR) as Array<[PaneId, Ruling]>) {
    if (ruling.kind !== "desktopStandaloneAndGatedWeb") continue;
    it(`${pane}: the gate wires \`${ruling.prop}\` through \`${ruling.guard}\`; the web wires its own node behind its gate`, () => {
      const at = GATE.indexOf(`${ruling.prop}:`);
      expect(at, `${ruling.prop} is not wired at all — the ${pane} pane is missing on the desktop`).toBeGreaterThan(0);
      const opens = GATE.lastIndexOf("{...(", at);
      expect(GATE.slice(opens, at), ruling.why).toContain(ruling.guard);
      expect(CLOUD_SHELL, ruling.why).toContain(ruling.webWire);
    });
  }
});

/* ── And the pane list the shared view actually BUILDS from those props, rendered. The source
      assertions above say the wires are handed over; this says what handing them over produces,
      which is the thing a person sees. ──────────────────────────────────────────────────────── */

/* `null` between mounts, because half the cases in this file are source assertions that never
   render — an unconditional teardown would fail every one of them on a root that was never
   created, which is a suite reporting twelve failures about a defect that does not exist. */
let host: HTMLDivElement | null = null;
let root: Root | null = null;

/** Take down whatever is mounted, if anything. Idempotent, so a case may re-mount mid-test. */
async function unmount(): Promise<void> {
  const live = root;
  const el = host;
  root = null;
  host = null;
  if (live) await act(() => live.unmount());
  el?.remove();
}

async function mount(props: Parameters<typeof SettingsView>[0]) {
  await unmount();
  host = document.createElement("div");
  document.body.append(host);
  const live = createRoot(host);
  root = live;
  await act(async () => {
    live.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, h(SettingsView, props))),
      }),
    );
  });
}

afterEach(unmount);

const navLabels = () =>
  [...host!.querySelectorAll(".set-nav button")].map((b) => b.textContent?.trim());

const node = (id: string) => h("p", { className: id }, id);

/** Every section prop a signed-in browser tab supplies. */
const WEB: Parameters<typeof SettingsView>[0] = {
  notifications: null,
  tags: [],
  tagCounts: {},
  rules: {
    items: [],
    onRevoke: async () => ({ status: "confirmed" }),
    onRetarget: async () => ({ status: "confirmed" }),
    pastMail: () => null,
  },
  mailboxSection: node("mailboxes"),
  screeningSection: node("screening"),
  autoSuggestSection: node("auto-suggest"),
  dormancySection: node("dormancy"),
  autoUnsubscribeSection: node("auto-unsub"),
  remoteImagesSection: node("remote-images"),
  seedSection: { label: "Sent-mail review", node: node("seed") },
  awaySection: node("away"),
  aiSection: node("ai"),
  billingSection: node("billing"),
  securitySection: node("security"),
  accountSection: node("account"),
  aboutSection: node("about"),
};

/**
 * The same, as the desktop's HOSTED door produces it — the difference being exactly the two
 * rulings this slice made, and nothing else.
 *
 * `remoteImagesSection` and `seedSection` are absent, and both for the SAME reason rather than
 * two: their machinery calls `app/api-client` directly and no injected wire substitutes for it.
 * Consented images load through `GET /img` on this origin, which the desktop window (its CSP
 * admits no address off the machine) does not have; the sent-mail review's whole ceremony is api-client calls.
 * Both are sub-pane rows, so neither removes a nav entry — which is why the nav sets below are
 * identical apart from the one pane the web genuinely cannot have.
 */
const DESKTOP: Parameters<typeof SettingsView>[0] = (() => {
  const { remoteImagesSection: _r, seedSection: _s, ...rest } = WEB;
  return { ...rest, desktopSection: { label: "Desktop", node: node("desktop") } };
})();

describe("SET-P — the two surfaces offer the same panes", () => {
  it("the desktop's hosted door lists every pane a browser tab lists", async () => {
    await mount(WEB);
    const web = navLabels();

    await mount(DESKTOP);
    const desktop = navLabels();

    for (const label of web) {
      expect(desktop, `the desktop's hosted door is missing the ${label} pane`).toContain(label);
    }
  });

  it("…and adds exactly one the browser cannot have", async () => {
    await mount(WEB);
    const web = navLabels();

    await mount(DESKTOP);
    expect(navLabels().filter((l) => !web.includes(l))).toEqual(["Desktop"]);
  });

  it("the Screener pane on the desktop carries the three controls it used to be short of", async () => {
    await mount({ ...DESKTOP, initialPane: "screener" });
    for (const cls of ["screening", "dormancy", "auto-suggest", "auto-unsub"]) {
      expect(host!.querySelector(`.${cls}`), `the Screener pane lost its ${cls} control`).toBeTruthy();
    }
  });

  it("a deep link to a pane this surface does not offer lands on General, never on a blank screen", async () => {
    // `?settings=<pane>` validates against the GLOBAL id list, but which panes exist is a
    // per-surface fact — `devices` only where a shell wired one (this WEB fixture deliberately
    // does not: a tab whose server never announced pairing), `desktop` never on the web. A
    // request for an unoffered pane must clamp to General: the alternative is a settings
    // screen whose content column renders nothing at all.
    for (const asked of ["devices", "desktop"] as const) {
      await mount({ ...WEB, initialPane: asked });
      expect(
        host!.querySelector(".set-pane"),
        `initialPane="${asked}" on a surface without it drew an empty content column`,
      ).toBeTruthy();
      expect(host!.querySelector(".theme-seg"), "the clamp should land on General").toBeTruthy();
    }
  });
});
