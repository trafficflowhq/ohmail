/** @vitest-environment jsdom */
/**
 * AT THE SEATED OHBOX THE OHBOX'S MODEL HAS ONE MOUNT, AND NOTHING OF TODAY'S OHBOX VIEW IS IN THE DOCUMENT. The real
 * shell as a host mounts it: the hosts' own places hand the Ohbox's entry, and the composition above the panes feeds
 * it. Leaving for News and coming back mounts the model once again, and News's list is the one it was (the kept
 * pile, not built again). And the rail's number at the seated Ohbox is the old shell's fed one: the count today's
 * rail said.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../../messages/en.json";
import { act, message, mountShell, stubDom, unmountAll, waitFor } from "../_draft-shell.js";

const seen = vi.hoisted(() => ({ mounts: 0, live: 0 }));

vi.mock("@ohmail/app-logic/ohbox", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/ohbox")>();
  const { useEffect } = await import("react");
  return {
    ...real,
    useOhboxList: (...args: Parameters<typeof real.useOhboxList>) => {
      const model = real.useOhboxList(...args);
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
const newsFeed = (): Element | null => document.querySelector(`[aria-label="${messages.reads.streamAria}"]`);
/** The rail's entry for the Ohbox, as the frame draws the fed model. */
const railOhbox = (): HTMLElement | null => document.querySelector<HTMLElement>('nav [data-rail-id="ohbox"] button');

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
  seen.mounts = 0;
  seen.live = 0;
});
afterEach(async () => {
  await unmountAll();
});

describe("what every web host is handed", () => {
  it("the Ohbox is its own entry, fed from above its two columns; every other place is one of today's; the reader is the shell's", async () => {
    const { todaysPlaces, isTodays } = await import("../../app/shell/todays-places");
    const { todaysReader } = await import("../../app/shell/reader-parts");
    const { useTodaysSupplies } = await import("../../app/shell/todays-supplies");
    const { renderHook } = await import("@testing-library/react");
    const { NONE } = await import("@ohmail/app/host");
    const places = todaysPlaces();
    const { ohbox, ...others } = places;
    expect(ohbox, "the Ohbox's own entry").toMatchObject({
      id: "ohbox", body: "ohbox", panes: { kind: "columns", Reading: "reader" },
    });
    expect(ohbox !== NONE && ohbox.panes.kind === "columns" && typeof ohbox.panes.Above, "what the composition feeds it stands above its columns").toBe("function");
    expect(isTodays(ohbox), "a seated place is none of today's").toBe(false);
    expect(Object.values(others).map((place) => (place === NONE ? "none" : place.body)), "every other place is today's body").toEqual(
      Object.values(others).map(() => "today"),
    );
    expect(Object.values(others).every((place) => isTodays(place)), "and reads as one of today's").toBe(true);
    expect(isTodays(NONE), "a place a host hands none of is none of today's").toBe(false);
    const { result, unmount } = renderHook(() => useTodaysSupplies(NONE));
    expect(result.current.reader, "the supplies hand the shell's reader").toBe(todaysReader);
    expect(result.current.reader, "and it is not none").not.toBe(NONE);
    unmount();
  });
});

describe("the seated Ohbox stands once", () => {
  it("one mount of the model at the Ohbox, none of today's view; News and back: one mount again, News kept", async () => {
    await mountShell("#/ohbox", [message("m1"), message("m2")]);
    await waitFor(() => rows().length === 2, "the seated list's two rows");
    expect({ live: seen.live, view: todaysOhbox() !== null }, "at the seated Ohbox").toEqual({ live: 1, view: false });

    await visit("#/reads");
    await waitFor(() => newsFeed() !== null, "News's feed");
    const news = newsFeed();
    expect({ live: seen.live, view: todaysOhbox() !== null, rows: rows().length }, "at News").toEqual({ live: 0, view: false, rows: 0 });

    await visit("#/ohbox");
    await waitFor(() => rows().length === 2, "the seated list again");
    expect({ live: seen.live, mounts: seen.mounts, view: todaysOhbox() !== null }, "back at the Ohbox").toEqual({
      live: 1, mounts: 2, view: false,
    });
    await visit("#/reads");
    await rounds(4);
    expect(newsFeed(), "News's list was built again").toBe(news);
  }, 60_000);

  it("the rail's number at the seated Ohbox is the fed rail's: the same the old shell says at a view of today's", async () => {
    const unread = { unread: true };
    await mountShell("#/history", [message("m1", unread), message("m2", unread), message("m3")]);
    await waitFor(() => railOhbox()?.getAttribute("aria-label") != null, "the rail's counted Ohbox entry at History");
    const today = railOhbox()!.getAttribute("aria-label");
    expect(today, "today's rail counts the Ohbox's two unread").toMatch(/2/);

    await visit("#/ohbox");
    await waitFor(() => rows().length === 3, "the seated list");
    expect(railOhbox()?.getAttribute("aria-label"), "the rail's Ohbox entry at the seated Ohbox").toBe(today);
  }, 60_000);
});
