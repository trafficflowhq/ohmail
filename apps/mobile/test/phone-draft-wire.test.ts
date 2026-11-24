import { describe, expect, it, vi } from "vitest";
import * as composer from "../src/net/consent";

const session = (fetch: (url: string, init?: unknown) => Promise<Response>, standalone = false) => ({
  fetch, standalone, profile: { origin: "https://mail.example.test", apiBase: "https://mail.example.test/api" },
});

describe("Draft from text on the phone", () => {
  it("uses the paired draft door, keeps the purchase key, and only reads the resulting draft", async () => {
    const fetch = vi.fn(async (_url: string, _init?: unknown) => new Response(JSON.stringify({ draftId: "written", body: "Draft words." })));
    const wire = composer.phoneDraftWire(session(fetch));
    if (wire === "none" || wire.fromText === "none") throw new Error("Expected a drafter");
    expect(await wire.fromText({ text: "Notes", mailboxId: "studio" }, "one-press")).toEqual({ draftId: "written" });
    expect(await wire.read("written")).toEqual({ body: "Draft words." });
    expect(fetch.mock.calls).toEqual([
      ["https://mail.example.test/api/drafts/from-text", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "one-press" },
        body: JSON.stringify({ text: "Notes", mailboxId: "studio" }),
      }],
      ["https://mail.example.test/api/drafts/written", undefined],
    ]);
  });

  it("offers no draft purchase on a standalone phone or when the account turned it off", () => {
    const fetch = vi.fn();
    expect(composer.phoneDraftWire(session(fetch, true))).toBe("none");
    expect(composer.phoneDraftWire(session(fetch), false)).toBe("none");
    expect(fetch).not.toHaveBeenCalled();
  });
});
