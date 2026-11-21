/** @vitest-environment jsdom */
/**
 * THE SIGN-INS OHMAIL SIGNED OUT BECAUSE AN OLDER COPY USED THEM, OVER THE NEW SHELL's DOOR (the switch's point 66: a
 * security notice). The web's account strip says it in the frame's one slot: the sentence, the advice as its line
 * (change the password if none of that happened), OK and Details. Details opens the list over the app, each swept
 * sign-in by its client and its date, and closes again; OK sends one acknowledgement with the ids, and the notice
 * leaves.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_BASE = "/api";
});

import en from "../../messages/en.json";
import { act, message, mountShell, stubDom, unmountAll, waitFor } from "../_draft-shell.js";

const S = en.settings;
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let sweeps: { id: string; at: string; client: string }[] = [];
let acks: unknown[] = [];

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

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
  sweeps = [
    { id: randomUUID(), at: "2026-09-26T18:32:49.000Z", client: "desktop-linux" },
    { id: randomUUID(), at: "2026-09-25T07:10:00.000Z", client: "web" },
  ];
  acks = [];
  document.cookie = "tf_owner=acct_A; Path=/";
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
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
  it("says the advice in its line and offers OK and Details; the list stands only behind Details", async () => {
    await read();
    await mountShell("#/ohbox", [message("m1")], [], { accountNotices: true });
    await waitFor(() => slot().includes("ohmail signed out 2 older copies of your sign-in"), "the sweeps' notice");
    expect(slot()).toContain("change your password in Settings → Account");
    expect(button(S.reuseSweepsOk), "OK").not.toBeNull();
    expect(button(S.reuseSweepsDetails), "Details").not.toBeNull();
    expect(dialog()).toBeNull();
    expect(document.body.textContent).not.toContain(S.reuseClientLinux);
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
