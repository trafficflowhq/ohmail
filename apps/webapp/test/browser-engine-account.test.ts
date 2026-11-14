/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import * as shell from "./fixtures/cloud-confirm-shell";
import { confirmSyncOwner } from "@ohmail/app-logic/session/sync-scheduler";
import { resetResumeLaneForTests } from "@ohmail/app-logic/session/resume-lane";
import { IndexedDbMirrorStore } from "@ohmail/client-engine";

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  resetResumeLaneForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
});

it.each([
  { replyOwner: "other-account", retry: false, admitted: false },
  { replyOwner: null, retry: false, admitted: false },
  { replyOwner: "other-account", retry: true, admitted: false },
  { replyOwner: shell.ACCOUNT, retry: true, admitted: true },
])("checks the named sync reply before persisting it (renewal $retry, admitted $admitted, reply $replyOwner)",
  async ({ replyOwner, retry, admitted }) => {
    const { bindApiOwner } = await import("../app/api-client");
    const { createEngine } = await import("../app/shell/engine-config");
    const owner = shell.ACCOUNT;
    shell.rememberOwner(owner);
    bindApiOwner(owner);
    let syncs = 0;
    let renewals = 0;
    const expected: (string | null)[] = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (input.startsWith("/api/sync/snapshot")) return new Response(null, { status: 404 });
      if (input !== "/auth/refresh" && !input.startsWith("/api/sync?")) return new Response(null, { status: 404 });
      expected.push(new Headers(init?.headers).get("X-Ohmail-Expected-Account"));
      if (input === "/auth/refresh") {
        renewals += 1;
        return new Response(null, { status: 204, headers: { "X-Ohmail-Account": owner } });
      }
      syncs += 1;
      if (retry && syncs === 1) return new Response(null, { status: 401 });
      const page = shell.syncPage("Synthetic mail");
      if (replyOwner === null) page.headers.delete("X-Ohmail-Account");
      else page.headers.set("X-Ohmail-Account", replyOwner);
      return page;
    });
    const engine = createEngine(false, { NEXT_PUBLIC_API_BASE: "/api" }, owner);
    confirmSyncOwner(engine, owner);
    const mirror = new IndexedDbMirrorStore({ owner });
    try {
      await engine.hydrate();
      if (admitted) await engine.syncOnce();
      else await expect(engine.syncOnce()).rejects.toBeDefined();
      await mirror.load();
      expect(mirror.get("message", "m_Synthetic_mail") !== undefined).toBe(admitted);
      expect(syncs).toBe(retry ? (admitted ? 3 : 2) : 1);
      expect(renewals).toBe(retry ? 1 : 0);
      expect(expected).toEqual(Array.from({ length: syncs + renewals }, () => owner));
    } finally {
      mirror.close();
      engine.dispose();
      bindApiOwner(null);
    }
  });

it("calendar settings and a queued retry use the engine's account binding", async () => {
  const { bindApiOwner } = await import("../app/api-client");
  const { createEngine } = await import("../app/shell/engine-config");
  const owner = shell.ACCOUNT;
  shell.rememberOwner(owner);
  bindApiOwner(owner);
  const accounts: (string | null)[] = [];
  vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
    accounts.push(new Headers(init?.headers).get("X-Ohmail-Expected-Account"));
    return new Response(JSON.stringify({}), {
      headers: { "Content-Type": "application/json", "X-Ohmail-Account": "other-account" },
    });
  });
  const engine = createEngine(false, { NEXT_PUBLIC_API_BASE: "/api" }, owner);
  confirmSyncOwner(engine, owner);
  try {
    const calendar = engine.calendarTransport();
    expect(calendar).not.toBeNull();
    await expect(calendar!.calendarSettings()).rejects.toBeDefined();
    await expect(calendar!.retryCalendarWrite(crypto.randomUUID(), crypto.randomUUID())).rejects.toBeDefined();
    expect(accounts).toEqual([owner, owner]);
  } finally {
    engine.dispose();
    bindApiOwner(null);
  }
});
