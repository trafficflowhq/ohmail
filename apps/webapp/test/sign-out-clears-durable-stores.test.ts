/** @vitest-environment jsdom */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dropLocalStorageKeys } from "../app/shell/boot-cache";
import { COMPOSE_DRAFT_PREFIX, COMPOSE_ROW_PREFIX, COMPOSE_SESSION_PREFIX, LEGACY_COMPOSE_DRAFT_KEY } from "../app/shell/compose";
import { REPLY_DRAFT_PREFIX, REPLY_META_PREFIX } from "../app/shell/mail-send";
import { NOTIFICATION_SUBSCRIPTION_PREFIX } from "../app/shell/notification-settings";
import { SCREENER_INTENTS_PREFIX } from "../app/shell/screener-intents";
import { DELETE_INTENTS_PREFIX } from "../app/shell/delete-intents";
import { ROUTING_INTENTS_PREFIX } from "@ohmail/client-engine";
import { SEND_LOCKS_PREFIX } from "../app/shell/send-lock";
import { READING_ALONG_PREFIX } from "../app/shell/reading-along";
import { SESSION_ANSWER_KEY, SESSION_ATTEMPT_KEY, SESSION_MINTED_KEY } from "../app/session-refresh";
import { ACCESS_VERDICT_PREFIX } from "../app/shell/wall-lift";
import { ERASED_KEY } from "../app/shell/account-erased";
import { SHARED_NOTE_KEY } from "../app/(product)/resume/signed-out-note";

/**
 * SIGN-OUT HAS TO REACH THE DURABLE-DECISION STORES, NOT JUST THE MIRROR AND THE BOOT CACHES.
 *
 * The durability slice moved three user decisions out of memory and onto disk so they survive a
 * crash — the send lanes, the Screener's intent journal, and the compose scratch buffer — and
 * `mail-send.ts` had already put the reply body and its editor metadata there. All of them are
 * `localStorage`. None of them starts with `ohmail.boot.`, which was the only prefix sign-out
 * swept, so sign-out left every one of them behind while `sign-out.ts`'s own header claimed it
 * "closes the other half — what is left behind at rest".
 *
 * What that meant concretely: an unfinished message and an unsent reply are MAIL TEXT, readable
 * on a shared machine by the next person, after the one who signed out believed they had left
 * nothing. A journalled Screener decision would replay on a later sign-in. A send lane would
 * outlive the session whose key it holds.
 *
 * Owner-keying was never the fix for this by itself, and that is the trap worth naming: the
 * compose buffer WAS owner-keyed precisely so sign-out could reach it, and sign-out was simply
 * never taught the prefix. The reply buffers are worse — keyed by message id and lane, never by
 * owner, so they were never account-scoped at all.
 */

/* Not `import.meta.url`: this file runs under jsdom, where that is an http URL and
 * `fileURLToPath` refuses it. Resolved from the cwd instead, which is the repo root under the
 * root vitest config and `apps/webapp` if the app is run on its own. */
const APP = existsSync(resolve("apps/webapp/app")) ? resolve("apps/webapp/app") : resolve("app");

/**
 * THE ENGINE'S BROWSER MODULES ARE IN SCOPE TOO, and the census was blind to them.
 *
 * `localStorage` belongs to the ORIGIN, not to a directory. The client engine runs inside this
 * app, on this origin, and its browser arm writes a key of its own — so a key added there was
 * exactly the "new key nobody decided about" this census exists to refuse, and the census could
 * not see it. Absent (a webapp run outside the monorepo), the sweep below simply covers less,
 * which is the same reach it had before.
 */
const ENGINE = resolve("packages/client-engine/src");

/** Prefixes sign-out sweeps, as sign-out itself names them. */
const SWEPT = [
  "ohmail.boot.",
  SEND_LOCKS_PREFIX,
  SCREENER_INTENTS_PREFIX,
  DELETE_INTENTS_PREFIX,
  ROUTING_INTENTS_PREFIX,
  COMPOSE_DRAFT_PREFIX,
  COMPOSE_SESSION_PREFIX,
  COMPOSE_ROW_PREFIX,
  LEGACY_COMPOSE_DRAFT_KEY,
  REPLY_DRAFT_PREFIX,
  REPLY_META_PREFIX,
  NOTIFICATION_SUBSCRIPTION_PREFIX,
  READING_ALONG_PREFIX,
  SESSION_MINTED_KEY,
  SESSION_ATTEMPT_KEY,
  SESSION_ANSWER_KEY,
  ACCESS_VERDICT_PREFIX,
  ERASED_KEY,
  SHARED_NOTE_KEY,
];

/**
 * Keys that DELIBERATELY survive sign-out, each with the reason it is not account data.
 *
 * This list is the point of the census below. A new `localStorage` key in this app is either
 * account data — in which case sign-out must reach it — or a per-browser preference, in which
 * case somebody has to say so here on purpose. Silence is what produced the defect above.
 */
const SURVIVES_SIGN_OUT = new Set([
  "ohmail.locale", // the language this browser reads in; not account data
  "ohmail.theme", // light/dark; not account data
  "ohmail.face", // this DEVICE's paper/ohmarchy pin ("only this device"); not account data
  "ohmail.layout", // this device's layout pin — ohmail.face's contract, other axis
  "ohmail.textSize", // Settings → Text size, per device: a fact about this screen, not the account
  "ohmail.demo-ribbon", // landing-page demo affordance
  "ohmail.desktopCtaDismissed", // "you dismissed this banner"; a browser preference
  "ohmail.junkSweepDismissedAt", // a dismissal timestamp, no mail in it
  "ohmail.ui.seed.notNow.", // "Not now" on the sent-mail review, owner-keyed, no mail in it
  "ohmail.reply.panelHeight", // a pane size
  "ohmail.ui.mail.original", // "show original" toggle
  "ohmail.ui.rail.foldersOpen", // rail disclosure state
  "ohmail.ui.rail.foldersOpened",
  "ohmail.ui.rail.tagsOpen",
  "ohmail.ui.columns", // the three columns' widths — a fact about the screen, not the mailbox
  "ohmail.ui.search.sort.", // a sort preference, owner-keyed but not content
  "ohmail.ui.reader.afterVerb", // what the pane does after a verb — `ui.search.sort.`'s class exactly
  // A per-TAB composer id in sessionStorage, naming no account: the compose keys it suffixes carry
  // the storage owner and are swept by their prefixes, so the next account in this tab starts on its own.
  "ohmail.compose.composer",
  /*
   * `ohmail.notifications.channels` — the four notification switches, and the one key of that
   * family that stays.
   *
   * Its module rules the reach as `install` and argues it at length: whether a notice may be
   * drawn at all is the OS's answer, per device, and it cannot be carried anywhere — "a phone
   * that granted permission says nothing about a laptop that refused". That makes this the same
   * class as `ohmail.theme` and `ohmail.face`: a fact about this machine, not about an account,
   * and signing out does not change what this machine is allowed to do.
   *
   * Its two siblings are NOT this and are swept — see `NOTIFICATION_SUBSCRIPTION_PREFIX` in
   * `SWEPT`. The endpoint is the one that decided it: a URL a push service will deliver to,
   * minted inside a signed-in session, which on a shared machine is the case this census exists
   * for. The switches carry no address and name no account.
   */
  "ohmail.notifications.channels",
  /*
   * `ohmail.updateAsked` — when this SCREEN last said "a newer ohmail is available", per release
   * or build (`app/shell/app-update.ts`).
   *
   * It carries no address, names no account and describes no mail: it is a record of how often
   * this app has interrupted whoever is at this keyboard about its OWN version. Sweeping it would
   * turn signing out and back in into a way to be asked again, which is the nagging the
   * once-a-day rule exists to prevent — and the strip is the same sentence for every person who
   * ever opens this browser, because the newer build is a fact about the origin, not about them.
   * Same class as `ohmail.theme` and `ohmail.face`: a fact about this machine.
   */
  "ohmail.updateAsked",
  /*
   * `ohmail.signup.plan` — the plan and interval a person chose on the site before any account
   * existed (`app/plan-hint.ts`), kept through the signup's mail round trip. No address, no account,
   * no mail: a preselection hint, forgotten once the trial starts and ignored after a week.
   */
  "ohmail.signup.plan",
]);

/**
 * Keys swept by a path other than `dropLocalStorageKeys` — named here so the census can see the
 * decision rather than the mechanism.
 *
 * `ohmail.mirror.<name>` is the mirror-name registry (`client-engine/src/idb.ts`): the list of
 * IndexedDB databases this origin has opened, kept because a browser without
 * `IDBFactory.databases()` cannot be asked what it holds and sign-out would otherwise report an
 * all-clear over an earlier account's mail it never named. It is swept by `clearAllMirrors`
 * ITSELF, which removes every name it proved gone — deliberately NOT by the prefix sweep, because
 * a blocked wipe must KEEP the names it could not delete or the next attempt has nothing to try.
 *
 * It is a PREFIX now, one key per mirror name, because a single JSON array was a cross-tab
 * read-modify-write: two tabs first-opening different mirrors both read the same list and the
 * second write erased the first's name — ordinary multi-tab use, defeating the registry's one
 * purpose on exactly the browsers it exists for.
 */
const SWEPT_ELSEWHERE = new Set([
  "ohmail.mirror.",
  /*
   * `ohmail.deviceCeremony` — the in-flight Microsoft device-code ceremony's HANDLE, and the first
   * `sessionStorage` entry this census has had to rule on.
   *
   * It IS swept by `signOut`, but not through `dropLocalStorageKeys`: it lives in `sessionStorage`
   * (per tab, matching a fifteen-minute grant far better than a store that outlives the browser),
   * so the prefix sweep this census checks cannot reach it and a `SWEPT` entry would be a false
   * claim about which mechanism removes it. `sign-out.ts` calls `sessionStorage.removeItem` for it
   * directly and reports a refusal through `remaining` / `inventoryComplete`, exactly as the
   * localStorage sweep does.
   *
   * The residue it could leave is a lookup handle, a Microsoft URL, and a one-time code Microsoft
   * minted — no credential; the `device_code` that redeems the grant never leaves the server. And
   * the load-bearing guard is not this sweep at all: the reader refuses any record whose stored
   * account id is not the signed-in one, so another account's ceremony is unrenderable even if the
   * entry survives.
   */
  "ohmail.deviceCeremony",
  // `ohmail.accessHandoff` — the wall's per-tab note that the hand-off was pressed (an account id
  // and a time, so the return polls). `sessionStorage`, removed by `signOut` beside the ceremony.
  "ohmail.accessHandoff",
  // `ohmail.session.lateWatch.<owner>` — the tab's late-answer watch note (a mark, a renewal's name,
  // a time, the account). `sessionStorage`, removed by `signOut` through `forgetLateAnswerWatch`.
  "ohmail.session.lateWatch.",
  // `ohmail.session.splashOut` — the resume splash's note that its renewal is out (a time, the jar's
  // mark, the account). `sessionStorage`, removed by `signOut` through `forgetSplashPresentation`.
  "ohmail.session.splashOut",
  /*
   * `ohmail.intent-windows` — NOT A STORED KEY AT ALL, and the second entry this census has had to
   * rule on for that reason.
   *
   * It is a `BroadcastChannel` name (`shell/intent-windows.ts`): the bus one tab uses to say it is
   * holding a Screener undo window open, so another tab does not commit it. A channel holds no
   * state, so there is nothing for a sweep to remove and a `SWEPT` entry would be a false claim
   * about a mechanism. It is scanned here only because its own module mentions `localStorage` while
   * explaining that a channel is per ORIGIN in the same way — which is also why it carries the
   * storage-owner suffix the four key builders spell: two accounts on one browser must not trade claims.
   */
  "ohmail.intent-windows",
  /*
   * `ohmail.signed-out` — the channel a signing-out tab tells the account's other tabs on
   * (`app/signed-out-signal.ts`). Holds no state; where a browser has no `BroadcastChannel` it is a
   * storage key written and removed in the same call, so a storage event carries the message and
   * nothing is left for a sweep to find.
   */
  "ohmail.signed-out",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const abs = `${dir}/${name}`;
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.tsx?$/.test(name)) out.push(abs);
  }
  return out;
}

describe("sign-out clears the durable decision stores", () => {
  beforeEach(() => window.localStorage.clear());

  it("ANSWERS the keys it could not remove — a refused removal is not a clean sweep", () => {
    // `dropLocalStorageKeys` returned `void` and swallowed every failure, so a `removeItem` that
    // refused was indistinguishable from one that worked and `signOut` earned its clean verdict
    // over message text still readable on a shared machine. These prefixes hold MAIL.
    const stubborn = `${COMPOSE_DRAFT_PREFIX}acct-a`;
    const map = new Map<string, string>([
      [stubborn, "an unfinished message"],
      [`${REPLY_DRAFT_PREFIX}msg-1`, "an unsent reply body"],
    ]);
    /**
     * THE WHOLE OBJECT IS REPLACED, not spied on. jsdom's `Storage` is proxy-backed and routes
     * property WRITES to `setItem`, so `vi.spyOn(window.localStorage, "removeItem")` stores an
     * ITEM called "removeItem" and the real method keeps running — the mock silently does
     * nothing, and the test passes for the wrong reason. Found by watching it pass against a
     * refusal that never happened.
     */
    const held = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        get length() { return map.size; },
        key: (i: number) => [...map.keys()][i] ?? null,
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => {
          if (k === stubborn) throw new Error("storage refused");
          map.delete(k);
        },
        clear: () => map.clear(),
      } as Storage,
    });
    try {
      const left = dropLocalStorageKeys([COMPOSE_DRAFT_PREFIX, REPLY_DRAFT_PREFIX]);
      expect(left.survivors, "the survivor is named").toEqual([stubborn]);
      expect(left.enumerated, "the jar was walked, so the list means something").toBe(true);
      // One refusal must not spare the rest.
      expect(map.get(`${REPLY_DRAFT_PREFIX}msg-1`)).toBeUndefined();
      expect(map.get(stubborn)).toBe("an unfinished message");
    } finally {
      if (held) Object.defineProperty(window, "localStorage", held);
    }
  });

  it("a jar that cannot be WALKED says so, instead of naming no survivors", () => {
    // The catch returned an empty list and a comment claiming "nothing was ever cached there",
    // which is a statement about a jar this call could not open. The caller read it as a clean
    // sweep, so a browser that refused to enumerate localStorage during a sign-out certified a
    // clean browser over every draft still in it, readable again the moment storage came back.
    const held = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { get length(): number { throw new Error("storage blocked"); },
        key: () => null, getItem: () => null, setItem: () => undefined,
        removeItem: () => undefined, clear: () => undefined } as unknown as Storage,
    });
    try {
      const out = dropLocalStorageKeys([COMPOSE_DRAFT_PREFIX]);
      expect(out.survivors).toEqual([]);
      expect(out.enumerated, "an unreadable jar is not an empty one").toBe(false);
    } finally {
      if (held) Object.defineProperty(window, "localStorage", held);
    }
  });

  it("removes every one of them, for every owner, plus the legacy un-owned key", () => {
    const jar: Record<string, string> = {
      [`${SEND_LOCKS_PREFIX}acct-a`]: "[]",
      [`${SEND_LOCKS_PREFIX}local`]: "[]",
      [`${SCREENER_INTENTS_PREFIX}acct-a`]: "[]",
      // A scheduled DELETE, which is the same class of thing one verb along: left behind, the
      // next account on this browser replays it against a mailbox that is not theirs.
      [`${DELETE_INTENTS_PREFIX}acct-a`]: "[]",
      [`${ROUTING_INTENTS_PREFIX}acct-a`]: "[]",
      [`${COMPOSE_DRAFT_PREFIX}acct-a`]: "an unfinished message",
      // The id naming the message that buffer holds. Left behind it would name a
      // message-in-progress that has been swept — an identity for mail that is no longer there.
      [`${COMPOSE_SESSION_PREFIX}acct-a`]: "sess-1",
      // The draft row that session was holding — an id on the DEPARTED account.
      [`${COMPOSE_ROW_PREFIX}acct-a`]: "draft-of-the-account-that-left",
      [LEGACY_COMPOSE_DRAFT_KEY]: "an older unfinished message",
      [`${REPLY_DRAFT_PREFIX}msg-1`]: "an unsent reply body",
      [`${REPLY_META_PREFIX}lane-1`]: "{}",
      "ohmail.boot.acct-a.piles": "{}",
    };
    for (const [k, v] of Object.entries(jar)) window.localStorage.setItem(k, v);
    // A preference that must SURVIVE, so the sweep is shown to be bounded rather than a wipe.
    window.localStorage.setItem("ohmail.locale", "de");

    dropLocalStorageKeys(SWEPT);

    for (const key of Object.keys(jar)) expect(window.localStorage.getItem(key)).toBeNull();
    expect(window.localStorage.getItem("ohmail.locale")).toBe("de");
  });

  it("is wired into signOut itself, not merely available", () => {
    // A correct helper with no caller is what the previous version of this defect looked like.
    const src = readFileSync(`${APP}/sign-out.ts`, "utf8");
    expect(src).toContain("dropLocalStorageKeys(");
    for (const name of [
      "SEND_LOCKS_PREFIX",
      "SCREENER_INTENTS_PREFIX",
      "DELETE_INTENTS_PREFIX",
      "ROUTING_INTENTS_PREFIX",
      "COMPOSE_DRAFT_PREFIX",
      "COMPOSE_SESSION_PREFIX",
      "COMPOSE_ROW_PREFIX",
      "LEGACY_COMPOSE_DRAFT_KEY",
      "REPLY_DRAFT_PREFIX",
      "REPLY_META_PREFIX",
      "NOTIFICATION_SUBSCRIPTION_PREFIX",
      "READING_ALONG_PREFIX",
      "SESSION_MINTED_KEY",
      "SESSION_ATTEMPT_KEY",
      "SESSION_ANSWER_KEY",
      "ACCESS_VERDICT_PREFIX",
      "SHARED_NOTE_KEY",
      "ERASED_KEY",
    ]) {
      expect(src, `${name} must be in sign-out's sweep`).toContain(name);
    }
    /*
     * …AND INSIDE THE SWEEP'S OWN ARGUMENT LIST, which is the half the line above cannot check.
     *
     * Every name here is also an IMPORT, so `toContain` over the whole file matches whether or not
     * the prefix was ever handed to `dropLocalStorageKeys`. Measured: deleting
     * `NOTIFICATION_SUBSCRIPTION_PREFIX` from the sweep list left this file green — the import and
     * a comment kept the string present, and the census above reads its own `SWEPT` constant
     * rather than the code. A guard that cannot fail was how the three notification keys got past
     * this census in the first place, so the argument list is read directly.
     */
    // The call is `sweepFor(…, [list])` since the erased-account door narrows the same list to
    // one account; `sign-out.test.ts` pins that the whole sweep still goes through
    // `dropLocalStorageKeys`, and the list is read here exactly as before.
    const call = src.slice(
      src.indexOf("const durable = sweepFor("),
      src.indexOf("]);", src.indexOf("const durable = sweepFor(")),
    );
    expect(call, "the sweep call must exist").toContain("const durable = sweepFor(");
    for (const name of [
      "SEND_LOCKS_PREFIX",
      "SCREENER_INTENTS_PREFIX",
      "DELETE_INTENTS_PREFIX",
      "ROUTING_INTENTS_PREFIX",
      "COMPOSE_DRAFT_PREFIX",
      "COMPOSE_SESSION_PREFIX",
      "COMPOSE_ROW_PREFIX",
      "LEGACY_COMPOSE_DRAFT_KEY",
      "REPLY_DRAFT_PREFIX",
      "REPLY_META_PREFIX",
      "NOTIFICATION_SUBSCRIPTION_PREFIX",
      "READING_ALONG_PREFIX",
      "SESSION_MINTED_KEY",
      "SESSION_ATTEMPT_KEY",
      "SESSION_ANSWER_KEY",
      "ACCESS_VERDICT_PREFIX",
      "SHARED_NOTE_KEY",
    ]) {
      expect(call, `${name} is imported but never handed to the sweep`).toContain(`\n    ${name},`);
    }
  });

  /**
   * ── THE HALF OF THE COMPOSE ROW THAT IS NOT IN A JAR ──────────────────────────────────────
   *
   * A browser refusing this app its storage remembers the row the composer opened IN MEMORY for
   * the life of the tab, because otherwise `readComposeRow` answers `null` by construction and the
   * autosave mints a second row beside the one that was opened. Every reason `COMPOSE_ROW_PREFIX`
   * is swept applies to that memory: left behind, the next sign-in's composer holds a row id on
   * the departed account. Driven, not read — a call in the source proves nothing about the value.
   *
   * Mutation: drop `forgetComposeRows()` from the sweep. Real failure text:
   *   AssertionError: the row remembered for a jar-less browser survived the sign-out …
   */
  it("the renewal name's own IndexedDB database goes with the browser's copy", async () => {
    const engine = existsSync(resolve("packages/client-engine/package.json"))
      ? resolve("packages/client-engine/package.json") : resolve("../../packages/client-engine/package.json");
    const { IDBFactory } = createRequire(engine)("fake-indexeddb") as { IDBFactory: new () => IDBFactory };
    (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
    const answered = globalThis.fetch;
    globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const refresh = await import(`${APP}/session-refresh.ts`);
      const held = async (): Promise<string[]> =>
        (await indexedDB.databases()).map((d) => d.name ?? "").filter((n) => n === refresh.SESSION_ATTEMPT_DB);
      expect(await refresh.resumeSession(), "a renewal nobody answered keeps its name").toBe("unavailable");
      expect(await held(), "the control: the name is in IndexedDB").toHaveLength(1);
      const { forgetThisBrowser } = await import(`${APP}/sign-out.ts`);
      const out = await forgetThisBrowser();
      expect(await held(), "a renewal name survived the sign-out").toEqual([]);
      expect(out.remaining).not.toContain(refresh.SESSION_ATTEMPT_DB);
    } finally {
      warned.mockRestore();
      globalThis.fetch = answered;
      Reflect.deleteProperty(globalThis, "indexedDB");
    }
  });

  it("signOut forgets the row a jar-less browser was remembering", async () => {
    const { writeComposeRow, readComposeRow, forgetComposeRows } =
      await import(`${APP}/shell/compose.ts`);
    const jar = Object.getOwnPropertyDescriptor(window, "localStorage");
    const refuse = (): never => { throw new DOMException("denied", "SecurityError"); };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => ({
        getItem: refuse, setItem: refuse, removeItem: refuse, clear: refuse, key: refuse,
        get length(): number { return refuse(); },
      }),
    });
    try {
      forgetComposeRows();
      writeComposeRow("d-departed");
      expect(readComposeRow(), "the row is not remembered at all").toBe("d-departed");
      const src = readFileSync(`${APP}/sign-out.ts`, "utf8");
      expect(
        src,
        "the sweep does not forget the remembered row, so it survives into the next sign-in",
      ).toContain("forgetComposeRows()");
      /* And the call does what the name says, driven through the real function. */
      forgetComposeRows();
      expect(
        readComposeRow(),
        "the row remembered for a jar-less browser survived the sign-out — an id on the departed "
        + "account, held by the next account's composer",
      ).toBeNull();
    } finally {
      if (jar !== undefined) Object.defineProperty(window, "localStorage", jar);
    }
  });

  it("the wake registration is revoked BEFORE the session that authorizes the delete is gone", () => {
    /*
     * THE ORDER IS THE FIX, not the call.
     *
     * The server's own sign-out prune is DEVICE-scoped — `logout` reads the session's `device_id`
     * and deletes the push rows carrying it — and a browser ceremony mints no device row
     * (`session-lifecycle.ts`'s `AUTO_MINT_DEVICE_LABELS` covers only the desktop kinds, and
     * `auth-service.test.ts` asserts the exchanged web session's `deviceId` is null through the
     * real ceremony). So the browser's row is deviceless, the prune returns early, and the row
     * survives the sign-out while the sender goes on POSTing wakes to its endpoint — a signed-out
     * shared browser woken for the previous account's mail.
     *
     * This browser is the only party that can name that row, and the credential that authorizes
     * `DELETE /push/subscriptions/:id` is the very session `auth.logout()` revokes. Called after
     * it, the delete answers 401 for ever. Asserted on the SOURCE and by POSITION, because a call
     * in the right place and a call in the wrong place are the same call.
     */
    const src = readFileSync(`${APP}/sign-out.ts`, "utf8");
    /* THE CALL, NOT A CALLER'S SPELLING, AND NOT IN A COMMENT. `await revokeWakeRegistration();`
     * pinned the `await` and the semicolon, which is today's caller: a worker census read
     * `await runSyncCycle(` the same way, the call moved inside a store lane, and it read zero
     * hosts and passed for hours. Asking for the call alone then found `auth.logout()` in the
     * DOCBLOCK that explains the ordering — this file names it three times in prose — so the
     * comments are blanked first, offsets preserved, and the positions are the code's. */
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
    const revoke = code.indexOf("revokeWakeRegistration(", code.indexOf("export async function signOut"));
    const logout = code.indexOf("auth.logout(");
    expect(revoke, "signOut must revoke the wake registration").toBeGreaterThan(-1);
    expect(logout, "…and still log out").toBeGreaterThan(-1);
    expect(revoke, "the delete is authenticated by the session logout revokes").toBeLessThan(logout);
    // And the erasure door reaches it too — `forgetThisBrowser` is the half account deletion
    // calls, and it must revoke BEFORE the sweep takes the id that names the row.
    const forget = code.indexOf("export async function forgetThisBrowser");
    const inForget = code.indexOf("revokeWakeRegistration(", forget);
    expect(inForget, "the erasure door must revoke as well").toBeGreaterThan(forget);
    expect(inForget, "…while the id that names the row is still readable")
      .toBeLessThan(code.indexOf("NOTIFICATION_SUBSCRIPTION_PREFIX", forget));
    /*
     * …AND `signOut` OPTS OUT OF THE SECOND ONE. Found by review: by the time `signOut` reaches
     * `forgetThisBrowser`, `auth.logout()` has revoked the session, so a second revoke re-issues
     * `DELETE /push/subscriptions/:id` against a dead credential — which the API client reads as
     * recoverable, burning an `/auth/refresh` round trip before it fails. Two more network awaits
     * on exactly the flaky-network sign-out the budget exists for. The CALL SITE stays, so the
     * erasure door keeps its own revoke; only the redundant run is skipped.
     */
    /* The call site stays and the option is passed; matched as two facts rather than as one
       literal, because the call grew a second option (`serverHeld`) and a spelling match would
       have read an ordinary addition as a removed call site. */
    expect(src, "the second revoke must be skipped, not the call site removed")
      .toMatch(/forgetThisBrowser\(owner, \{[\s\S]{0,200}?revokeWake: false/);
    expect(src, "…and the erasure door must still revoke by default")
      .toContain("if (opts.revokeWake !== false) await revokeWakeRegistration();");
  });

  it("signOut removes the device-ceremony handle, and ANSWERS a refusal", () => {
    // The sweep is in `signOut` itself, not merely available — the shape the wired-in test above
    // checks for the localStorage prefixes, applied to the one sessionStorage entry.
    const src = readFileSync(`${APP}/sign-out.ts`, "utf8");
    expect(src).toContain('sessionStorage.removeItem("ohmail.deviceCeremony")');
    // …and the wall's hand-off note beside it, reported the same way.
    expect(src).toMatch(/sessionStorage\.removeItem\(HANDOFF_KEY\);\s+\} catch \{\s+deviceCeremonySwept = false;/);
    // …and a refused removal is REPORTED rather than earning a clean verdict, which is the whole
    // lesson of this file's first test.
    expect(src).toContain("deviceCeremonySwept");
    expect(src).toMatch(/inventoryComplete[\s\S]{0,200}deviceCeremonySwept/);
  });

  it("a stored ceremony is bound to its ACCOUNT, so a reused tab cannot render another's code", () => {
    /*
     * FOUND BY REVIEW on the fix that introduced the persistence. A tab is not a session: sign out,
     * or erase the account, and sign in as somebody else inside the fifteen minutes a grant lives,
     * and this tab's storage still holds the previous account's record. Restoring it with no owner
     * check paints THEIR code and verification URI on the new account's settings pane — the server
     * would refuse the poll with a 403, but only after the values were already on screen.
     *
     * Asserted on the SOURCE because the reader is module-private to the pane. What matters is that
     * the record carries an account id, that the reader compares it, and that a mismatch discards
     * the entry rather than merely declining to use it.
     */
    const src = readFileSync(`${APP}/(product)/mailbox/MailboxSection.tsx`, "utf8");
    expect(src, "the stored record must carry its owner").toMatch(/accountId: string;/);
    expect(src, "the reader must compare the stored owner to the signed-in one")
      .toContain("d.accountId !== accountId");
    // A mismatch DELETES: leaving it would keep another account's record in a shared machine's tab
    // until somebody happened to open this pane again.
    expect(src).toMatch(/d\.accountId !== accountId\)\s*\{\s*forgetDevice\(\);/);
    // And the restore is gated on the account being KNOWN — a null owner never matches, which is
    // the fail-closed direction. The stage joined that line for a second reader (the connect form
    // must not have a live code restored underneath it) and is pinned here so neither is dropped.
    expect(src).toContain('if (!deviceAvailable || !accountId || stage !== "list") return;');
  });

  it("the record is only ever WRITTEN with a real owner, so the restore cannot delete a live one", () => {
    /*
     * FOUND BY REVIEW, third round. The pane makes three independent reads on mount and the Outlook
     * affordance is enabled by the availability one, so a ceremony can legitimately start before the
     * session read lands. Stamping whatever `accountId` held at that moment wrote an EMPTY owner —
     * and the restore effect then read that record back, could not match it, and deleted it, while
     * the in-memory poll loop carried on. The ceremony worked and the reload recovery was gone.
     *
     * The guard is that there is exactly ONE writer and it is gated on both facts, so a record with
     * an empty owner is unrepresentable rather than merely unlikely.
     */
    const src = readFileSync(`${APP}/(product)/mailbox/MailboxSection.tsx`, "utf8");
    /*
     * THE INVARIANT IS "EVERY WRITE IS OWNER-GUARDED", not "there is exactly one write".
     *
     * An earlier version of this test asserted the start path must not persist at all, which was
     * the right property for the wrong reason and pushed the code into a passive effect as the sole
     * writer — reopening the recovery gap it was meant to close, because an effect runs after the
     * browser has been yielded to and a reload in that window loses the handle. There are now two
     * paths deliberately (synchronous for the ordinary case, the effect for a late session read),
     * so what has to hold is that NEITHER can write an owner it does not have.
     */
    const calls = [...src.matchAll(/^.*rememberDevice\(\{[^\n]*$/gm)].map((m) => m[0]!.trim());
    expect(calls.length, "expected the two deliberate persistence paths").toBe(2);
    for (const c of calls) {
      expect(c, `an unguarded write: ${c}`).toMatch(/accountId(:| )/);
    }
    // The synchronous one is guarded inline; the effect one by an early return above it.
    expect(src, "the synchronous write must be gated on a known owner")
      .toContain("if (owner) rememberDevice({ ...live, accountId: owner });");
    /*
     * …and it must read the storage owner through the REF, not the render-time state. `startDeviceFlow`
     * awaits a network round trip, and the session read can resolve during it — the very ordering
     * this guard exists for, since a different read enables the button. A closure holding the
     * render-time `accountId` would skip the synchronous write on exactly that path.
     */
    expect(src, "the async write must read the LATEST owner, not the captured one")
      .toContain("const owner = accountIdRef.current;");
    expect(src, "the ref must be written before the state it mirrors")
      .toMatch(/accountIdRef\.current = user\.accountId;\s*\n\s*setAccountId\(user\.accountId\);/);
    expect(src, "the late-session write must be gated on a known owner")
      .toMatch(/if \(!device \|\| !accountId\) return;\s*\n\s*rememberDevice\(\{ \.\.\.device, accountId \}\);/);
  });

  it("a TERMINAL poll failure is shown outside the ceremony block it destroys", () => {
    /*
     * The ceremony's own error line lives inside the ceremony's markup, so setting it and nulling
     * `device` in the same tick unmounted the container and the message with it — the code vanished
     * with nothing said. A terminal refusal therefore goes to the pane-wide `error`, which outlives
     * the block; a transient one stays on the ceremony's line, where the loop is still running.
     */
    const src = readFileSync(`${APP}/(product)/mailbox/MailboxSection.tsx`, "utf8");
    const terminal = src.slice(
      src.indexOf('if (codeOf(err) === "oauth_device_state_invalid"'),
      src.indexOf("setDevicePollError(messageOf(err));", src.indexOf('if (codeOf(err) === "oauth_device_state_invalid"')),
    );
    expect(terminal, "a terminal failure must reach the pane-wide error").toContain("setError(messageOf(err))");
    expect(terminal, "…and must not be left only on the line it is about to unmount")
      .toContain("setDevicePollError(null)");
  });

  /**
   * THE CENSUS — the guard that stops the NEXT store being forgotten.
   *
   * Every `ohmail.*` localStorage key literal in the app is either swept by sign-out or named in
   * `SURVIVES_SIGN_OUT` with a reason. A new key is a deliberate decision either way; what is not
   * allowed is a new key that nobody decided about, which is exactly how five of these were left
   * behind.
   */
  it("every localStorage key in the app is either swept or deliberately exempt", () => {
    const undecided: string[] = [];
    const files = [...walk(APP), ...(existsSync(ENGINE) ? walk(ENGINE) : [])];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("localStorage")) continue;
      for (const m of src.matchAll(/["`](ohmail\.[A-Za-z0-9._:-]*)/g)) {
        const key = m[1]!;
        if (key === "ohmail.app") continue; // the hostname, not a key
        const swept = SWEPT.some((p) => key.startsWith(p) || p.startsWith(key));
        const exempt = [...SURVIVES_SIGN_OUT, ...SWEPT_ELSEWHERE]
          .some((e) => key.startsWith(e) || e.startsWith(key));
        if (!swept && !exempt) undecided.push(`${file}: ${key}`);
      }
    }
    expect(
      [...new Set(undecided)].sort(),
      "a new localStorage key must be swept by sign-out or listed in SURVIVES_SIGN_OUT with its reason",
    ).toEqual([]);
  });
});
