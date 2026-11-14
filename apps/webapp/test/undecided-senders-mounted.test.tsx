/** @vitest-environment jsdom */
import { renderHook, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import { usePileNote } from "@ohmail/app-logic/lists/pile-note";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import {
  ISO, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner, scriptRefresh,
  scriptSession, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

const answer = (pile: "news" | "receipts" | undefined, total: number, complete = true) =>
  () => Response.json({
    groups: total > 0 ? [{ address: "paper@example.invalid", count: total, newestAt: ISO }] : [],
    total, complete, max: 200, ...(pile === undefined ? {} : { pile }),
  });

let installed = false;
let fetchBeforeMount: typeof globalThis.fetch;

beforeAll(warmCloudShell);
beforeEach(() => { fetchBeforeMount = globalThis.fetch; });
afterEach(async () => {
  if (installed) {
    await teardownConfirmEnv();
    installed = false;
  }
  globalThis.fetch = fetchBeforeMount;
});

async function mount(place: "reads" | "receipts", reply: () => Response) {
  installConfirmEnv();
  installed = true;
  window.localStorage.clear();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  const calls: Array<{ method: string; path: string }> = [];
  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    const method = init?.method ?? "GET";
    if (url.pathname !== "/api/screener/unscreened") return fixture(input, init);
    calls.push({ method, path: url.pathname + url.search });
    return reply();
  };
  window.location.hash = `#/${place}`;
  const frame = within(await mountCloudShell());
  await tick(3000);
  const note = () => frame.queryAllByRole("note").find(
    (item) => item.textContent?.includes("senders you never let in")
      || item.textContent?.includes("a sender you never let in"),
  );
  return { calls, note };
}

describe("the row renders through the engine the product actually builds", () => {
  it("the live engine's adapter carries both undecided-sender capabilities", async () => {
    const { createEngine } = await import("../app/shell/engine-config.js");
    const engine = createEngine(false, { NEXT_PUBLIC_API_BASE: "/api" });
    const adapter = (engine as unknown as { adapter: Record<string, unknown> }).adapter;
    expect(typeof adapter.unscreened).toBe("function");
    expect(typeof adapter.screenUnscreened).toBe("function");
  });
});

describe("the undecided-sender row in the Screener header", () => {
  it("both catalogues name the server's Inbox and never the Ohbox", () => {
    const en = messages.screener.unscreenedLead;
    const german = de.screener.unscreenedLead;
    expect(en).toContain("Inbox on your mail server");
    expect(german).toContain("Inbox auf deinem Mailserver");
    for (const lead of [en, german]) expect(lead).not.toMatch(/Ohbox/);
  });
});

describe("the note on News and Receipts", () => {
  it("Receipts asks its own pile, one letter in the singular, and a floor says 'at least'", async () => {
    const receipts = await mount("receipts", answer("receipts", 1));
    expect(receipts.calls).toContainEqual({ method: "GET", path: "/api/screener/unscreened?pile=receipts" });
    expect(receipts.note()?.textContent).toContain("1 letter here is from a sender you never let in.");
    await teardownConfirmEnv();
    installed = false;

    const news = await mount("reads", answer("news", 40, false));
    expect(news.note()?.textContent).toContain("At least 40 letters here are from senders you never let in.");
  });

  it("draws nothing at zero, on a failed read, or from a server that does not say the pile back", async () => {
    const replies = [
      answer("news", 0),
      () => Response.json({ error: { code: "internal", message: "down" } }, { status: 500 }),
      answer(undefined, 12),
    ];
    for (const reply of replies) {
      const news = await mount("reads", reply);
      expect(news.calls).toContainEqual({ method: "GET", path: "/api/screener/unscreened?pile=news" });
      expect(news.note()).toBeUndefined();
      expect(news.calls.filter((call) => call.method === "POST")).toEqual([]);
      await teardownConfirmEnv();
      installed = false;
    }
  });

  it("draws nothing on a door with no such read", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const engine = new OhmailEngine({
      store,
      adapter: {
        sync: async () => ({
          changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: "0", hasMore: false, serverTime: ISO,
        }),
        mutate: async () => ({ changes: [], seq: null }),
        withdrawSend: async () => ({ outcome: "unsupported" }),
        fetchBody: async () => null,
      },
    });
    const hook = renderHook(() => usePileNote(engine, "news", true, () => {}));
    try {
      await act(async () => {});
      expect(hook.result.current).toBeNull();
    } finally {
      hook.unmount();
    }
  });
});
