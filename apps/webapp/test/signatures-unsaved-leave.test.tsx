/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, getByRole, screen, within } from "@testing-library/react";
import { resetSessionTruthForTests } from "@ohmail/app-logic/session/session-truth";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import {
  act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner, scriptRefresh, scriptSession,
  sessionFull, teardownConfirmEnv, tick, ISO,
} from "./fixtures/cloud-confirm-shell";
import { bindApiOwner, type MailboxDTO } from "../app/api-client";
import messages from "../messages/en.json";
import { settleEditor } from "./_first-paint.js";

/** The current Settings pane holds the editor until a save confirms it, or a leave discards it. */
const S = messages.settings.signatures;
const ADDRESS = "one@example.test";
const mailbox: MailboxDTO = {
  id: "mb-one", address: ADDRESS, provider: "imap", organizerRole: "organizer",
  status: "connected", displayName: null, createdAt: ISO, lastSyncAt: ISO,
  initialImportCompletedAt: ISO, organizeConsentedAt: ISO,
};
let host: HTMLElement;
let writes: unknown[];

async function mount(): Promise<void> {
  writes = [];
  installConfirmEnv();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  rememberOwner();
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const { pathname } = new URL(String(input), window.location.origin);
    if (pathname === "/api/mailboxes") return Response.json({ items: [mailbox] });
    if (pathname === "/api/consent") return Response.json({
      dormancyDays: 90, screeningScope: "window", seedConfirmedAt: ISO, screeningResetAt: null,
      counts: { decidedSenders: 0, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 },
      signatures: { [mailbox.id]: "Anna" },
    });
    if (pathname === "/api/account/screening") {
      return Response.json({ ohboxPolicy: "people_and_replied", ohboxBar: null, defaultBar: "Mail from people I know." });
    }
    if (pathname === "/api/consent/settings" && init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      writes.push(patch);
      return Response.json({
        signatures: patch.signatures ?? { [mailbox.id]: "Anna — on leave" },
        signaturesHtml: patch.signaturesHtml ?? {},
      });
    }
    return fetch(input, init);
  };
  window.history.replaceState(null, "", "#/settings/signatures");
  host = await mountCloudShell();
  await tick(2500);
  await settleEditor();
}

const sheet = () => getByRole(host, "heading", { name: ADDRESS }).closest<HTMLElement>('[data-kind="plain"]')!;
const editor = () => getByRole(sheet(), "textbox", { name: `Signature: ${ADDRESS}` });
const type = async (words: string): Promise<void> => {
  const { editor: rich } = editor() as HTMLElement & {
    editor?: { commands: { focus: (at: string) => void; insertContent: (s: string) => void } };
  };
  if (!rich) throw new Error("the signature editor did not mount");
  await act(() => { rich.commands.focus("end"); rich.commands.insertContent(words); });
  await tick(0);
};
const press = async (el: Element): Promise<void> => {
  await act(() => { fireEvent.click(el); });
  await tick(100);
};
const goOhbox = () => press(getByRole(host, "button", { name: "Ohbox" }));
const question = () => screen.queryByRole("alertdialog", { name: S.leaveAsk }) ??
  screen.queryByRole("dialog", { name: S.leaveAsk });
const onSettings = () => screen.queryByRole("heading", { name: ADDRESS }) !== null;

afterEach(async () => {
  await teardownConfirmEnv();
  bindApiOwner(null);
  resetSessionTruthForTests();
  resetStorageOwnerForTest();
  window.history.replaceState(null, "", "/");
});

describe("leaving Signatures with an edited signature asks", () => {
  it("the rail's verb is held: Keep editing stays with the words, Discard leaves unsaved", async () => {
    await mount();
    await type(" — on leave");
    await goOhbox();
    expect(onSettings(), "the pane was left and the draft dropped").toBe(true);
    expect(window.location.hash).toBe("#/settings/signatures");
    expect(question()).not.toBeNull();

    await press(within(question()!).getByRole("button", { name: S.leaveKeep }));
    expect(question()).toBeNull();
    expect(editor().textContent).toContain("on leave");

    await goOhbox();
    await press(within(question()!).getByRole("button", { name: S.revert }));
    expect(onSettings()).toBe(false);
    expect(window.location.hash).toBe("#/ohbox");
    expect(writes).toHaveLength(0);
  });

  it("a Back press or a link is held too, and the address goes back to the pane", async () => {
    await mount();
    await type(" — on leave");
    await act(async () => { window.location.hash = "#/screener"; });
    await tick(100);
    expect(onSettings()).toBe(true);
    expect(window.location.hash).toBe("#/settings/signatures");
    expect(question()).not.toBeNull();
  });

  it("closing the tab asks while edited, and not after the Save", async () => {
    await mount();
    const unload = (): boolean => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(unload()).toBe(false);
    await type(" — on leave");
    expect(unload()).toBe(true);
    await press(getByRole(sheet(), "button", { name: S.save }));
    expect(writes).toHaveLength(1);
    expect(unload()).toBe(false);
  });

  it("CONTROL: with nothing edited, leaving goes without a question", async () => {
    await mount();
    await goOhbox();
    expect(onSettings()).toBe(false);
    expect(question()).toBeNull();
  });
});
