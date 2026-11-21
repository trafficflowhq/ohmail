/** @vitest-environment jsdom */
/**
 * SIGNING OUT IN ONE TAB ENDS THE SESSION IN EVERY TAB OF THIS BROWSER.
 *
 * Measured on Cloud 0.25.2: two tabs on one account, Sign out in tab 0 emptied the jar and the
 * local databases, and tab 1 went on showing the whole Ohbox from memory — and message bodies on a
 * view switch — until it was reloaded. Two real `CloudShell`s share one jar, one wire and Node's
 * real `BroadcastChannel` here; the leave seam stands in for a navigation jsdom cannot make.
 */
import { fireEvent, within } from "@testing-library/react";
import * as shell from "./fixtures/cloud-confirm-shell";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSessionTruthForTests } from "@ohmail/app-logic/session/session-truth";
import { readOwnerMarker } from "@ohmail/app-logic/storage/owner-cookie";
import {
  holdSignedOutLeave, listenSignedOut, postSessionChange, postSignedOut, setSignedOutLeaveForTest, setThisTabForTest, signedOutChannel,
} from "../app/signed-out-signal";
import { JAR_WATCH_MS, SESSION_FRESH_MS } from "../app/(product)/mailbox/useSignedOutElsewhere";

/** Runs once, right before the next listener subscribes: the jar written between a tab's first frame and its listener. */
const seam = vi.hoisted(() => ({ beforeListen: null as (() => void) | null }));
vi.mock("../app/signed-out-signal", async (importOriginal) => {
  const real = await importOriginal<typeof import("../app/signed-out-signal")>();
  return {
    ...real,
    listenSignedOut: (owner: string, onSignal: () => void) => {
      const before = seam.beforeListen;
      seam.beforeListen = null;
      before?.();
      return real.listenSignedOut(owner, onSignal);
    },
  };
});

const { ACCOUNT, act } = shell;
const OTHER = "acct_other_2";
const SUBJECT = "SUBJECT-OF-THE-SIGNED-IN-ACCOUNT";
const BODY = "BODY-TEXT-OF-THE-SIGNED-IN-ACCOUNT";

it("visible tabs drop the previous account when a session change event is missed", async () => {
  const first = await openTab("first");
  const second = await openTab("second");
  expect(typeof BroadcastChannel).toBe("function");

  shell.rememberOwner(OTHER);
  await shell.tick(JAR_WATCH_MS);

  expect(showsMail(first)).toBe(false);
  expect(showsMail(second)).toBe(false);
  expect(leaves).toBe(2);
});

it("signing into a different account tells other tabs before the next jar check", async () => {
  const first = await openTab("first");
  const second = await openTab("second");
  const { withSessionCookieLock } = await import("../app/session-refresh");

  setThisTabForTest("sign-in-tab");
  await withSessionCookieLock(async () => { shell.rememberOwner(OTHER); });
  await oneTick();

  expect(showsMail(first)).toBe(false);
  expect(showsMail(second)).toBe(false);
  expect(leaves).toBe(2);
});

it("a cross-tab session change retires the device poll and display before leaving", async () => {
  document.cookie = "tf_family=fixture-family; Path=/";
  const tab = await openTab("account-tab");
  const { mailboxes } = await import("../app/api-client");
  const { DEVICE_SIGN_IN_KEY, webDeviceSignIn } = await import("../app/(product)/mailbox/device-sign-in");
  const { promise, resolve } = Promise.withResolvers<Awaited<ReturnType<typeof mailboxes.deviceOAuthPoll>>>();
  const start = vi.spyOn(mailboxes, "deviceOAuthStart").mockResolvedValue({
    state: "fixture-handle", userCode: "FIXTURE", verificationUri: "https://microsoft.com/devicelogin",
    expiresAt: new Date(Date.now() + 60_000).toISOString(), intervalMs: 5_000,
  });
  const poll = vi.spyOn(mailboxes, "deviceOAuthPoll").mockReturnValue(promise);
  const unsubscribe = webDeviceSignIn.live.subscribe(() => {});
  holdSignedOutLeave(new Promise(() => {}));
  try {
    await webDeviceSignIn.begin("microsoft");
    expect(webDeviceSignIn.live.read()?.kind).toBe("shown");
    expect(poll).toHaveBeenCalledTimes(1);
    const signal = poll.mock.calls[0]?.[1]?.signal;

    document.cookie = "tf_family=replacement-family; Path=/";
    setThisTabForTest("sign-in-tab");
    postSessionChange();
    await oneTick();

    expect(showsMail(tab)).toBe(false);
    expect(leaves).toBe(0);
    expect(signal?.aborted).toBe(true);
    expect(webDeviceSignIn.live.read()).toBeNull();
    expect(sessionStorage.getItem(DEVICE_SIGN_IN_KEY)).toBeNull();
    resolve({ status: "pending", userCode: "FIXTURE", verificationUri: "https://microsoft.com/devicelogin" });
    await oneTick();
    expect(webDeviceSignIn.live.read()).toBeNull();
    expect(poll).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
    webDeviceSignIn.stop();
    start.mockRestore();
    poll.mockRestore();
  }
});

let leaves = 0;
/** What a case wants read at the moment the tab navigates, and what it read. */
let atLeave: (() => unknown) | null = null;
let readAtLeave: unknown[] = [];
let wire: typeof globalThis.fetch;

beforeEach(async () => {
  resetSessionTruthForTests();
  shell.installConfirmEnv();
  (await import("../app/api-client")).bindApiOwner(null);
  /* A live session renews: the fixture's default refresh answer is a revocation. */
  shell.scriptRefresh(shell.refresh204);
  localStorage.clear();
  sessionStorage.clear();
  leaves = 0;
  atLeave = null;
  readAtLeave = [];
  setSignedOutLeaveForTest(() => {
    leaves += 1;
    if (atLeave) readAtLeave.push(atLeave());
  });
  /* The one read the fixture does not answer: a message body, so the reader has one to show. */
  wire = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (new Headers(init?.headers).get("x-ohmail-clear") === "cache") {
      return new Response(null, { status: 202, headers: { "Clear-Site-Data": '"cache"' } });
    }
    if (/\/messages\/[^/?]+\/body/.test(url)) {
      return new Response(JSON.stringify({
        text: BODY, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
      }), { status: 200, headers: { "content-type": "application/json", "X-Ohmail-Account": ACCOUNT } });
    }
    return wire(input as RequestInfo, init);
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  for (const w of watchers.splice(0)) w.disconnect();
  seam.beforeListen = null;
  Reflect.deleteProperty(navigator, "locks");
  await shell.teardownConfirmEnv();
  holdSignedOutLeave(null);
  setSignedOutLeaveForTest(null);
  setThisTabForTest(null);
  resetSessionTruthForTests();
});

/** A tab: its own name, its own `CloudShell`, the mailbox painted. */
async function openTab(name: string, accountId = ACCOUNT, subject = SUBJECT): Promise<HTMLElement> {
  setThisTabForTest(name);
  shell.rememberOwner(accountId);
  shell.scriptSession(() => shell.sessionFull(accountId));
  shell.scriptSync(() => shell.syncPage(subject, accountId));
  const el = await shell.mountCloudShell();
  await shell.tick(2_000);
  await vi.waitFor(() => expect(el.textContent, `${name} never painted its mailbox, so this proves nothing`).toContain(subject));
  return el;
}

/** Open the first row, so a body is on screen as well as the list. */
async function readFirst(el: HTMLElement): Promise<void> {
  const row = el.querySelector<HTMLElement>(":is(.row, [role=option])[data-id]");
  expect(row, "no message row to open").not.toBeNull();
  await act(async () => { row!.click(); });
  await shell.tick(1_000);
  expect(el.textContent, "the reader never showed the body").toContain(BODY);
}

/** Anything of the mailbox on this tab's screen. */
function showsMail(el: HTMLElement, subject = SUBJECT): boolean {
  const text = el.textContent ?? "";
  return el.querySelector(".fr-root") !== null || el.querySelector(":is(.row, [role=option])[data-id]") !== null
    || text.includes(subject) || text.includes(BODY) || text.includes(`snippet of ${subject}`);
}

/** Run `out` to its end on the pinned clock. */
async function drive<T>(out: Promise<T>): Promise<T> {
  let settled = false;
  void out.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 400 && !settled; i += 1) {
    await act(async () => { await Promise.resolve(); });
    if (!settled) await act(async () => { await vi.advanceTimersByTimeAsync(5); });
  }
  return out;
}

/** Tab 0's Settings → Account → Sign out: the press calls exactly this. */
async function signOutIn(name: string, accountId = ACCOUNT): Promise<void> {
  setThisTabForTest(name);
  const { signOut } = await import("../app/sign-out");
  await drive(signOut(accountId));
}

/** The sign-in page of page `name` finishing a pending sign-out behind its form; the door confirms it. */
async function finishPendingIn(name: string): Promise<void> {
  setThisTabForTest(name);
  document.cookie = "tf_owner=signed_out_pending; Path=/";
  document.cookie = "tf_family=fixture-family; Path=/";
  const { PENDING_SIGN_OUT_KEY } = await import("../app/sign-out");
  localStorage.setItem(PENDING_SIGN_OUT_KEY, JSON.stringify({ press: "earlier-tab", account: ACCOUNT, family: "fixture-family" }));
  Object.defineProperty(navigator, "locks", { configurable: true, value: {
    request: async (_name: string, _opts: unknown, run: () => Promise<unknown>) => run(),
  } });
  const { finishPendingSignOut } = await import("../app/(product)/login/finish-sign-out");
  try {
    const done = await drive(finishPendingSignOut({ isCancelled: () => false, attempts: 1 }));
    if (done.cleanup) {
      expect(done.outcome).toBe("stopped");
      expect(done.said).toEqual({ key: "signOutCleanupPending" });
      expect(await done.cleanup).toBeNull();
    } else {
      expect(done.outcome, "the finisher did not end the pending sign-out").toBe("confirmed");
    }
  } finally {
    Reflect.deleteProperty(navigator, "locks");
  }
}

/** One task: a `BroadcastChannel` message is a TASK, delivered when the loop turns once. */
const oneTick = async (): Promise<void> => {
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
};

const watchers: MutationObserver[] = [];

/** Every node put on `el` from now on, read as it was added: true once any of it was mail. */
function mailEverOn(el: HTMLElement): () => boolean {
  let seen = showsMail(el);
  const isMail = (n: Node): boolean => (n.textContent ?? "").includes(SUBJECT)
    || (n instanceof Element && (n.matches(".fr-root, :is(.row, [role=option])[data-id]") || n.querySelector(".fr-root, :is(.row, [role=option])[data-id]") !== null));
  const watch = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (isMail(n)) seen = true;
  });
  watch.observe(el, { childList: true, subtree: true });
  watchers.push(watch);
  return () => seen || showsMail(el);
}

/** A tab opened now, on whatever the jar says, while the session still answers for the account. */
async function bootTab(name: string): Promise<HTMLElement> {
  setThisTabForTest(name);
  shell.scriptSession(() => shell.sessionFull());
  return shell.mountCloudShell();
}

/** The door holds the next sign-out request; the answer is a 204, or a refusal (a busy server). */
function holdTheDoor(): (answer: "204" | "refused") => void {
  let reply: (answer: "204" | "refused") => void = () => {};
  shell.scriptLogout(() => new Promise<Response>((resolve) => {
    reply = (answer) => resolve(answer === "204" ? new Response(null, { status: 204 }) : shell.db503());
  }));
  return (answer) => reply(answer);
}

/** Run `p` to its end in steps of the pinned clock, every step committed; true once it settled. */
async function settle(p: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void p.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 40 && !settled; i += 1) await shell.tick(250);
  return settled;
}

/** The tab goes to the background, or is shown again: the document's `visibilityState`, then its event. */
async function setVisibility(state: "hidden" | "visible"): Promise<void> {
  if (state === "hidden") Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  else delete (document as { visibilityState?: unknown }).visibilityState;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
}

/** React's warning for a `flushSync` inside an effect: a tab leaving from its mount must not earn one. */
const flushSyncWarnings = (): string[] => vi.mocked(console.error).mock.calls
  .map((args) => args.map(String).join(" ")).filter((line) => line.includes("flushSync"));

describe("a sign-out in one tab reaches every other tab of the account", { timeout: 60_000 }, () => {
  it("tab 1 renders no row and no body within one tick of tab 0's sign out, and leaves", async () => {
    const tab1 = await openTab("tab-1");
    await readFirst(tab1);
    const tab0 = await openTab("tab-0");
    atLeave = () => showsMail(tab1);

    const reply = holdTheDoor();
    const { signOut } = await import("../app/sign-out");
    const out = signOut(ACCOUNT);
    for (let i = 0; i < 200 && shell.logoutCalls() === 0; i += 1) await oneTick();
    await oneTick();

    expect(shell.logoutCalls(), "the press never reached the sign-out door at its bare path").toBe(1);
    expect(showsMail(tab1), "tab 1 kept the signed-out account's mail on screen").toBe(false);
    expect(leaves, "tab 1 did not leave for the landing page").toBe(1);
    expect(readAtLeave, "the tab navigated with the mail still in its DOM").toEqual([false]);
    /* The tab that signed out does not obey its own post: its pane still has its own sentence to
       say (a wipe another tab blocked), and it navigates itself. */
    expect(tab0.querySelector(".fr-root"), "tab 0 obeyed its own message").not.toBeNull();
    reply("204");
    expect(await settle(out)).toBe(true);
    expect(showsMail(tab0), "tab 0 kept its mail after revocation").toBe(false);
  });

  it("tab 1 drops its rows while tab 0's door is still out", async () => {
    const tab1 = await openTab("tab-1");
    await openTab("tab-0");
    let answer!: () => void;
    shell.scriptLogout(() => new Promise<Response>((resolve) => {
      answer = () => resolve(new Response(null, { status: 204 }));
    }));
    setThisTabForTest("tab-0");
    const { signOut } = await import("../app/sign-out");
    const done = signOut(ACCOUNT);
    for (let i = 0; i < 200 && shell.logoutCalls() === 0; i += 1) await oneTick();
    expect(shell.logoutCalls(), "the press never reached the door").toBe(1);
    await oneTick();
    expect(showsMail(tab1), "tab 1 kept the mail while tab 0's door was out").toBe(false);
    expect(leaves).toBe(1);
    answer();
    let settled = false;
    void done.then(() => { settled = true; });
    for (let i = 0; i < 400 && !settled; i += 1) await oneTick();
    expect(settled, "the sign-out never finished once the door answered").toBe(true);
  });

  it("a tab that leaves on another tab's post takes its own per-tab notes with it", async () => {
    await openTab("tab-1");
    const { HANDOFF_KEY } = await import("@ohmail/app-logic/doors/wall-lift");
    const { SESSION_WATCH_PREFIX, SPLASH_PRESENTATION_KEY } = await import("../app/session-refresh");
    const notes = ["ohmail.deviceCeremony", HANDOFF_KEY, `${SESSION_WATCH_PREFIX}${ACCOUNT}`, SPLASH_PRESENTATION_KEY];
    for (const key of notes) sessionStorage.setItem(key, "{}");
    atLeave = () => notes.filter((key) => sessionStorage.getItem(key) !== null);
    /* Another tab's bare post, once the jar has stopped naming the account. */
    document.cookie = "tf_owner=signed_out_pending; Path=/";
    setThisTabForTest("tab-0");
    postSignedOut(ACCOUNT);
    await oneTick();
    expect(leaves).toBe(1);
    expect(readAtLeave, "the leaving tab kept its per-tab notes").toEqual([[]]);
  });

  it("a tab that leaves on another tab's post keeps none of the account's unsent words, as its own sign-out keeps none", async () => {
    await openTab("tab-1");
    /* What this tab's composer and reply hold for the account (a letter, its session and row, a reply and its meta),
       written after the other tab's sweep had run: only this tab's own sweep can take them. Another account's stay. */
    const mine = [
      `ohmail.ui.compose.${ACCOUNT}.composer-1`,
      `ohmail.ui.compose.${ACCOUNT}`,
      `ohmail.compose.session.${ACCOUNT}.composer-1`,
      `ohmail.compose.row.${ACCOUNT}.composer-1`,
      `ohmail.ui.reply.${ACCOUNT}:m1`,
      `ohmail.ui.replymeta.${ACCOUNT}:m1`,
    ];
    const theirs = [`ohmail.ui.compose.${OTHER}.composer-2`, `ohmail.ui.reply.${OTHER}:m2`];
    for (const key of [...mine, ...theirs]) localStorage.setItem(key, JSON.stringify({ body: "UNSENT-WORDS" }));
    atLeave = () => [...mine, ...theirs].filter((key) => localStorage.getItem(key) !== null);
    document.cookie = "tf_owner=signed_out_pending; Path=/";
    setThisTabForTest("tab-0");
    postSignedOut(ACCOUNT);
    await oneTick();
    expect(leaves).toBe(1);
    expect(readAtLeave, "the leaving tab kept the account's unsent words, or took another account's").toEqual([theirs]);
  });

  it("CONTROL: a stale sign-out signal for another account leaves the current account open", async () => {
    const other = await openTab("tab-1", OTHER, "SUBJECT-OF-ANOTHER-ACCOUNT");
    setThisTabForTest("tab-0");
    postSignedOut(ACCOUNT);
    postSessionChange();
    await oneTick();

    expect(other.textContent, "another account's tab obeyed this account's sign out")
      .toContain("SUBJECT-OF-ANOTHER-ACCOUNT");
    expect(leaves).toBe(0);
  });

  it("CONTROL: a sign-in in another tab does not sign this one out", async () => {
    /* One shell: two in one document share one `window`, so a focus would be two tabs' returns. */
    const tab1 = await openTab("tab-1");
    /* Tab 0 signs in again as the same account: the jar names it, the session answers it. A
       signed-out message that lands after that is somebody's stale news and is not obeyed. */
    shell.rememberOwner(ACCOUNT);
    setThisTabForTest("tab-0");
    postSignedOut(ACCOUNT);
    await oneTick();
    expect(showsMail(tab1), "a signal raced by a sign-in took the mailbox away").toBe(true);

    /* And the belt, asked when the tab is looked at again, answers the account. */
    const asked = shell.sessionCalls();
    await shell.tick(SESSION_FRESH_MS + 1_000);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await shell.tick(1_000);
    expect(shell.sessionCalls() - asked, "the returning tab did not ask the session door").toBe(1);
    expect(showsMail(tab1), "a live session's tab left").toBe(true);
    expect(leaves).toBe(0);
  });
});

describe("which tabs hear it, and when", { timeout: 60_000 }, () => {
  it("a warm tab whose confirm has not answered listens on the account it opened for", async () => {
    setThisTabForTest("tab-1");
    shell.rememberOwner(ACCOUNT);
    shell.scriptSession(shell.db503);
    const tab1 = await shell.mountCloudShell();
    await shell.tick(1_000);
    expect(tab1.querySelector(".fr-root"), "the warm mirror did not open").not.toBeNull();

    await signOutIn("tab-0");
    await oneTick();
    expect(showsMail(tab1), "an unconfirmed warm tab kept its mailbox").toBe(false);
    expect(leaves).toBe(1);
  });

  it("a tab opened cold listens once the confirm names the account", async () => {
    setThisTabForTest("tab-1");
    /* No remembered account; the session answer mints the marker, as the API's does. */
    shell.scriptSession(() => {
      shell.rememberOwner(ACCOUNT);
      return shell.sessionFull();
    });
    shell.scriptSync(() => shell.syncPage(SUBJECT));
    const tab1 = await shell.mountCloudShell();
    await shell.tick(2_000);
    expect(tab1.textContent, "the cold tab never painted").toContain(SUBJECT);

    await signOutIn("tab-0");
    await oneTick();
    expect(showsMail(tab1), "a cold-opened tab never listened").toBe(false);
    expect(leaves).toBe(1);
  });

  it("a revoke this tab learns is posted for the account's other tabs", async () => {
    await openTab("tab-1");
    const heard: string[] = [];
    setThisTabForTest("tab-2");
    const stop = listenSignedOut(ACCOUNT, () => heard.push("tab-2"));
    setThisTabForTest("tab-1");
    try {
      /* The refresh door's refusal: a coded 401 whose Set-Cookie emptied the jar. */
      document.cookie = "tf_owner=; Path=/; Max-Age=0";
      shell.scriptRefresh(shell.coded401);
      const { resumeSession } = await import("../app/session-refresh");
      await act(async () => { await resumeSession(); });
      await oneTick();
      expect(heard, "the other tab was not told").toEqual(["tab-2"]);
      expect(leaves, "the tab that learned it obeyed its own post").toBe(0);
    } finally {
      stop();
    }
  });

  it("CONTROL: a refused refresh that left the jar naming the account tells nobody", async () => {
    await openTab("tab-1");
    const heard: string[] = [];
    setThisTabForTest("tab-2");
    const stop = listenSignedOut(ACCOUNT, () => heard.push("tab-2"));
    setThisTabForTest("tab-1");
    try {
      shell.scriptRefresh(shell.coded401);
      const { resumeSession } = await import("../app/session-refresh");
      await act(async () => { await resumeSession(); });
      await oneTick();
      expect(heard, "a death the jar does not agree with was posted").toEqual([]);
    } finally {
      stop();
    }
  });

  it("a visible tab with a channel leaves when a sign-out signal is missed", async () => {
    const tab1 = await openTab("tab-1");
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    const asked = shell.sessionCalls();
    await shell.tick(JAR_WATCH_MS);
    expect(leaves).toBe(1);
    expect(showsMail(tab1)).toBe(false);
    expect(shell.sessionCalls() - asked).toBe(0);
  });
});

/**
 * A TAB BORN WHILE THE SIGN-OUT IS OUT. Measured on Cloud 0.30.30: a tab opened about 0.2 s after Sign
 * out's request left drew the Ohbox until the request answered. The page was served before the jar
 * said anything; its script ran after. It reads the jar before it draws any mail now: at its first
 * frame, when its confirm answers, and when its listener mounts.
 */
describe("a tab born while the sign-out is out", { timeout: 60_000 }, () => {
  beforeEach(async () => {
    (await import("../app/api-client")).bindApiOwner(null);
  });

  it.each([
    ["origin signal", OTHER, "fixture-family"],
    ["jar watch", ACCOUNT, "replacement-family"],
    ["return", OTHER, "replacement-family"],
  ])("the pressing tab drops its mail on %s if another session replaces the pending sign-out",
    async (notice, replacement, nextFamily) => {
      document.cookie = "tf_family=fixture-family; Path=/";
      const tab = await openTab("pressing-tab");
      const reply = holdTheDoor();
      const { signOut } = await import("../app/sign-out");
      const done = signOut(ACCOUNT);
      try {
        for (let i = 0; i < 200 && shell.logoutCalls() === 0; i += 1) await oneTick();
        expect(shell.logoutCalls()).toBe(1);
        await shell.tick(JAR_WATCH_MS);
        expect(showsMail(tab)).toBe(true);

        shell.rememberOwner(replacement);
        document.cookie = `tf_family=${nextFamily}; Path=/`;
        setThisTabForTest("replacement-tab");
        if (notice === "origin signal") {
          postSessionChange();
          await oneTick();
        } else if (notice === "return") {
          await act(async () => { window.dispatchEvent(new Event("focus")); });
        } else {
          await shell.tick(JAR_WATCH_MS);
        }
        expect(showsMail(tab)).toBe(false);
        expect(leaves).toBe(1);
      } finally {
        reply("refused");
        await settle(done);
      }
    });

  it("THE REPORTED SHAPE: a tab opened during the held request never draws the mail, asks nothing, and leaves", async () => {
    const tab0 = await openTab("tab-0");
    const reply = holdTheDoor();
    setThisTabForTest("tab-0");
    const { signOut } = await import("../app/sign-out");
    const done = signOut(ACCOUNT);
    for (let i = 0; i < 200 && shell.logoutCalls() === 0; i += 1) await oneTick();
    expect(shell.logoutCalls(), "the press never reached the door").toBe(1);

    const asked = shell.sessionCalls();
    const tab2 = await bootTab("tab-2");
    const sawMail = mailEverOn(tab2);
    await shell.tick(2_000);
    expect(sawMail(), "the tab born during the request drew the mailbox").toBe(false);
    expect(shell.sessionCalls() - asked, "the new tab asked the session door").toBe(0);
    expect(leaves, "the new tab stayed").toBe(1);
    expect(flushSyncWarnings()).toEqual([]);

    /* Refused: the marker stays pending, and the pressing tab still stays to say so. */
    setThisTabForTest("tab-0");
    reply("refused");
    expect(await settle(done), "the sign-out never ended").toBe(true);
    expect((await done).serverRefused, "the door's refusal was read as a sign-out").not.toBeNull();
    expect(tab0.querySelector(".fr-root"), "the pressing tab left").not.toBeNull();
    expect(leaves).toBe(1);
  });

  it("the pending marker closes existing tabs and blocks new tabs before revocation answers", async () => {
    document.cookie = "tf_family=fixture-family; Path=/";
    Object.defineProperty(navigator, "locks", { configurable: true, value: {
      request: async (_name: string, _opts: unknown, run: () => Promise<unknown>) => run(),
    } });
    localStorage.setItem("ohmail.notifications.subscriptionId", "fixture registration");
    const tab1 = await openTab("tab-1");
    await openTab("tab-0");
    const reply = holdTheDoor();
    const { signOut } = await import("../app/sign-out");
    const done = signOut(ACCOUNT);
    try {
      for (let i = 0; i < 200 && shell.logoutCalls() === 0; i += 1) await oneTick();
      expect(shell.logoutCalls()).toBe(1);
      expect(readOwnerMarker().kind).toBe("signed-out");
      await shell.tick(JAR_WATCH_MS);
      expect(showsMail(tab1)).toBe(false);
      expect(leaves).toBe(1);

      const asked = shell.sessionCalls();
      const tab2 = await bootTab("tab-2");
      await shell.tick(1_000);
      expect(showsMail(tab2)).toBe(false);
      expect(leaves).toBe(2);
      expect(shell.sessionCalls()).toBe(asked);
    } finally {
      reply("204");
      expect(await settle(done)).toBe(true);
      Reflect.deleteProperty(navigator, "locks");
    }
    expect(localStorage.getItem("ohmail.notifications.subscriptionId"), "the row's id outlived the sign-out").toBeNull();
  });

  it("a cold tab whose confirm was out at the press leaves when it answers: no mail, nothing bound", async () => {
    const reply = holdTheDoor();
    /* Cold: the jar names nobody at its first frame, so only its confirm can name the account. The
       only shell in this document, so the client's binding is this tab's alone. */
    let confirm: () => void = () => {};
    setThisTabForTest("tab-2");
    shell.scriptSession(() => new Promise<Response>((resolve) => { confirm = () => resolve(shell.sessionFull()); }));
    const tab2 = await shell.mountCloudShell();
    const sawMail = mailEverOn(tab2);
    await shell.tick(500);
    expect(shell.sessionCalls(), "the cold tab's confirm never left").toBe(1);

    setThisTabForTest("tab-0");
    const { signOut } = await import("../app/sign-out");
    const done = signOut(ACCOUNT);
    for (let i = 0; i < 200 && shell.logoutCalls() === 0; i += 1) await oneTick();
    expect(leaves, "sanity: the cold tab had no listener yet, so its confirm is what is measured").toBe(0);

    confirm();
    await shell.tick(1_000);
    expect(sawMail(), "the confirm's answer drew the mailbox under a pending sign-out").toBe(false);
    expect(leaves, "the cold tab stayed").toBe(1);
    const { apiOwnerBinding } = await import("../app/api-client");
    expect(apiOwnerBinding(), "the leaving tab bound the client to the answer").toEqual({ kind: "pending", owner: null });

    reply("204");
    expect(await settle(done), "the sign-out never ended").toBe(true);
  });

  it.each([
    ["a pending sign-out", "tf_owner=signed_out_pending; Path=/", 1],
    ["nothing", "tf_owner=; Path=/; Max-Age=0", 0],
    ["another account", `tf_owner=${OTHER}; Path=/`, 1],
  ])("a jar that turned to %s between the first frame and the listener: checks immediately at the listener", async (_what, jar, left) => {
    setThisTabForTest("tab-2");
    shell.rememberOwner(ACCOUNT);
    /* The confirm stays out, so nothing but the mount itself can send the tab away. */
    let confirm: () => void = () => {};
    shell.scriptSession(() => new Promise<Response>((resolve) => { confirm = () => resolve(shell.sessionFull()); }));
    seam.beforeListen = () => { document.cookie = jar; };
    const tab2 = await shell.mountCloudShell();
    await shell.tick(250);
    expect(seam.beforeListen, "the listener never mounted, so this proves nothing").toBeNull();
    expect(leaves, left === 1 ? "the tab stayed after the session changed" : "an unconfirmed jar sent the tab away")
      .toBe(left);
    if (left === 1) expect(showsMail(tab2), "the leaving tab kept the mailbox").toBe(false);
    expect(flushSyncWarnings()).toEqual([]);
    confirm();
    await shell.tick(250);
  });

  it("CONTROL: the pressing tab's own confirm, answering after its refused press, never sends it away", async () => {
    setThisTabForTest("tab-0");
    shell.rememberOwner(ACCOUNT);
    let confirm: () => void = () => {};
    shell.scriptSession(() => new Promise<Response>((resolve) => { confirm = () => resolve(shell.sessionFull()); }));
    const tab0 = await shell.mountCloudShell();
    await shell.tick(500);
    expect(tab0.querySelector(".fr-root"), "the warm mirror did not open").not.toBeNull();
    shell.scriptLogout(shell.db503);
    const { signOut } = await import("../app/sign-out");
    expect(await settle(signOut(ACCOUNT)), "the refused sign-out never ended").toBe(true);
    expect(readOwnerMarker().kind).toBe("signed-out");
    confirm();
    await shell.tick(1_000);
    expect(leaves, "the pressing tab left at its own confirm").toBe(0);
    expect(tab0.querySelector(".fr-root")).not.toBeNull();
  });

  it("CONTROL: the demo is never sent away by a pending sign-out", async () => {
    window.history.replaceState(null, "", "/?demo=1");
    try {
      document.cookie = "tf_owner=signed_out_pending; Path=/";
      setThisTabForTest("tab-2");
      const demo = await shell.mountCloudShell();
      await shell.tick(1_000);
      expect(leaves, "the demo left").toBe(0);
      expect(demo.querySelector(".fr-root"), "the demo drew nothing").not.toBeNull();
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });
});

describe("the belt: a tab that missed the message asks when it is looked at again", { timeout: 60_000 }, () => {
  let channel: typeof BroadcastChannel | undefined;
  beforeEach(() => {
    channel = globalThis.BroadcastChannel;
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
  });
  afterEach(() => {
    if (channel) (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = channel;
    delete (document as { visibilityState?: unknown }).visibilityState;
  });

  it("a visible-again tab with no channel whose jar stopped naming the account leaves at once, asking nothing", async () => {
    const tab1 = await openTab("tab-1");
    /* In the background while tab 0 signs out: a tab on screen watches the jar instead. */
    await setVisibility("hidden");
    await signOutIn("tab-0");
    await oneTick();
    await shell.tick(3 * JAR_WATCH_MS);
    /* One document cannot deliver itself a storage event, so tab 1 missed the message — the case
       the belt exists for. */
    expect(showsMail(tab1), "sanity: the tab heard nothing, so the belt is what is measured").toBe(true);

    atLeave = () => showsMail(tab1);
    const asked = shell.sessionCalls();
    await setVisibility("visible");

    expect(shell.sessionCalls() - asked, "the tab showed the mail for a round trip first").toBe(0);
    expect(leaves).toBe(1);
    expect(readAtLeave, "the tab navigated with the mail still in its DOM").toEqual([false]);
  });

  /* A tab on screen the whole time (a second window beside the one that signs out) gets no event at all. */
  it("a tab on screen with no channel and no storage event leaves within its jar watch of another tab's sign-out, asking nothing", async () => {
    const tab1 = await openTab("tab-1");
    atLeave = () => showsMail(tab1);
    const asked = shell.sessionCalls();
    const pressedAt = Date.now();
    await signOutIn("tab-0");
    const left = pressedAt + JAR_WATCH_MS - Date.now();
    if (left > 0) await shell.tick(left);
    expect(leaves, "the tab kept the mailbox on screen with nothing to wake it").toBe(1);
    expect(readAtLeave, "the tab navigated with the mail still in its DOM").toEqual([false]);
    expect(showsMail(tab1)).toBe(false);
    expect(shell.sessionCalls() - asked, "the watch asked the session door").toBe(0);
  });

  it("CONTROL: a jar that still names the account: the watch never leaves and never asks", async () => {
    const tab1 = await openTab("tab-1");
    const asked = shell.sessionCalls();
    /* Another tab's sign-in as the same account writes the jar again, naming it. */
    document.cookie = `tf_owner=${ACCOUNT}; Path=/`;
    await shell.tick(3 * JAR_WATCH_MS);
    expect(shell.sessionCalls() - asked, "the watch asked the session door").toBe(0);
    expect(showsMail(tab1), "a live session's tab left").toBe(true);
    expect(leaves).toBe(0);
  });

  it("a hidden tab runs no jar watch: resumed while hidden it stays, shown it leaves, asking nothing", async () => {
    const tab1 = await openTab("tab-1");
    await setVisibility("hidden");
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    const asked = shell.sessionCalls();
    await act(async () => { document.dispatchEvent(new Event("resume")); });
    await shell.tick(3 * JAR_WATCH_MS);
    expect(leaves, "a tab in the background left").toBe(0);
    atLeave = () => showsMail(tab1);
    await setVisibility("visible");
    expect(leaves, "the shown tab kept a mailbox the jar no longer names").toBe(1);
    expect(readAtLeave, "the tab navigated with the mail still in its DOM").toEqual([false]);
    expect(shell.sessionCalls() - asked, "the return asked the session door").toBe(0);
  });

  it.each([
    ["absent", "tf_owner=; Path=/; Max-Age=0", "visibilitychange"],
    ["a pending sign-out", "tf_owner=signed_out_pending; Path=/", "resume"],
    ["another account", `tf_owner=${OTHER}; Path=/`, "pageshow"],
  ])("a jar that now reads %s leaves on return, with no request", async (_what, jar, event) => {
    const tab1 = await openTab("tab-1");
    document.cookie = jar;
    const asked = shell.sessionCalls();
    await act(async () => {
      (event === "pageshow" ? window : document).dispatchEvent(new Event(event));
    });
    expect(shell.sessionCalls() - asked).toBe(0);
    expect(showsMail(tab1)).toBe(false);
    expect(leaves).toBe(1);
  });

  it.each([
    ["letter", false], ["letter", true], ["reply", false], ["reply", true],
  ] as const)("an open editor that resumes after an account change preserves its %s according to explicit sign-out (%s)", async (editor, signedOut) => {
    document.cookie = "tf_family=fixture-family; Path=/";
    const tab = await openTab("tab-1");
    const words = "unsynced words in account A";
    if (editor === "letter") {
      await act(async () => {
        window.location.hash = "#/compose";
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      await oneTick();
      const subject = within(tab).getByRole("textbox", { name: "Subject" });
      await act(async () => { fireEvent.change(subject, { target: { value: words } }); });
    } else {
      await readFirst(tab);
      await act(async () => { within(tab).getByRole("button", { name: "Reply" }).click(); });
      await shell.tick(200);
      const body = within(tab).getByRole("textbox", { name: "Reply body" }) as HTMLElement & {
        editor: import("@tiptap/core").Editor;
      };
      await act(async () => { body.editor.chain().selectAll().insertContent(words).run(); });
    }
    const holding = () => Object.keys(localStorage).filter((key) => localStorage.getItem(key)?.includes(words));
    expect(holding().some((key) => key.includes(ACCOUNT))).toBe(true);
    await setVisibility("hidden");
    if (signedOut) {
      await signOutIn("tab-0");
      expect(holding()).toEqual([]);
    }
    shell.rememberOwner(OTHER);
    document.cookie = "tf_family=replacement-family; Path=/";
    const nextDraft = `ohmail.ui.compose.${OTHER}.other-editor`;
    localStorage.setItem(nextDraft, "the second account’s own words");
    await setVisibility("visible");
    await shell.tick(4_000);
    expect(showsMail(tab)).toBe(false);
    expect(holding().some((key) => key.includes(ACCOUNT))).toBe(!signedOut);
    expect(holding().some((key) => key.includes(OTHER))).toBe(false);
    expect(localStorage.getItem(nextDraft)).toBe("the second account’s own words");
  });

  it.each(["return", "jar watch", "session answer"])(
    "keeps each account's unsent words when another account takes over on %s",
    async (path) => {
      const tab = await openTab("tab-1");
      const draft = (owner: string) => `ohmail.ui.compose.${owner}.composer-1`;
      const reply = (owner: string) => `ohmail.ui.reply.${owner}:m1`;
      const words = new Map([
        [draft(ACCOUNT), "offline draft A"], [reply(ACCOUNT), "offline reply A"],
        [draft(OTHER), "separate draft B"], [reply(OTHER), "separate reply B"],
      ]);
      for (const [key, value] of words) localStorage.setItem(key, value);
      atLeave = () => showsMail(tab);
      if (path === "session answer") {
        await shell.tick(SESSION_FRESH_MS + 1_000);
        shell.scriptSession(() => shell.sessionFull(OTHER));
      } else {
        shell.rememberOwner(OTHER);
      }
      const asked = shell.sessionCalls();
      if (path === "jar watch") await shell.tick(JAR_WATCH_MS + 1);
      else {
        await act(async () => { window.dispatchEvent(new Event("pageshow")); });
        await oneTick();
      }
      expect(readAtLeave).toEqual([false]);
      expect(shell.sessionCalls() - asked).toBe(path === "session answer" ? 1 : 0);
      for (const [key, value] of words) expect(localStorage.getItem(key)).toBe(value);
      expect(tab.textContent).not.toContain("offline draft A");
      expect(tab.textContent).not.toContain("separate draft B");
    },
  );

  it("CONTROL: a jar that still names the account waits for the server's none", async () => {
    const tab1 = await openTab("tab-1");
    await shell.tick(SESSION_FRESH_MS + 1_000);
    const held: Array<() => void> = [];
    shell.scriptSession(() => new Promise<Response>((resolve) => { held.push(() => resolve(shell.coded401())); }));
    shell.scriptRefresh(shell.coded401);
    const asked = shell.sessionCalls();
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await shell.tick(1_000);
    expect(shell.sessionCalls() - asked, "one return, one ask").toBe(1);
    expect(showsMail(tab1), "the tab left before the server answered").toBe(true);
    for (const answer of held) answer();
    await shell.tick(1_000);
    expect(showsMail(tab1), "the 401 left the mailbox on screen").toBe(false);
    expect(leaves).toBe(1);
  });

  it("CONTROL: a return whose ask gets no answer keeps the mailbox — no answer is not a verdict", async () => {
    const tab1 = await openTab("tab-1");
    /* The jar still names the account and the last ask is stale; the server is busy and answers nothing. */
    await shell.tick(SESSION_FRESH_MS + 1_000);
    shell.scriptSession(shell.db503);
    const asked = shell.sessionCalls();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await shell.tick(1_000);
    expect(shell.sessionCalls() - asked, "the stale return was not asked about").toBe(1);
    expect(showsMail(tab1), "a 503 signed the tab out").toBe(true);
    expect(leaves).toBe(0);
  });

  it("the pressing tab keeps its pending sign-out progress through the return check", async () => {
    const tab0 = await openTab("tab-0");
    shell.scriptLogout(shell.db503);
    await signOutIn("tab-0");
    expect(readOwnerMarker().kind).toBe("signed-out");
    await shell.tick(3 * JAR_WATCH_MS);
    expect(leaves, "the jar watch sent the pressing tab away").toBe(0);
    shell.scriptSession(shell.coded401);
    shell.scriptRefresh(shell.coded401);
    const asked = shell.sessionCalls();
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await shell.tick(SESSION_FRESH_MS + 1_000);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await shell.tick(1_000);
    expect(shell.sessionCalls() - asked, "the signing-out tab asked the session door").toBe(0);
    expect(leaves, "the signing-out tab left before its pane could say how the sign-out ended").toBe(0);
    expect(tab0.querySelector(".fr-root")).not.toBeNull();
  });

  /* A sign-out earlier in this page, then a sign-in that mounts the mailbox in the same page (a client-side
     navigation): only a press made while this shell is mounted stands its return check down. */
  it.each([
    ["finished a pending sign-out", "a sign-out it missed"],
    ["finished a pending sign-out", "a revoke made elsewhere"],
    ["pressed Sign out", "a sign-out it missed"],
    ["pressed Sign out", "a revoke made elsewhere"],
  ])("a page that %s and then signed in still leaves on %s", async (earlier, ended) => {
    if (earlier === "pressed Sign out") await signOutIn("tab-1");
    else await finishPendingIn("tab-1");
    document.cookie = "tf_family=replacement-family; Path=/";
    const tab1 = await openTab("tab-1");
    const missed = ended === "a sign-out it missed";
    if (missed) document.cookie = "tf_owner=; Path=/; Max-Age=0";
    else await shell.tick(SESSION_FRESH_MS + 1_000);
    shell.scriptSession(shell.coded401);
    shell.scriptRefresh(shell.coded401);
    const asked = shell.sessionCalls();
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await shell.tick(1_000);
    expect(shell.sessionCalls() - asked, "a moved jar is read locally, a revoke is asked once").toBe(missed ? 0 : 1);
    expect(showsMail(tab1), "the mailbox stayed on screen after its session ended").toBe(false);
    expect(leaves).toBe(1);
  });

  it("CONTROL: a tab that is still hidden asks nothing", async () => {
    await openTab("tab-1");
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    const asked = shell.sessionCalls();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      await shell.tick(1_000);
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
    expect(shell.sessionCalls() - asked, "a hidden tab asked the session door").toBe(0);
  });

  it("the storage event carries the message where there is no channel", async () => {
    const tab1 = await openTab("tab-1");
    /* What another tab's `postSignedOut` fires here, once the jar has stopped naming the account. */
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: signedOutChannel(ACCOUNT),
        newValue: JSON.stringify({ t: "signed-out", from: "tab-0" }),
        storageArea: localStorage,
      }));
    });
    expect(showsMail(tab1), "the storage event was not obeyed").toBe(false);
    expect(leaves).toBe(1);
  });

  it("the poster writes the storage key and removes it in the same call", () => {
    const log: string[] = [];
    const map = new Map<string, string>();
    const held = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        get length() { return map.size; },
        key: (i: number) => [...map.keys()][i] ?? null,
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => { log.push(`set ${k} ${v}`); map.set(k, v); },
        removeItem: (k: string) => { log.push(`remove ${k}`); map.delete(k); },
        clear: () => map.clear(),
      } as Storage,
    });
    try {
      setThisTabForTest("tab-0");
      postSignedOut(ACCOUNT);
      const key = signedOutChannel(ACCOUNT);
      expect(log).toEqual([`set ${key} {"t":"signed-out","from":"tab-0"}`, `remove ${key}`]);
      expect(map.size, "the message left state behind").toBe(0);
    } finally {
      if (held) Object.defineProperty(window, "localStorage", held);
    }
  });
});

describe("the channel itself", () => {
  it("is named per account, delivers to other tabs and never to the one that posted", async () => {
    const heard: string[] = [];
    setThisTabForTest("tab-a");
    const stopA = listenSignedOut(ACCOUNT, () => heard.push("tab-a"));
    const stopOther = listenSignedOut(OTHER, () => heard.push("other-account"));
    setThisTabForTest("tab-b");
    const stopB = listenSignedOut(ACCOUNT, () => heard.push("tab-b"));
    try {
      postSignedOut(ACCOUNT);
      await vi.advanceTimersByTimeAsync(1);
      expect(heard).toEqual(["tab-a"]);
    } finally {
      stopA(); stopB(); stopOther();
    }
  });
});

/**
 * A SESSION REVOKED FROM ANOTHER DEVICE TAKES THE MAIL OFF THIS SCREEN AND THIS BROWSER. Devices → Sign
 * out elsewhere: this tab's next renewal hears `refresh_revoked`, drops the mailbox without the scrim,
 * removes this browser's copy and only then leaves for the sign-in page, as Sign out does. An expired
 * sign-in keeps the scrim over the mail, and the copy.
 */
describe("a session revoked from another device", { timeout: 60_000 }, () => {
  afterEach(async () => {
    (await import("../app/revoked-door")).resetRevokedDoorForTests();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  /** This browser's disk: the tab's mirror is an IndexedDB one, as in a browser. */
  async function disk(): Promise<() => Promise<string[]>> {
    const { createRequire } = await import("node:module");
    const { resolve } = await import("node:path");
    const fake = createRequire(resolve("packages/client-engine/package.json"))("fake-indexeddb") as { IDBFactory: new () => IDBFactory; IDBKeyRange: unknown };
    const idb = new fake.IDBFactory();
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = idb;
    (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = fake.IDBKeyRange;
    return async () => (await idb.databases()).map((d) => d.name ?? "").filter((n) => n.startsWith("ohmail-mirror"));
  }

  /** The renewal the tab makes; the refresh door answers `code` and empties the jar. */
  async function renewalRefused(code: string): Promise<void> {
    shell.scriptRefresh(shell.refusedClearing(code));
    const { resumeSession } = await import("../app/session-refresh");
    expect(await drive(resumeSession())).toBe("refused");
    await shell.tick(2_000);
  }

  it("the revoked tab shows no mail and no scrim, and leaves only once this browser's copy is gone", async () => {
    const mirrors = await disk();
    const { holdsMirrorOf } = await import("@ohmail/client-engine");
    const tab1 = await openTab("tab-1");
    expect(await mirrors(), "the tab opened no mirror, so this proves nothing").toEqual([`ohmail-mirror:${ACCOUNT}`]);
    atLeave = () => holdsMirrorOf(ACCOUNT);
    await renewalRefused("refresh_revoked");
    expect(showsMail(tab1), "the revoked tab kept the mailbox on screen").toBe(false);
    expect(tab1.querySelector(".session-end"), "the mail was dropped behind a scrim").toBeNull();
    expect(leaves, "the revoked tab stayed").toBe(1);
    expect(readAtLeave, "the tab left with its copy still on this browser").toEqual([false]);
    expect(await mirrors()).toEqual([]);
  });

  it("a tab whose jar lost tf_owner (Safari keeps a script-written one seven days) takes its own copy, only its own", async () => {
    const mirrors = await disk();
    const { IndexedDbMirrorStore, holdsMirrorOf } = await import("@ohmail/client-engine");
    const tab1 = await openTab("tab-1");
    const other = new IndexedDbMirrorStore({ owner: OTHER });
    await drive(other.load());
    other.close();
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    atLeave = () => holdsMirrorOf(ACCOUNT);
    await renewalRefused("refresh_revoked");
    expect(showsMail(tab1), "the revoked tab kept the mailbox on screen").toBe(false);
    expect(leaves, "the revoked tab stayed").toBe(1);
    expect(readAtLeave, "the tab left with its copy still on this browser").toEqual([false]);
    expect(await mirrors(), "the tab kept its own copy, or took another account's").toEqual([`ohmail-mirror:${OTHER}`]);
  });

  it("CONTROL: an expired sign-in keeps the scrim over the mail, and the copy", async () => {
    const mirrors = await disk();
    const tab1 = await openTab("tab-1");
    await renewalRefused("refresh_expired");
    expect(tab1.querySelector(".session-end")?.textContent).toContain(shell.messages.session.endedMidUse);
    expect(tab1.querySelector(":is(.row, [role=option])[data-id]"), "the rows left from behind the scrim").not.toBeNull();
    expect(await mirrors()).toEqual([`ohmail-mirror:${ACCOUNT}`]);
    expect(leaves).toBe(0);
  });
});


it("drops mail in the pressing tab when unlocked revocation succeeds and the wipe remains incomplete", async () => {
  Reflect.deleteProperty(navigator, "locks");
  document.cookie = "tf_family=fixture-family; Path=/";
  const tab = await openTab("pressing-tab");
  setThisTabForTest("pressing-tab");
  const { signOut } = await import("../app/sign-out");
  const result = await drive(signOut(ACCOUNT));
  expect(result.serverRefused).toBeNull();
  expect(result.inventoryComplete).toBe(false);
  await shell.tick(2 * JAR_WATCH_MS);
  expect(showsMail(tab)).toBe(false);
});

it("opens a fresh mailbox and drafts while removal of the original account's old draft is refused", async () => {
  const { retainAccountCleanup } = await import("../app/pending-sign-out-storage");
  const { composeDraftKey } = await import("@ohmail/app-logic/writing/compose");
  const oldDraft = composeDraftKey(ACCOUNT);
  localStorage.setItem(oldDraft, JSON.stringify({ subject: "old private draft" }));
  retainAccountCleanup({ press: "old-press", account: ACCOUNT, family: "departed-family", revoked: true });
  document.cookie = "tf_family=replacement-family; Path=/";
  const remove = Storage.prototype.removeItem;
  const refused = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key) {
    if (this === localStorage && key === oldDraft) return;
    remove.call(this, key);
  });
  try {
    const tab = await openTab("replacement-tab");
    expect(refused).toHaveBeenCalledWith(oldDraft);
    await act(async () => {
      window.location.hash = "#/compose";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await oneTick();
    const subject = within(tab).getByRole<HTMLInputElement>("textbox", { name: "Subject" });
    expect(subject.value).toBe("");
    await act(async () => { fireEvent.change(subject, { target: { value: "new draft" } }); });
    expect(localStorage.getItem(oldDraft)).toContain("old private draft");
    expect(Object.values(localStorage).some((value) => String(value).includes("new draft"))).toBe(true);
  } finally {
    refused.mockRestore();
  }
});
