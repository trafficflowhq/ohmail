/** @vitest-environment jsdom */
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, message, mountShell, stubDom, unmountAll } from "./_draft-shell.js";

beforeEach(() => stubDom());
afterEach(unmountAll);

describe("the answer Search shows", () => {
  it("shows the exact match count and the measured wait", async () => {
    const match = message("kiln", { subject: "Kiln inventory" });
    const asked: string[] = [];
    await mountShell("#/search", [match], [], {
      prepareEngine: (engine) => {
        engine.serverSearchAvailable = () => true;
        engine.searchServer = async (query) => {
          asked.push(query);
          return {
            state: "ready", items: [match], total: 936, totalEstimate: null, totalExact: true,
            tier: "exact", ms: 109, nextCursor: null, bounded: false, indexed: null, facets: null,
          };
        };
      },
    });

    const search = await screen.findByRole("textbox", { name: "Search" });
    await act(async () => { fireEvent.change(search, { target: { value: "kiln" } }); });
    await screen.findByText("936", { exact: true });
    expect(asked).toContain("kiln");
    expect(screen.getByRole("heading", { name: /Results/ }).textContent).toContain("936");
    const wait = await screen.findByText(/^\d+ ms$/);
    expect(wait.closest("[hidden], [aria-hidden=true]")).toBeNull();
  });
});
