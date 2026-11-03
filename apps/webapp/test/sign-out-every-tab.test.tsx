/** @vitest-environment jsdom */
/**
 * SIGNING OUT IN ONE TAB ENDS THE SESSION IN EVERY TAB OF THIS BROWSER.
 *
 * Measured on Cloud 0.25.2: two tabs on one account, Sign out in tab 0 emptied the jar and the
 * local databases, and tab 1 went on showing the whole Ohbox from memory — and message bodies on a
 * view switch — until it was reloaded. Two real `CloudShell`s share one jar, one wire and Node's
 * real `BroadcastChannel` here; the leave seam stands in for a navigation jsdom cannot make.
 */
import * as shell from "./fixtures/cloud-confirm-shell";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSessionTruthForTests } from "../app/shell/session-truth";
import { readOwnerMarker } from "../app/shell/owner-cookie";
import {
  listenSignedOut, postSignedOut, setSignedOutLeaveForTest, setThisTabForTest, signedOutChannel,
} from "../app/signed-out-signal";
import { SESSION_FRESH_MS } from "../app/(product)/mailbox/useSignedOutElsewhere";

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

let leaves = 0;
/** What a case wants read at the moment the tab navigates, and what it read. */
let atLeave: (() => unknown) | null = null;
let readAtLeave: unknown[] = [];
let wire: typeof globalThis.fetch;

beforeEach(() => {
  resetSessionTruthForTests();
  shell.installConfirmEnv();
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
    if (/\/messages\/[^/?]+\/body/.test(url)) {
      return new Response(JSON.stringify({
        text: BODY, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return wire(input as RequestInfo, init);
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  for (const w of watchers.splice(0)) w.disconnect();
  seam.beforeListen = null;
  await shell.teardownConfirmEnv();
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
  expect(el.textContent, `${name} never painted its mailbox, so this proves nothing: ${el.innerHTML.slice(0, 300)}`)
    .toContain(subject);
  return el;
}

/** Open the first row, so a body is on screen as well as the list. */
async function readFirst(el: HTMLElement): Promise<void> {
  const row = el.querySelector<HTMLElement>(".row[data-id]");
  expect(row, "no message row to open").not.toBeNull();
  await act(async () => { row!.click(); });
  await shell.tick(1_000);
  expect(el.textContent, "the reader never showed the body").toContain(BODY);
}

/** Anything of the mailbox on this tab's screen. */
function showsMail(el: HTMLElement, subject = SUBJECT): boolean {
  const text = el.textContent ?? "";
  return el.querySelector(".app-root") !== null || el.querySelector(".row[data-id]") !== null
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
  const { finishPendingSignOut } = await import("../app/(product)/login/finish-sign-out");
  const done = await drive(finishPendingSignOut({ isCancelled: () => false, attempts: 1 }));
  expect(done.outcome, "the finisher did not end the pending sign-out").toBe("confirmed");
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
    || (n instanceof Element && (n.matches(".app-root, .row[data-id]") || n.querySelector(".app-root, .row[data-id]") !== null));
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

/** React's warning for a `flushSync` inside an effect: a tab leaving from its mount must not earn one. */
const flushSyncWarnings = (): string[] => vi.mocked(console.error).mock.calls
  .map((args) => args.map(String).join(" ")).filter((line) => line.includes("flushSync"));

describe("a sign-out in one tab reaches every other tab of the account", { timeout: 60_000 }, () => {
  it("tab 1 renders no row and no body within one tick of tab 0's sign out, and leaves", async () => {
    const tab1 = await openTab("tab-1");
    await readFirst(tab1);
    const tab0 = await openTab("tab-0");
    atLeave = () => showsMail(tab1);

    await signOutIn("tab-0");
    await oneTick();

    expect(shell.logoutCalls(), "the press never reached the sign-out door at its bare path").toBe(1);
    expect(showsMail(tab1), "tab 1 kept the signed-out account's mail on screen").toBe(false);
    expect(leaves, "tab 1 did not leave for the landing page").toBe(1);
    expect(readAtLeave, "the tab navigated with the mail still in its DOM").toEqual([false]);
    /* The tab that signed out does not obey its own post: its pane still has its own sentence to
       say (a wipe another tab blocked), and it navigates itself. */
    expect(tab0.querySelector(".app-root"), "tab 0 obeyed its own message").not.toBeNull();
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
    const { HANDOFF_KEY } = await import("../app/shell/wall-lift");
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

  it("CONTROL: a tab of another account is untouched by this account's sign out", async () => {
    const other = await openTab("tab-1", OTHER, "SUBJECT-OF-ANOTHER-ACCOUNT");
    await openTab("tab-0");

    await signOutIn("tab-0");
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
    expect(tab1.querySelector(".app-root"), "the warm mirror did not open").not.toBeNull();

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
    expect(tab0.querySelector(".app-root"), "the pressing tab left").not.toBeNull();
    expect(leaves).toBe(1);
  });

  it("the jar is pending and the tabs are told at the press: while the wake row's DELETE is out, a new tab draws nothing", async () => {
    const tab1 = await openTab("tab-1");
    await openTab("tab-0");
    /* A browser that registered for wakes, installed after the boots so only the press's revoke meets it. */
    const sub = {
      endpoint: "https://push.example/ep/1",
      getKey: (n: string) => new Uint8Array(n === "auth" ? 16 : 65).fill(7).buffer,
      unsubscribe: () => Promise.resolve(true),
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: () => Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve(sub) } }) },
    });
    localStorage.setItem("ohmail.notifications.subscriptionId", "row-7");
    localStorage.setItem("ohmail.notifications.subscriptionEndpoint", sub.endpoint);
    const deletes: string[] = [];
    let release: () => void = () => {};
    const inner = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (init?.method === "DELETE" && String(input).includes("/push/subscriptions/")) {
        deletes.push(String(input));
        await new Promise<void>((resolve) => { release = resolve; });
        return new Response(null, { status: 204 });
      }
      return inner(input as RequestInfo, init);
    }) as unknown as typeof globalThis.fetch;
    try {
      setThisTabForTest("tab-0");
      const { signOut } = await import("../app/sign-out");
      const done = signOut(ACCOUNT);
      for (let i = 0; i < 200 && deletes.length === 0 && shell.logoutCalls() === 0; i += 1) await oneTick();
      expect(deletes, "the press's own wake row was not deleted").toEqual(["/api/push/subscriptions/row-7"]);
      expect(readOwnerMarker().kind, "the jar named the account while the DELETE was out").toBe("signed-out");
      expect(showsMail(tab1), "tab 1 kept the mail while the DELETE was out").toBe(false);
      expect(leaves).toBe(1);

      const tab2 = await bootTab("tab-2");
      await shell.tick(1_000);
      expect(showsMail(tab2), "a tab opened while the DELETE was out drew the mailbox").toBe(false);
      expect(leaves).toBe(2);
      expect(shell.logoutCalls(), "the door was asked before the wake row went").toBe(0);

      setThisTabForTest("tab-0");
      release();
      expect(await settle(done), "the sign-out never ended").toBe(true);
      expect(shell.logoutCalls()).toBe(1);
      expect(localStorage.getItem("ohmail.notifications.subscriptionId"), "the row's id outlived the sign-out").toBeNull();
    } finally {
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
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
    ["another account", `tf_owner=${OTHER}; Path=/`, 0],
  ])("a jar that turned to %s between the first frame and the listener: leaves at the listener's mount only when pending", async (_what, jar, left) => {
    setThisTabForTest("tab-2");
    shell.rememberOwner(ACCOUNT);
    /* The confirm stays out, so nothing but the mount itself can send the tab away. */
    let confirm: () => void = () => {};
    shell.scriptSession(() => new Promise<Response>((resolve) => { confirm = () => resolve(shell.sessionFull()); }));
    seam.beforeListen = () => { document.cookie = jar; };
    const tab2 = await shell.mountCloudShell();
    await shell.tick(250);
    expect(seam.beforeListen, "the listener never mounted, so this proves nothing").toBeNull();
    expect(leaves, left === 1 ? "the tab stayed on a pending sign-out" : "a jar that is no pending sign-out sent the tab away")
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
    expect(tab0.querySelector(".app-root"), "the warm mirror did not open").not.toBeNull();
    shell.scriptLogout(shell.db503);
    const { signOut } = await import("../app/sign-out");
    expect(await settle(signOut(ACCOUNT)), "the refused sign-out never ended").toBe(true);
    expect(readOwnerMarker().kind).toBe("signed-out");
    confirm();
    await shell.tick(1_000);
    expect(leaves, "the pressing tab left at its own confirm").toBe(0);
    expect(tab0.querySelector(".app-root")).not.toBeNull();
  });

  it("CONTROL: the demo is never sent away by a pending sign-out", async () => {
    window.history.replaceState(null, "", "/?demo=1");
    try {
      document.cookie = "tf_owner=signed_out_pending; Path=/";
      setThisTabForTest("tab-2");
      const demo = await shell.mountCloudShell();
      await shell.tick(1_000);
      expect(leaves, "the demo left").toBe(0);
      expect(demo.querySelector(".app-root"), "the demo drew nothing").not.toBeNull();
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
  });

  it("a visible-again tab with no channel whose jar stopped naming the account leaves at once, asking nothing", async () => {
    const tab1 = await openTab("tab-1");
    await signOutIn("tab-0");
    await oneTick();
    /* One document cannot deliver itself a storage event, so tab 1 missed the message — the case
       the belt exists for. */
    expect(showsMail(tab1), "sanity: the tab heard nothing, so the belt is what is measured").toBe(true);

    atLeave = () => showsMail(tab1);
    const asked = shell.sessionCalls();
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });

    expect(shell.sessionCalls() - asked, "the tab showed the mail for a round trip first").toBe(0);
    expect(leaves).toBe(1);
    expect(readAtLeave, "the tab navigated with the mail still in its DOM").toEqual([false]);
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

  it("the tab that pressed Sign out never leaves through the return check", async () => {
    const tab0 = await openTab("tab-0");
    await signOutIn("tab-0");
    shell.scriptSession(shell.coded401);
    shell.scriptRefresh(shell.coded401);
    const asked = shell.sessionCalls();
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await shell.tick(SESSION_FRESH_MS + 1_000);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await shell.tick(1_000);
    expect(shell.sessionCalls() - asked, "the signing-out tab asked the session door").toBe(0);
    expect(leaves, "the signing-out tab left before its pane could say how the sign-out ended").toBe(0);
    expect(tab0.querySelector(".app-root")).not.toBeNull();
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
