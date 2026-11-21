/** @vitest-environment jsdom */
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, message, mountShell, stubDom, unmountAll } from "./_draft-shell.js";

beforeEach(() => stubDom());
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
});

describe("the answer Search shows", () => {
  it("shows the exact match count and the measured wait", async () => {
    const match = message("kiln", { subject: "Kiln inventory" });
    const asked: string[] = [];
    const now = vi.spyOn(performance, "now");
    await mountShell("#/search", [match], [], {
      prepareEngine: (engine) => {
        engine.serverSearchAvailable = () => true;
        engine.searchServer = async (query, opts) => {
          if (opts?.parts === "page") {
            asked.push(query);
            now.mockReturnValue(109);
          }
          return {
            state: "ready", items: opts?.parts === "page" ? [match] : [],
            total: 936, totalEstimate: null, totalExact: true,
            tier: "exact", ms: 13, nextCursor: null, bounded: false, indexed: null, facets: null,
          };
        };
      },
    });

    const search = await screen.findByRole("textbox", { name: "Search" });
    now.mockReturnValue(0);
    await act(async () => { fireEvent.change(search, { target: { value: "kiln" } }); });
    const count = await screen.findByRole("heading", { name: "Results 936" });
    expect(asked).toEqual(["kiln"]);
    expect(count.textContent).toBe("Results936");
    const wait = await within(search.parentElement!).findByText("109 ms", { exact: true });
    expect(wait.closest("[hidden], [aria-hidden=true]")).toBeNull();
    const answer = within(search.closest<HTMLElement>("[data-filter-list]")!).getByRole("status");
    expect(answer.textContent).toBe("Searched your whole mailbox — 936 matched · 109 ms");
  });
});
