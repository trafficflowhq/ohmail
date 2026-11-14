/** @vitest-environment jsdom */
/**
 * WHOSE KEYS TODAY'S VIEWS KEEP, ON THE WEB'S REAL ENTRY (`CloudShell`): the scope its host hands, whatever the
 * session's marker says while the views stand. A person's words are kept under the account whose mail they were written
 * over, and under no other key.
 */
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import messages from "../messages/en.json";
import { DEMO_STORAGE_OWNER, namesOwner, resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import {
  ACCOUNT, ISO, act, installConfirmEnv, rememberOwner, scriptSession, sessionFull, teardownConfirmEnv, tick,
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

beforeEach(() => {
  installConfirmEnv();
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

describe("today's views mounted again under the same frame", () => {
  it("keep the host's scope after the session's marker moved: words before and after a visit elsewhere stand under the frame's account", async () => {
    const FIRST = "First words of A";
    const AFTER = "Words after the way back";
    scriptSession(() => sessionFull());
    rememberOwner();
    window.location.hash = "#/compose";
    await mountEntry(false);
    await tick(2000);
    expect(subject(), "the composer under the account").not.toBeNull();
    await write(FIRST);
    /* Another tab signs in as B: the jar's marker names B while A's frame stands. */
    document.cookie = `tf_owner=${OTHER}; Path=/`;
    await visit("#/ohbox");
    expect(subject(), "today's composer still stands where the seated Ohbox is drawn").toBeNull();
    expect(seatedList(), "the seated Ohbox's list").not.toBeNull();
    await visit("#/compose");
    expect(subject(), "the composer mounted again").not.toBeNull();
    await write(AFTER);
    const keys = [...holding(FIRST), ...holding(AFTER)];
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
     marker to B while this tab's check, already on its way, answers A. */
  const ANSWERED_A = "Words written over the confirmed account's mail";
  async function drawnAfterTheMove(remembered: boolean): Promise<string[]> {
    let answer: (r: Response) => void = () => undefined;
    scriptSession(() => new Promise<Response>((resolve) => { answer = resolve; }));
    if (remembered) rememberOwner();
    window.location.hash = "#/compose";
    await mountEntry(false, "wait");
    await tick(500);
    document.cookie = `tf_owner=${OTHER}; Path=/`;
    await act(async () => { answer(sessionFull()); });
    await tick(2000);
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
