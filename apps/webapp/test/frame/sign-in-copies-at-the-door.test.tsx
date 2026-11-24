/** @vitest-environment jsdom */
/**
 * The account strip shows when older copies of a sign-in ended. It keeps the organizing deadline
 * visible if the account page fails to open. For older sign-in copies, it offers the sentence
 * and the OK and Details actions. Details opens the advice and the list over the app, each swept
 * sign-in by its client and its date, and closes again; OK sends one acknowledgement with the ids, and the notice
 * leaves.
 */
import { randomUUID } from "node:crypto";
import { createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_BASE = "/api";
});

import en from "../../messages/en.json";
import { dayStamp } from "@ohmail/app-logic/text/format";
import { act, message, mountShell, stubDom, unmountAll, waitFor } from "../_draft-shell.js";

const S = en.settings;
const settings = createTranslator({ locale: "en", messages: en, namespace: "settings" });
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let sweeps: { id: string; at: string; client: string }[] = [];
let acks: unknown[] = [];
let lifecycle: { state: "grace" | "past_due"; graceUntil: string } | null = null;

const button = (name: string, within: ParentNode = document): HTMLButtonElement | null =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name) ?? null;
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]');
const rows = (): string[] => [...(dialog()?.querySelectorAll('[role="listitem"]') ?? [])].map((r) => r.textContent ?? "");
const slot = (): string =>
  [...document.querySelectorAll('[role="status"]')].map((el) => el.textContent ?? "").join(" | ");

/** The session read the web's confirm makes, which publishes the feed for this jar's owner. */
async function read(): Promise<void> {
  const { auth } = await import("../../app/api-client");
  await act(async () => { await auth.session(); });
}

beforeEach(async () => {
  const { forgetAccess } = await import("../../app/api-client");
  forgetAccess();
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
  sweeps = [
    { id: randomUUID(), at: "2026-09-26T18:32:49.000Z", client: "desktop-linux" },
    { id: randomUUID(), at: "2026-09-25T07:10:00.000Z", client: "web" },
  ];
  acks = [];
  lifecycle = null;
  document.cookie = "tf_owner=acct_A; Path=/";
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/account/access") && lifecycle !== null) {
      return json({ metered: true, canAddMailbox: true, mailboxes: 1, lifecycle });
    }
    if (u.includes("/account/manage-link")) {
      return json({ error: { code: "unavailable" } }, 503);
    }
    if (u.includes("/auth/reuse-sweeps/ack")) {
      acks.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    if (u.includes("/auth/session")) {
      return json({
        scope: "full",
        user: { userId: "u-a", accountId: "acct_A", email: "a@example.invalid", displayName: "A" },
        reuseSweeps: sweeps,
      });
    }
    return json({});
  });
});
afterEach(async () => {
  await unmountAll();
  vi.unstubAllGlobals();
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
});

describe("the sign-ins ohmail signed out, in the new shell's notice slot", () => {
  it("offers OK and Details; the advice and list stand behind Details", async () => {
    await read();
    await mountShell("#/ohbox", [message("m1")], [], { accountNotices: true });
    await waitFor(() => slot().includes(settings("reuseSweepsTitle", { count: 2 })), "the sweeps' notice");
    expect(button(S.reuseSweepsOk), "OK").not.toBeNull();
    expect(button(S.reuseSweepsDetails), "Details").not.toBeNull();
    expect(dialog()).toBeNull();
    expect(document.body.textContent).not.toContain(S.reuseClientLinux);
    expect(slot()).not.toContain(S.reuseSweepsBody);
    await act(async () => { button(S.reuseSweepsDetails)!.click(); });
    await waitFor(() => dialog()?.textContent?.includes(S.reuseSweepsBody) === true, "the password advice");
  }, 30_000);

  it("Details names each swept sign-in by its client and its date, with the advice, and closes again", async () => {
    await read();
    await mountShell("#/ohbox", [message("m1")], [], { accountNotices: true });
    await waitFor(() => button(S.reuseSweepsDetails) !== null, "Details");
    await act(async () => { button(S.reuseSweepsDetails)!.click(); });
    await waitFor(() => dialog() !== null, "the list over the app");
    const listed = rows();
    expect(listed).toHaveLength(2);
    expect(listed[0]).toContain(S.reuseClientLinux);
    expect(listed[0]).toContain("2026");
    expect(listed[1]).toContain(S.reuseClientWeb);
    expect(dialog()!.textContent).toContain("change your password in Settings → Account");
    await act(async () => { button("Close", dialog()!)!.click(); });
    expect(dialog()).toBeNull();
    expect(acks).toEqual([]);
    expect(button(S.reuseSweepsDetails), "the notice stands after the list closed").not.toBeNull();
  }, 30_000);

  it("OK sends one acknowledgement with every id, and the notice leaves", async () => {
    await read();
    await mountShell("#/ohbox", [message("m1")], [], { accountNotices: true });
    await waitFor(() => button(S.reuseSweepsOk) !== null, "OK");
    await act(async () => { button(S.reuseSweepsOk)!.click(); });
    await waitFor(() => acks.length === 1, "the acknowledgement");
    expect(acks).toEqual([{ ids: sweeps.map((s) => s.id) }]);
    await waitFor(() => !slot().includes("older copies"), "the notice leaves");
  }, 30_000);
});


it.each([
  ["grace", en.accountLifecycle.subscribe],
  ["past_due", en.accountLifecycle.fixPayment],
] as const)("the frame keeps the %s deadline when the account page fails to open", async (state, label) => {
  const deadline = "2026-09-27T12:00:00.000Z";
  lifecycle = { state, graceUntil: deadline };
  sweeps = [];
  await read();
  await mountShell("#/ohbox", [message("m1")], [], { accountNotices: true });
  const line = en.accountLifecycle.organizingUntil.replace("{date}", dayStamp(deadline));
  await waitFor(() => slot().includes(line), "the organizing deadline");

  await act(async () => { button(label)!.click(); });
  await waitFor(() => slot().includes(en.accessLock.mintFailed), "the account page refusal");
  expect(slot()).toContain(line);
}, 30_000);
