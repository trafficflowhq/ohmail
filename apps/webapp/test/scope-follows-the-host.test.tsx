/** @vitest-environment jsdom */
/**
 * WHOSE KEYS THE MOUNTED VIEWS KEEP, ON THE WEB'S REAL ENTRY (`CloudShell`): a person's words are kept under the
 * account whose mail they were written over. A conflicting account marker retires the original frame. Resuming the
 * original person's work requires a fresh session confirmation.
 */
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";
import { DEMO_STORAGE_OWNER, namesOwner, resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import {
  ACCOUNT, ISO, act, installConfirmEnv, refresh204, rememberOwner, scriptRefresh, scriptSession,
  sessionCalls, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

/* THE PLACE OF ANOTHER BODY IS THE SEATED OHBOX, as every host hands it: leaving the composer for it takes today's
   view off the stage and coming back draws it again, under the same frame and the same composition. */
const seatedList = (): Element | null => document.querySelector('section[aria-label="Messages"] [role="listbox"], section[aria-label="Messages"] h1');

const h = React.createElement;
let root: Root | null = null;
/** Another account this browser's owner marker comes to name while the frame stands. */
const OTHER = "acct_other_2";

/** The letter's subject field, by its role and name (the place `write` draws it with the kit's envelope). */
const subject = (): HTMLInputElement | null => screen.queryByRole<HTMLInputElement>("textbox", { name: "Subject" });
/** Every stored key whose value holds these words. */
const holding = (words: string): string[] =>
  Object.keys(window.localStorage).filter((k) => (window.localStorage.getItem(k) ?? "").includes(words));
/** A key the demo's partition names: its word carries a colon no account id can hold. */
const namesDemo = (key: string): boolean => key.includes(DEMO_STORAGE_OWNER);
const write = async (words: string): Promise<void> => {
  await act(async () => { fireEvent.change(subject()!, { target: { value: words } }); });
  await tick(4000);
};

async function mountEntry(demo: boolean, drawMail: "now" | "wait" = "now"): Promise<void> {
  const { CloudShell } = await import("../app/(product)/mailbox/CloudShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  if (root === null) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date(ISO),
      children: h(ThemeProvider as never, { storageKey: null } as never,
        h(ToastHost as never, null, h(CloudShell as never, { demo, drawMail } as never))),
    } as never));
  });
}

beforeAll(warmCloudShell, 90_000);

beforeEach(() => {
  installConfirmEnv();
  scriptRefresh(refresh204);
  resetStorageOwnerForTest();
  window.localStorage.clear();
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  resetStorageOwnerForTest();
  await teardownConfirmEnv();
});

const visit = async (hash: string): Promise<void> => {
  window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await tick(1500);
};

async function reopenFirstAccount(hash: string): Promise<void> {
  await act(async () => { root!.unmount(); });
  root = null;
  // The real page leaves by a full load. Here the JS module survives the new document.
  const { bindApiOwner } = await import("../app/api-client");
  bindApiOwner(null);
  rememberOwner();
  const confirm = vi.fn(() => sessionFull());
  scriptSession(confirm);
  window.location.hash = hash;
  await mountEntry(false, "wait");
  await tick(2000);
  expect(confirm, "the returning tab must freshly confirm the original account").toHaveBeenCalled();
}

describe("today's views mounted again under the same frame", () => {
  it("keep the host's scope after the session's marker moved: words before and after a visit elsewhere stand under the frame's account", async () => {
    const FIRST = "First words of A";
    const AFTER = "Words after the way back";
    const LAST_KEYSTROKE = "Words in flight as the account changed";
    scriptSession(() => sessionFull());
    rememberOwner();
    window.location.hash = "#/compose";
    await mountEntry(false);
    await tick(2000);
    expect(subject(), "the composer under the account").not.toBeNull();
    await write(FIRST);
    const started = holding(FIRST);
    expect(started).not.toEqual([]);
    // The tab misses the change signal. An input event arrives before its next browser poll.
    await act(async () => {
      rememberOwner(OTHER);
      fireEvent.change(subject()!, { target: { value: LAST_KEYSTROKE } });
    });
    await tick(1500);
    expect(subject(), "the departing account still accepted input").toBeNull();
    expect(seatedList(), "the departing account still drew mail").toBeNull();
    expect(holding(LAST_KEYSTROKE), "the retirement save lost the original account's last edit").not.toEqual([]);
    expect(holding(LAST_KEYSTROKE).every((k) => namesOwner(k, ACCOUNT, true))).toBe(true);

    await reopenFirstAccount("#/ohbox");
    expect(subject(), "the composer still stands where the seated Ohbox is drawn").toBeNull();
    expect(seatedList(), "the seated Ohbox's list").not.toBeNull();
    await visit("#/compose");
    expect(subject(), "the composer mounted again").not.toBeNull();
    await write(AFTER);
    expect(holding(AFTER), "the returning composer did not save the new words").not.toEqual([]);
    const keys = [...started, ...holding(FIRST), ...holding(LAST_KEYSTROKE), ...holding(AFTER)];
    expect({
      kept: keys.length > 0,
      underTheFrame: keys.every((k) => namesOwner(k, ACCOUNT, true)),
      underTheOther: keys.filter((k) => namesOwner(k, OTHER, true)),
    }).toEqual({ kept: true, underTheFrame: true, underTheOther: [] });
  });
});

describe("the demo opened over a live session, in place", () => {
  it("opens the demo's composer empty, keeps its words under the demo's own word, and leaves the account's half letter where it was", async () => {
    const A_WORDS = "Half a letter of the account";
    const DEMO_WORDS = "Typed in the demo";
    scriptSession(() => sessionFull());
    rememberOwner();
    window.location.hash = "#/compose";
    await mountEntry(false);
    await tick(2000);
    expect(subject(), "the composer under the account").not.toBeNull();
    await write(A_WORDS);
    expect(holding(A_WORDS).length, "the account's words were kept").toBeGreaterThan(0);

    /* A client-side navigation to the demo: the address asks for it and the page hands `demo`. Nothing is unmounted
       by the test. */
    window.history.pushState(null, "", "/?demo=1#/compose");
    await mountEntry(true);
    await tick(4000);
    expect(subject(), "the demo's composer").not.toBeNull();
    expect(subject()!.value, "the demo's composer opened over the account's half letter").toBe("");
    await write(DEMO_WORDS);

    const demoKeys = holding(DEMO_WORDS);
    const accountKeys = holding(A_WORDS);
    expect({
      demoWordsKept: demoKeys.length > 0,
      demoWordsUnderTheDemo: demoKeys.every(namesDemo),
      demoWordsUnderTheAccount: demoKeys.filter((k) => namesOwner(k, ACCOUNT, true)),
      accountWordsKept: accountKeys.length > 0,
      accountWordsUnderTheAccount: accountKeys.every((k) => namesOwner(k, ACCOUNT, true)),
    }).toEqual({
      demoWordsKept: true,
      demoWordsUnderTheDemo: true,
      demoWordsUnderTheAccount: [],
      accountWordsKept: true,
      accountWordsUnderTheAccount: true,
    });
  });
});

describe("the session's marker moves between the session's question and the frame's mount", () => {
  /* The page's word `wait`: the frame is drawn only once the check names the account. Another tab's sign-in moves the
     marker to B while this tab's check, already on its way, answers A. The new page can write after a fresh A answer. */
  const ANSWERED_A = "Words written over the confirmed account's mail";
  async function drawnAfterTheMove(remembered: boolean): Promise<string[]> {
    let answer: (r: Response) => void = () => undefined;
    scriptSession(() => new Promise<Response>((resolve) => { answer = resolve; }));
    if (remembered) rememberOwner();
    window.location.hash = "#/compose";
    await mountEntry(false, "wait");
    await tick(500);
    expect(sessionCalls()).toBe(1);
    expect(subject()).toBeNull();
    rememberOwner(OTHER);
    await act(async () => { answer(sessionFull()); });
    await tick(2000);
    expect(subject(), "a stale confirmation opened a composer over the replacement account").toBeNull();
    expect(seatedList(), "a stale confirmation showed the departing account's mail").toBeNull();
    expect(holding(ANSWERED_A)).toEqual([]);
    await reopenFirstAccount("#/compose");
    expect(subject(), "the composer once the check named the account").not.toBeNull();
    await write(ANSWERED_A);
    return holding(ANSWERED_A);
  }
  const verdict = (keys: string[]) => ({
    kept: keys.length > 0,
    underTheConfirmed: keys.every((k) => namesOwner(k, ACCOUNT, true)),
    underTheOther: keys.filter((k) => namesOwner(k, OTHER, true)),
  });

  it("a remembered mirror: the words stand under the account the engine was opened for, none under the other", async () => {
    expect(verdict(await drawnAfterTheMove(true))).toEqual({ kept: true, underTheConfirmed: true, underTheOther: [] });
  });

  it("no remembered account: the words stand under the account the check named, none under the other", async () => {
    expect(verdict(await drawnAfterTheMove(false))).toEqual({ kept: true, underTheConfirmed: true, underTheOther: [] });
  });
});
