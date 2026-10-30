/**
 * ═══ THE MANAGED ACCOUNT'S WALL ═══════════════════════════════════════════════════════════════
 *
 * Four subjects, and every one of them is a decision a screen used to make inside its own JSX:
 *
 *  1. THE SINK — one 402 reader, keyed on the envelope's CODE. The `reason` is display text the
 *     service may reword; the phone's one existing reader compared it and matched nothing.
 *  2. THE WALL — what it says in every lifecycle state, on both distribution faces.
 *  3. THE STORE FACE — the default on this platform, and what it withholds.
 *  4. THE STRIPS — which notice, and the dismissal that comes back at the next launch.
 *
 * There is no React Native renderer in this workspace (`mail-row-badges-spoken.test.ts` states
 * the rule), so the screens are held two ways: the pure modules by their answers, and the
 * components by a census over their source proving they render what those modules answer.
 */
import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  ACCESS_REFUSED_CODE,
  ACCESS_REFUSED_STATUS,
  CLOSED_REASONS,
  LIFECYCLE_STATES,
  accessLock,
  clearAccessLock,
  lifecycleOf,
  onAccessLock,
  raiseAccessLock,
  refusalFactsOf,
  resetAccessLockForTests,
  withAccessLock,
  type AccessRefusedFacts,
} from "../src/net/access-lock";
import { accessOf, exportFilename } from "../src/net/account";
import { distributionOf, linksOutToBilling } from "../src/distribution";
import { WALL_LINE_KEYS, wallSays } from "../src/ui/wall-says";
import {
  TRIAL_NOTICE_DAYS, dismissKey, dismissed, noticeOf, remember, resetDismissalsForTests, stoodDown,
} from "../src/ui/lifecycle-strip";
import { dayStamp, NO_DATE } from "../src/ui/day-stamp";
import { gateFor } from "../src/state/gate";
import type { PhoneMailbox } from "../src/net/mailboxes";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import type { ConnectionState } from "../src/net/connection";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const read = (rel: string): string => fs.readFileSync(path.join(APP, rel), "utf8");

/** The 402 the gate answers, as the API writes it (`packages/api/src/middleware.ts`). */
function body(details: Record<string, unknown>, code = ACCESS_REFUSED_CODE): string {
  return JSON.stringify({ error: { code, message: "kept", details } });
}

const CLOSED = {
  state: "closed", closedReason: "trial_ended",
  closedAt: "2026-08-24T10:00:00.000Z", erasureAt: "2026-09-23T10:00:00.000Z",
  formerlyPaid: false,
};

beforeEach(() => {
  resetAccessLockForTests();
  resetDismissalsForTests();
});

/* ── 1. the sink ───────────────────────────────────────────────────────────────────────────── */

describe("the sink reads the CODE, never the reason", () => {
  it("the gate's own body raises the lock", () => {
    const facts = refusalFactsOf(402, body({
      reason: "payment_required", manageUrl: "https://pay.example/x",
      lifecycle: CLOSED, exportPath: "/account/export",
    }));
    expect(facts).not.toBeNull();
    expect(facts!.reason).toBe("payment_required");
    expect(facts!.manageUrl).toBe("https://pay.example/x");
    expect(facts!.exportPath).toBe("/account/export");
    expect(facts!.lifecycle?.closedAt).toBe(CLOSED.closedAt);
  });

  it("A 402 CARRYING ANOTHER CODE IS NOT THIS WALL — the defect this whole file exists for", () => {
    // `payment_required` is a real code this API answers (the mailbox-allowance refusal), and it
    // is ALSO the `details.reason` of the access refusal. The phone read the second as if it were
    // the first. Keying on the code separates them; keying on the reason cannot.
    expect(refusalFactsOf(402, body({ reason: "payment_required" }, "payment_required"))).toBeNull();
    expect(refusalFactsOf(402, body({}, "insufficient_balance"))).toBeNull();
  });

  it("a status that is not 402, and a body that is not the envelope, say nothing", () => {
    expect(refusalFactsOf(403, body({}))).toBeNull();
    expect(refusalFactsOf(200, body({}))).toBeNull();
    expect(refusalFactsOf(402, "<html>gateway</html>")).toBeNull();
    expect(refusalFactsOf(402, "")).toBeNull();
    expect(refusalFactsOf(402, "null")).toBeNull();
  });

  it("an OLD API — a 402 with no lifecycle — still locks, with no date to show", () => {
    const facts = refusalFactsOf(402, body({ reason: "payment_required" }));
    expect(facts).not.toBeNull();
    expect(facts!.lifecycle).toBeUndefined();
    // And the screen then says the sentence that has never claimed a date.
    expect(wallSays(facts!, "sideload").body.map((l) => l.key)).toEqual(["wallKept"]);
  });

  it("an UNKNOWN state drops the whole block — the same answer as an old server", () => {
    const facts = refusalFactsOf(402, body({ lifecycle: { state: "hibernating" } }));
    expect(facts!.lifecycle).toBeUndefined();
    expect(lifecycleOf({ state: 7 })).toBeUndefined();
    expect(lifecycleOf(null)).toBeUndefined();
    expect(lifecycleOf("closed")).toBeUndefined();
  });

  it("an unrecognised closedReason is 'not attributed', not a guess", () => {
    const l = lifecycleOf({ state: "closed", closedReason: "vibes" });
    expect(l?.closedReason).toBeNull();
  });

  it("an unrecognised REASON falls to the arm with a remedy, never to 'suspended'", () => {
    expect(refusalFactsOf(402, body({ reason: "who_knows" }))!.reason).toBe("payment_required");
    expect(refusalFactsOf(402, body({ reason: "suspended" }))!.reason).toBe("suspended");
  });

  it("an exportPath that is not a path is dropped — no door invented from a stray string", () => {
    expect(refusalFactsOf(402, body({ exportPath: "https://elsewhere/x" }))!.exportPath)
      .toBeUndefined();
    expect(refusalFactsOf(402, body({ exportPath: "" }))!.exportPath).toBeUndefined();
    expect(refusalFactsOf(402, body({ manageUrl: "" }))!.manageUrl).toBeUndefined();
  });
});

describe("the lock does not come down on its own", () => {
  const facts: AccessRefusedFacts = { reason: "payment_required" };

  it("a LATER 200 clears nothing — the browser shell's rule, kept", async () => {
    const answers = [
      new Response(body({ lifecycle: CLOSED }), { status: 402 }),
      new Response("{}", { status: 200 }),
      new Response("{}", { status: 200 }),
    ];
    const wrapped = withAccessLock(async () => answers.shift()!);
    await wrapped("https://x/threads");
    expect(accessLock()).not.toBeNull();
    await wrapped("https://x/account/access");
    await wrapped("https://x/threads");
    expect(accessLock()).not.toBeNull();
  });

  it("signing in again clears it (the fresh open verdict is the other door, `account-wall-renew.test.ts`)", () => {
    raiseAccessLock(facts);
    expect(accessLock()).toEqual(facts);
    clearAccessLock();
    expect(accessLock()).toBeNull();
  });

  it("a later closure's facts replace an earlier one's while the wall stands", () => {
    raiseAccessLock({ reason: "payment_required" });
    raiseAccessLock({ reason: "suspended" });
    expect(accessLock()!.reason).toBe("suspended");
  });

  it("every watcher hears, and one that throws does not silence the others", () => {
    const heard: string[] = [];
    onAccessLock(() => { throw new Error("a watcher's own failure"); });
    onAccessLock((f) => heard.push(f === null ? "cleared" : f.reason));
    raiseAccessLock(facts);
    clearAccessLock();
    expect(heard).toEqual(["payment_required", "cleared"]);
  });

  it("clearing an empty slot tells nobody — no phantom render on every launch", () => {
    let told = 0;
    onAccessLock(() => { told += 1; });
    clearAccessLock();
    expect(told).toBe(0);
  });
});

describe("the wrap hands the answer back whole", () => {
  it("a 402's BODY survives the read — the caller still sees what the server sent", async () => {
    const sent = body({ lifecycle: CLOSED, exportPath: "/account/export" });
    const wrapped = withAccessLock(async () => new Response(sent, {
      status: 402, headers: { "content-type": "application/json" },
    }));
    const res = await wrapped("https://x/threads");
    expect(res.status).toBe(ACCESS_REFUSED_STATUS);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).toBe(sent);
  });

  it("ANY OTHER STATUS is the very object the transport returned — nothing pays for the wall", async () => {
    const original = new Response("{\"ok\":true}", { status: 200 });
    const wrapped = withAccessLock(async () => original);
    expect(await wrapped("https://x/threads")).toBe(original);
    expect(accessLock()).toBeNull();
  });

  it("a body that cannot be read raises nothing and still answers the caller", async () => {
    const hostile = {
      status: 402, statusText: "", headers: new Headers(),
      text: () => Promise.reject(new Error("the stream was gone")),
    } as unknown as Response;
    const res = await withAccessLock(async () => hostile)("https://x/threads");
    expect(res).toBe(hostile);
    expect(accessLock()).toBeNull();
  });

  it("the wrap is composed on the PAIRED door and nowhere else", () => {
    // A standalone phone organizes its own mailbox: no plane, no gate, no 402 that can exist.
    // The property is held by construction, so it is read off the composition rather than
    // asserted about a state nothing can reach.
    const pairing = read("src/net/pairing.ts");
    expect(pairing.match(/withAccessLock\(/g) ?? []).toHaveLength(1);
    const standalone = pairing.slice(pairing.indexOf("localEngineTransport(door).fetch"));
    expect(standalone).not.toContain("withAccessLock");
  });
});

/* ── 2. the wall ───────────────────────────────────────────────────────────────────────────── */

const facts = (lifecycle: unknown, over: Partial<AccessRefusedFacts> = {}): AccessRefusedFacts => ({
  reason: "payment_required",
  manageUrl: "https://pay.example/x",
  exportPath: "/account/export",
  ...(lifecycleOf(lifecycle) ? { lifecycle: lifecycleOf(lifecycle)! } : {}),
  ...over,
});

describe("the wall's headline names the closure and carries the server's date", () => {
  const cases: [string, string, string][] = [
    ["trial_ended", "wallTrialEnded", "2026-08-24T10:00:00.000Z"],
    ["canceled", "wallCanceled", "2026-08-24T10:00:00.000Z"],
    ["unpaid", "wallUnpaid", "2026-08-24T10:00:00.000Z"],
  ];
  for (const [reason, key, at] of cases) {
    it(`a closure for ${reason} reads ${key} with its date`, () => {
      const plan = wallSays(facts({ state: "closed", closedReason: reason, closedAt: at }), "sideload");
      expect(plan.headline).toEqual({ key, date: at });
    });
  }

  it("an operator hold has its own headline and is never offered Subscribe", () => {
    const plan = wallSays(
      facts({ state: "closed", closedReason: "suspended", closedAt: "2026-08-24T10:00:00.000Z" }),
      "sideload",
    );
    expect(plan.headline).toEqual({ key: "wallSuspendedTitle" });
    // The account may be fully paid: "Subscribe" would be a false description of the remedy.
    expect(plan.actions.find((a) => a.id === "manage")!.label).toBe(EN.wallOpenAccount);
  });

  it("A CLOSURE WITH NO DATE falls to the undated title, never to today", () => {
    const plan = wallSays(facts({ state: "closed", closedReason: "canceled" }), "sideload");
    expect(plan.headline).toEqual({ key: "wallTitle" });
    expect(plan.headline.date).toBeUndefined();
  });

  it("a state that is not closed keeps the undated title", () => {
    for (const state of ["trialing", "grace", "past_due", "active"]) {
      expect(wallSays(facts({ state, closedReason: null }), "sideload").headline.key)
        .toBe("wallTitle");
    }
  });
});

describe("the wall's body and its erasure sentence", () => {
  it("a known lifecycle says it stopped AND that the mailbox is untouched", () => {
    const plan = wallSays(facts(CLOSED), "sideload");
    expect(plan.body.map((l) => l.key)).toEqual(["wallStopped", "wallMailboxUntouched"]);
    expect(plan.erasure).toEqual({ key: "wallErasure", date: CLOSED.erasureAt });
  });

  it("AN ERASED ACCOUNT IS TOLD NOTHING ABOUT AN ERASURE — no date, no sentence", () => {
    const plan = wallSays(facts({ state: "erased", closedReason: "canceled", erasedAt: "2026-09-23T00:00:00.000Z" }), "sideload");
    expect(plan.erasure).toBeNull();
    // "Nothing has been erased" would be false, and the dated sentence is about a deletion
    // that has happened. The state is unreachable (erasure takes the sessions) and a false
    // claim in an unreachable state is still a false claim.
    expect(JSON.stringify(plan)).not.toContain("wallErasure");
  });

  it("A HELD ACCOUNT HAS NO ERASURE CLOCK — an operator hold is not a departure", () => {
    const plan = wallSays(
      facts({ state: "closed", closedReason: "suspended", closedAt: CLOSED.closedAt, erasureAt: null }),
      "sideload",
    );
    expect(plan.erasure).toEqual({ key: "wallErasureHeld" });
    expect(plan.erasure!.date).toBeUndefined();
  });

  it("a closure with no erasure date says nothing has been erased, without a date", () => {
    const plan = wallSays(facts({ state: "closed", closedReason: "canceled", closedAt: CLOSED.closedAt }), "sideload");
    expect(plan.erasure).toEqual({ key: "wallErasureUnknown" });
  });

  it("no lifecycle at all: the one sentence the lock has always shown, and no erasure line", () => {
    const plan = wallSays({ reason: "payment_required", manageUrl: "https://x/y" }, "sideload");
    expect(plan.body.map((l) => l.key)).toEqual(["wallKept"]);
    expect(plan.erasure).toBeNull();
    expect(plan.actions.find((a) => a.id === "manage")!.label).toBe(EN.wallManage);
  });
});

describe("the wall's actions, in the order a person meets them", () => {
  it("the way back, the way out, the end, and the way off the screen", () => {
    expect(wallSays(facts(CLOSED), "sideload").actions.map((a) => a.id))
      .toEqual(["manage", "export", "delete", "servers"]);
  });

  it("no manage URL, no button — a control that goes nowhere is worse than none", () => {
    const plan = wallSays(facts(CLOSED, { manageUrl: undefined }), "sideload");
    expect(plan.actions.map((a) => a.id)).toEqual(["export", "servers"]);
    // And nothing tells somebody to open a page the server never named.
    expect(plan.openElsewhere).toBeNull();
  });

  it("no export path, no export — a server that serves none offers none", () => {
    expect(wallSays(facts(CLOSED, { exportPath: undefined }), "sideload").actions.map((a) => a.id))
      .toEqual(["manage", "delete", "servers"]);
  });

  it("THE WAY OFF THE SCREEN IS ALWAYS THERE — a lock with no way out is a trap", () => {
    const bare = wallSays({ reason: "suspended" }, "store");
    expect(bare.actions.map((a) => a.id)).toEqual(["servers"]);
  });

  it("the delete action LEAVES, and the screen says the second factor is why", () => {
    // MEASURED, not chosen: `DELETE /account` is `stepUp: true` and a paired phone's bearer is
    // minted `twofaAt: null` ("NULL fails step-up closed, so pairing cannot beget pairing",
    // `packages/services/src/auth/session-lifecycle.ts`). A press would be a permanent 403.
    const del = wallSays(facts(CLOSED), "sideload").actions.find((a) => a.id === "delete")!;
    expect(del).toMatchObject({ hint: EN.wallDeleteElsewhere });
    // It leaves for the account page by a link minted at the press (`account-wall-renew.test.ts`).
    expect(del).not.toHaveProperty("url");
    expect(EN.wallDeleteElsewhere).toContain("second factor");
  });
});

/* ── 3. the store face ─────────────────────────────────────────────────────────────────────── */

describe("the store face is the DEFAULT on this platform", () => {
  it("an unstamped build is a store build — the inversion from the desktop's default", () => {
    // Every phone build this project ships goes to a store, so a build that does not know what
    // it is must land on the WITHHOLDING face. A typo may cost a developer a button; it may not
    // cost a store review.
    expect(distributionOf(undefined)).toBe("store");
    expect(distributionOf("")).toBe("store");
    expect(distributionOf("direct")).toBe("store");
    expect(distributionOf("mas")).toBe("store");
    expect(distributionOf("SIDELOAD")).toBe("store");
    expect(distributionOf("sideload")).toBe("sideload");
  });

  it("only a sideload build may link out", () => {
    expect(linksOutToBilling("store")).toBe(false);
    expect(linksOutToBilling("sideload")).toBe(true);
  });

  it("THE STORE FACE DROPS BOTH OUTBOUND BUTTONS and names where to go instead", () => {
    const plan = wallSays(facts(CLOSED), "store");
    expect(plan.actions.map((a) => a.id)).toEqual(["export", "servers"]);
    expect(plan.openElsewhere).toBe("wallOpenInBrowser");
    // The export stays: it opens no page and buys nothing.
    expect(plan.actions.find((a) => a.id === "export")).toBeDefined();
  });

  it("THE SHIPPED CONSTANT, not just the parameter: an unstamped build withholds", () => {
    // Every arm above passes the face by name, which is what makes them drivable — and would let
    // the module's own literal be wrong while all of them stayed green. This one takes no face
    // and reads `DISTRIBUTION` itself, which is what the screen does.
    expect(process.env.EXPO_PUBLIC_OHMAIL_DISTRIBUTION).toBeUndefined();
    const plan = wallSays(facts(CLOSED));
    expect(plan.actions.map((a) => a.id)).toEqual(["export", "servers"]);
    expect(plan.openElsewhere).toBe("wallOpenInBrowser");
  });

  it("the store face keeps every SENTENCE — only the links go", () => {
    const store = wallSays(facts(CLOSED), "store");
    const side = wallSays(facts(CLOSED), "sideload");
    expect(store.headline).toEqual(side.headline);
    expect(store.body).toEqual(side.body);
    expect(store.erasure).toEqual(side.erasure);
  });

  it("NEITHER FACE CARRIES A PRICE, A PLAN NAME OR THE WORD BUY", () => {
    const forbidden = /\b(buy|purchase|price|pricing|\$|€|per month|monthly|plan name)\b/i;
    for (const face of ["store", "sideload"] as const) {
      const rendered = JSON.stringify(wallSays(facts(CLOSED), face));
      expect(rendered).not.toMatch(forbidden);
    }
  });
});

/* ── 4. the strips ─────────────────────────────────────────────────────────────────────────── */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-20T12:00:00.000Z");

describe("which strip, from the server's facts and one clock reading", () => {
  it("a grace and a dunning both state their deadline", () => {
    expect(noticeOf(lifecycleOf({ state: "grace", graceUntil: "2026-08-21T00:00:00.000Z" }), undefined, NOW))
      .toEqual({ kind: "grace", deadline: "2026-08-21T00:00:00.000Z" });
    expect(noticeOf(lifecycleOf({ state: "past_due", graceUntil: "2026-08-27T00:00:00.000Z" }), undefined, NOW))
      .toEqual({ kind: "pastDue", deadline: "2026-08-27T00:00:00.000Z" });
  });

  it("a grace with NO deadline draws nothing — a strip needs a date to be about", () => {
    expect(noticeOf(lifecycleOf({ state: "grace" }), undefined, NOW)).toBeNull();
    expect(noticeOf(lifecycleOf({ state: "past_due" }), undefined, NOW)).toBeNull();
  });

  it("a trial speaks only inside its last two days, and never after its end", () => {
    const at = (offset: number): string => new Date(NOW + offset).toISOString();
    expect(noticeOf(lifecycleOf({ state: "trialing", trialEndsAt: at(TRIAL_NOTICE_DAYS * DAY - 1) }), undefined, NOW))
      .toMatchObject({ kind: "trialEnding" });
    expect(noticeOf(lifecycleOf({ state: "trialing", trialEndsAt: at(TRIAL_NOTICE_DAYS * DAY + DAY) }), undefined, NOW))
      .toBeNull();
    // Past its end is a `grace`, and the server says so — this client never promotes by arithmetic.
    expect(noticeOf(lifecycleOf({ state: "trialing", trialEndsAt: at(-DAY) }), undefined, NOW)).toBeNull();
    expect(noticeOf(lifecycleOf({ state: "trialing", trialEndsAt: "not a date" }), undefined, NOW)).toBeNull();
  });

  it("an open, unremarkable account draws nothing at all", () => {
    expect(noticeOf(lifecycleOf({ state: "active" }), undefined, NOW)).toBeNull();
    expect(noticeOf(undefined, undefined, NOW)).toBeNull();
  });

  it("the catch-up outranks the rest, and is its date alone — no count (mail 0135)", () => {
    const l = lifecycleOf({ state: "grace", graceUntil: "2026-08-21T00:00:00.000Z" });
    expect(noticeOf(l, { since: "2026-08-01T00:00:00.000Z" }, NOW))
      .toEqual({ kind: "caughtUp", since: "2026-08-01T00:00:00.000Z" });
    expect(noticeOf(undefined, { since: "2026-08-01T00:00:00.000Z" }, NOW))
      .toEqual({ kind: "caughtUp", since: "2026-08-01T00:00:00.000Z" });
  });
});

describe("the dismissal is per run and keyed by the date it is about", () => {
  it("a NEW deadline is a new notice, even for the same state and account", () => {
    const a = dismissKey({ kind: "grace", deadline: "2026-08-21T00:00:00.000Z" }, "acct");
    const b = dismissKey({ kind: "grace", deadline: "2026-08-28T00:00:00.000Z" }, "acct");
    expect(a).not.toBe(b);
    remember(a);
    expect(dismissed(a)).toBe(true);
    expect(dismissed(b)).toBe(false);
  });

  it("two accounts on one phone do not share a dismissal", () => {
    const n = { kind: "caughtUp", since: "2026-08-01T00:00:00.000Z" } as const;
    remember(dismissKey(n, "A"));
    expect(dismissed(dismissKey(n, "B"))).toBe(false);
  });

  it("it does NOT survive a launch — module state is this platform's session", () => {
    const k = dismissKey({ kind: "pastDue", deadline: "2026-08-27T00:00:00.000Z" }, null);
    remember(k);
    expect(dismissed(k)).toBe(true);
    resetDismissalsForTests();
    expect(dismissed(k)).toBe(false);
  });
});

describe("a stopped mailbox, and one nobody ever agreed to", () => {
  const box = (over: Partial<PhoneMailbox>): PhoneMailbox => ({
    id: "m1", address: "one@fake.test", organizerRole: null, organizeConsentedAt: null,
    organizedBy: null, organizedByThisInstall: false, organizerState: null, status: null,
    junkFolder: null, sentFolder: null, smtpMaxSizeBytes: null, firstSyncStopFolder: null, ...over,
  });

  it("a consented reader was stopped; a reader who never consented was not", () => {
    const rows = [
      box({ id: "stood", organizerRole: "reader", organizeConsentedAt: "2026-07-01T00:00:00.000Z" }),
      box({ id: "never", organizerRole: "reader", organizeConsentedAt: null }),
      box({ id: "holds", organizerRole: "organizer", organizeConsentedAt: "2026-07-01T00:00:00.000Z" }),
      box({ id: "older", organizerRole: null, organizeConsentedAt: null }),
    ];
    expect(stoodDown(rows).map((m) => m.id)).toEqual(["stood"]);
  });
});

describe("the catch-up names no mailbox — organizing resumes on its own (mail 0135)", () => {
  it("the strip reads no roster, lists nothing and links nowhere", () => {
    const strip = read("src/ui/LifecycleStrip.tsx");
    expect(strip).not.toContain("readMailboxes");
    expect(strip).not.toContain("router.push");
    // Still no claim from here: a paused mailbox is resumed by the server, not by this strip.
    expect(strip).not.toContain("organizeHere");
  });

  it("both decks say since when, with no count, and neither says it will not take them again", () => {
    for (const [name, deck] of [["en", EN], ["de", DE]] as const) {
      const line = deck.stripCaughtUp("1 Sep 2026");
      expect(line, name).toContain("1 Sep 2026");
      expect(line.replace("1 Sep 2026", ""), `${name} carries a number`).not.toMatch(/\d/);
      const all = JSON.stringify(Object.values(deck).filter((v) => typeof v === "string"));
      expect(all, name).not.toContain("does not take them again");
      expect(all, name).not.toContain("nimmt sie nicht von selbst wieder");
    }
  });
});

/* ── the wire this phone reads back ────────────────────────────────────────────────────────── */

describe("GET /account/access, narrowed", () => {
  it("an unmetered host has no lifecycle and never will", () => {
    expect(accessOf({ metered: false })).toEqual({ metered: false });
    expect(accessOf(null)).toBeNull();
    expect(accessOf("nope")).toBeNull();
  });

  it("the refused arm carries the lifecycle, the link and the export path", () => {
    const a = accessOf({
      metered: true, canAddMailbox: false, mailboxes: 0, aiEnabled: false,
      lifecycle: CLOSED, manageUrl: "https://pay.example/x", exportPath: "/account/export",
    })!;
    expect(a.lifecycle?.state).toBe("closed");
    expect(a.exportPath).toBe("/account/export");
  });

  it("A CATCH-UP IS ITS DATE — no date, no notice; a count an older API sends is dropped", () => {
    // PHONE-CATCHUP-STRIP-READS-A-COUNT: this read required a count the API no longer sends.
    expect(accessOf({ metered: true, caughtUp: { count: 3 } })!.caughtUp).toBeUndefined();
    expect(accessOf({ metered: true, caughtUp: { since: "" } })!.caughtUp).toBeUndefined();
    expect(accessOf({ metered: true, caughtUp: { since: "2026-08-01T00:00:00.000Z" } })!.caughtUp)
      .toEqual({ since: "2026-08-01T00:00:00.000Z" });
    expect(accessOf({ metered: true, caughtUp: { since: "2026-08-01T00:00:00.000Z", count: 478 } })!.caughtUp)
      .toEqual({ since: "2026-08-01T00:00:00.000Z" });
  });

  it("the export's filename is dated, so two a month apart do not collide", () => {
    expect(exportFilename(new Date("2026-09-05T23:00:00.000Z")))
      .toMatch(/^ohmail-settings-2026-09-0\d\.json$/);
  });
});

describe("a date on this screen is the server's or nothing", () => {
  it("an absent or unreadable instant is the em dash, never today", () => {
    expect(dayStamp(null, "en")).toBe(NO_DATE);
    expect(dayStamp(undefined, "en")).toBe(NO_DATE);
    expect(dayStamp("", "en")).toBe(NO_DATE);
    expect(dayStamp("the day after tomorrow", "en")).toBe(NO_DATE);
  });

  it("a real instant reads as a date in the asked language", () => {
    expect(dayStamp("2026-08-24T10:00:00.000Z", "en", "UTC")).toContain("2026");
    expect(dayStamp("2026-08-24T10:00:00.000Z", "de", "UTC")).toContain("2026");
  });
});

/* ── the gate ──────────────────────────────────────────────────────────────────────────────── */

describe("the gate hands the screen to the wall, and only from a live session", () => {
  const live = { k: "live", session: {} as never } as ConnectionState;
  const lock: AccessRefusedFacts = { reason: "payment_required" };

  it("a live session with the lock up renders the wall, not the mail", () => {
    expect(gateFor(live, 1, lock)).toEqual({ to: "wall", facts: lock });
    expect(gateFor(live, 1, null)).toEqual({ to: "mail" });
  });

  it("EVERY EXISTING CALLER IS UNCHANGED — the third argument defaults to no wall", () => {
    expect(gateFor(live, 1)).toEqual({ to: "mail" });
    expect(gateFor({ k: "starting" }, 0)).toEqual({ to: "boot" });
  });

  it("no session, no wall — a screen about an account this phone is not on", () => {
    expect(gateFor({ k: "starting" }, 1, lock)).toEqual({ to: "boot" });
    expect(gateFor({ k: "idle" }, 0, lock)).toEqual({ to: "welcome" });
    expect(gateFor({ k: "connecting", origin: "https://x" }, 1, lock).to).toBe("connecting");
  });
});

/* ── the census: the components render what the modules answer ─────────────────────────────── */

describe("the census over the two screens", () => {
  it("EVERY line the wall can answer has a rendered sentence", () => {
    const wall = read("src/ui/AccountWall.tsx");
    for (const key of WALL_LINE_KEYS) {
      expect(wall, `${key} is answerable and nothing renders it`).toContain(`case "${key}":`);
    }
  });

  it("the wall renders no sentence of its own — everything comes off the deck", () => {
    const wall = read("src/ui/AccountWall.tsx");
    const source = ts.createSourceFile("AccountWall.tsx", wall, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const stray: string[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isJsxText(node) && node.text.trim() !== "") stray.push(node.text.trim());
      node.forEachChild(walk);
    };
    walk(source);
    expect(stray).toEqual([]);
  });

  it("both decks carry every key these screens read, and the German carries no eszett", () => {
    const keys = Object.keys(EN).filter((k) => k.startsWith("wall") || k.startsWith("strip"));
    expect(keys.length).toBeGreaterThan(25);
    for (const k of keys) {
      expect(DE, `the German deck is missing ${k}`).toHaveProperty(k);
    }
    const german = keys
      .map((k) => {
        const v = (DE as unknown as Record<string, unknown>)[k];
        return typeof v === "function" ? (v as (...a: never[]) => string)(1 as never, "1.1.2026" as never) : String(v);
      })
      .join("\n");
    expect(german).not.toContain("ß");
    // Informal register and the lower-case wordmark, both owner rulings.
    expect(german).not.toMatch(/\bSie\b|\bIhr(e|en|em)?\b/);
    expect(german).not.toContain("OhMail");
    expect(german).not.toContain("MailOh");
  });

  it("THE DECK IS THE BROWSER WALL'S, word for word, wherever the browser has the same sentence", () => {
    /* `copy.en.ts` claims this block is held against `accessLock`; this is the holding. The German
       differs only by Swiss `ss`. Two sentences are the phone's own: it HANDS OVER the file (a
       share sheet), where the browser downloads it. A key the browser does not carry is not read. */
    const OWN = new Set(["moveOutHint", "moveOutFailed"]);
    const catalogue = (lang: string): Record<string, string> =>
      (JSON.parse(fs.readFileSync(path.join(APP, `../webapp/messages/${lang}.json`), "utf8")) as {
        accessLock: Record<string, string>;
      }).accessLock;
    const said = (deck: object, key: string): string => {
      const v = (deck as Record<string, unknown>)[key];
      return typeof v === "function" ? (v as (d: string) => string)("{date}") : String(v);
    };
    const [en, de] = [catalogue("en"), catalogue("de")];
    const compared: string[] = [];
    for (const key of Object.keys(en)) {
      const phone = `wall${key[0]!.toUpperCase()}${key.slice(1)}`;
      if (OWN.has(key) || !(phone in EN)) continue;
      expect(said(EN, phone), `${phone} is not the browser's ${key}`).toBe(en[key]);
      expect(said(DE, phone), `${phone} (de) is not the browser's ${key}`).toBe(de[key]!.replace(/ß/g, "ss"));
      compared.push(key);
    }
    // A census that compared nothing would pass for a deck that shares no sentence at all.
    expect(compared.length).toBeGreaterThanOrEqual(18);
    for (const key of OWN) expect(en, `${key} left the browser catalogue`).toHaveProperty(key);
  });

  it("NO PRICE TOKEN ENTERS EITHER DECK — the store rule, over the strings themselves", () => {
    const forbidden = /(\$\d|€\d|\bEUR\b|\bUSD\b|\bper month\b|\bpro Monat\b|\bbuy\b|\bkaufen\b|\bPreis\b|\bprice\b)/i;
    for (const deck of [EN, DE]) {
      for (const [k, v] of Object.entries(deck)) {
        if (!k.startsWith("wall") && !k.startsWith("strip")) continue;
        const rendered = typeof v === "function"
          ? (v as (...a: never[]) => string)(2 as never, "1.1.2026" as never)
          : String(v);
        expect(rendered, `${k} carries a price token`).not.toMatch(forbidden);
      }
    }
  });

  it("THE STORE FACE'S OWN SENTENCE ASKS NOBODY TO SUBSCRIBE", () => {
    /**
     * The sentence a store build renders in place of the withheld button, in both decks. A store
     * copy may not carry a call to action towards a purchase page (App Review 3.1.1), and "open
     * the site to subscribe again" is one — so it names what a person can do with the account.
     * The SIDELOAD face's BUTTON keeps the browser wall's own word, which is the point of the
     * flag: the withholding is the sentence's, not the vocabulary's.
     */
    const plan = wallSays(facts(CLOSED), "store");
    expect(plan.openElsewhere).toBe("wallOpenInBrowser");
    expect(plan.actions.some((a) => a.id === "manage")).toBe(false);
    const purchase = /\b(subscribe|subscription|abo|abos|abonnement\w*)\b/i;
    for (const [name, deck] of [["en", EN], ["de", DE]] as const) {
      const sentence = String((deck as unknown as Record<string, unknown>).wallOpenInBrowser);
      expect(sentence, `the ${name} store sentence sends somebody to buy`).not.toMatch(purchase);
      expect(sentence, `the ${name} store sentence names no site`).toContain("ohmail.app");
    }
  });

  it("neither screen opens a page anywhere but the SYSTEM browser", () => {
    for (const rel of ["src/ui/AccountWall.tsx", "src/ui/LifecycleStrip.tsx"]) {
      const src = read(rel);
      // No in-app browser, no WebView, no purchase module: every outbound press is `Linking`.
      expect(src).toContain("Linking.openURL");
      expect(src).not.toMatch(/WebBrowser|WebView|InAppPurchase|react-native-iap/);
    }
  });

  it("the export's busy word is its own, and both decks carry it", () => {
    /* The button read "Signing in…" while it made the export file — a borrowed label is a false
       sentence the moment it is rendered somewhere else. The wall may only borrow nothing here. */
    const src = read("src/ui/AccountWall.tsx");
    expect(src).toContain("Copy.wallMoveOutBusy");
    expect(src).not.toContain("signInAgainSaving");
    for (const [name, deck] of [["en", EN], ["de", DE]] as const) {
      const word = (deck as unknown as Record<string, unknown>).wallMoveOutBusy;
      expect(typeof word, `the ${name} deck's busy word`).toBe("string");
      expect(String(word).length).toBeGreaterThan(0);
    }
  });
});
