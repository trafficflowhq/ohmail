/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineMessage } from "@ohmail/wire";
import messages from "../../messages/en.json";
import { act, message, mountShell, stubDom, unmountAll, waitFor } from "../_draft-shell.js";

const seen = vi.hoisted(() => ({ mounts: 0, live: 0 }));

vi.mock("@ohmail/app-logic/ohbox", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/ohbox")>();
  const { useEffect } = await import("react");
  return {
    ...real,
    useOhboxLive: (...args: Parameters<typeof real.useOhboxLive>) => {
      const model = real.useOhboxLive(...args);
      useEffect(() => {
        seen.mounts += 1;
        seen.live += 1;
        return () => {
          seen.live -= 1;
        };
      }, []);
      return model;
    },
  };
});

async function visit(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}
async function rounds(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
}
/** Today's Ohbox view, by the one name its section had; the seated place draws none. */
const todaysOhbox = (): Element | null => document.querySelector(".view-ohbox");
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
const newsFeed = (): HTMLElement | null => document.querySelector(`[aria-label="${messages.reads.streamAria}"] [data-reading-scroll]`);

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
  seen.mounts = 0;
  seen.live = 0;
});
afterEach(async () => {
  await unmountAll();
});

describe("News scroll position", () => {
  it("remembers the News offset across an Ohbox visit", async () => {
    await mountShell("#/ohbox", [
      message("m1"), message("m2"), message("news", { folder: "ohmail/Reads" as EngineMessage["folder"], unread: true }),
    ]);
    await waitFor(() => rows().length === 2, "the seated list's two rows");
    expect({ live: seen.live, view: todaysOhbox() !== null }, "at the seated Ohbox").toEqual({ live: 1, view: false });

    await visit("#/reads");
    await waitFor(() => newsFeed() !== null, "News's feed");
    const news = newsFeed()!;
    news.scrollTop = 64;
    expect({ live: seen.live, view: todaysOhbox() !== null, rows: rows().filter((row) => ["m1", "m2"].includes(row.dataset.id ?? "")).length }, "at News").toEqual({ live: 0, view: false, rows: 0 });

    await visit("#/ohbox");
    await waitFor(() => rows().length === 2, "the seated list again");
    expect({ live: seen.live, mounts: seen.mounts, view: todaysOhbox() !== null }, "back at the Ohbox").toEqual({
      live: 1, mounts: 2, view: false,
    });
    await visit("#/reads");
    await rounds(4);
    expect(newsFeed()?.scrollTop, "News lost its scroll position").toBe(64);
  }, 60_000);

});
