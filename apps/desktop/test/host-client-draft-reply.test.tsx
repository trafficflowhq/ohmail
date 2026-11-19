/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { NONE } from "@ohmail/app/host";
import type { DraftReplyWire } from "@ohmail/app-logic/writing/draft-reply";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { capturePairedFrame } from "./paired-frame-capture.js";

/**
 * DRAFT REPLY ON A PAIRED BROWSER. `HostGate` handed the shared shell no draft wire, so the control
 * fell back to this artifact's refusing Cloud stub and said "Drafting needs a connected account."
 * The host serves both routes out of `localRoutes`; this file measures that the gate hands in a
 * wire, that its two calls ride the bearer door, and that a missing model names the host computer.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("the paired browser's draft reply", () => {
  it("hands draft replies to the frame through the paired computer", async () => {
    const requests = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => String(input) === "/messages/m1/draft"
      ? Response.json({ draftId: "d1" }, { status: 202 })
      : Response.json({ body: "Thursday works.", html: null }));
    const host = await capturePairedFrame(requests);
    expect(host.wires.draftReply).not.toBe(NONE);
    const wire = host.wires.draftReply as DraftReplyWire;
    expect(wire.configured()).toBe(true);
    expect(wire.noModel).toBe("noModelHost");
    await expect(wire.create("m1", "one-press")).resolves.toEqual({ draftId: "d1" });
    await expect(wire.read("d1")).resolves.toMatchObject({ body: "Thursday works.", html: null });
    const relevant = requests.mock.calls.filter(([input]) => /^\/(messages|drafts)\//.test(String(input)));
    expect(relevant.map(([input, init]) => [String(input), init?.method ?? "GET"])).toEqual([
      ["/messages/m1/draft", "POST"], ["/drafts/d1", "GET"],
    ]);
    expect(new Headers(relevant[0]![1]?.headers).get("Idempotency-Key")).toBe("one-press");
    expect(relevant.map(([, init]) => new Headers(init?.headers).get("Authorization"))).toEqual([
      "Bearer a1", "Bearer a1",
    ]);
  });

  it("the host's route table serves both", () => {
    expect(read("packages/api/src/routes/desktop-host.ts")).toContain("...localRoutes,");
    const local = read("packages/api/src/routes/local.ts");
    expect(local).toContain("...messageRoutes,");
    expect(local).toContain("...draftsRoutes,");
    expect(read("packages/api/src/routes/messages.ts")).toMatch(/method: "POST",\s*pattern: "\/messages\/:id\/draft"/);
    expect(read("packages/api/src/routes/drafts.ts")).toMatch(/method: "GET",\s*pattern: "\/drafts\/:id"/);
  });
});
