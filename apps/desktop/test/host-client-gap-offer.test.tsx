/** @vitest-environment jsdom */
/* @reads: packages/api/src/routes/desktop-host.ts packages/api/src/routes/local.ts packages/api/src/routes/mailboxes.ts */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { gapLettersVia } from "../src/gap-letters-wire.js";
import { capturePairedFrame } from "../../../test/paired-host/paired-frame-capture.js";

/**
 * THE GAP OFFER ON A PAIRED DEVICE (the host door). The host counts the offer and serves
 * its answer (`desktopHostRoutes` spreads `localRoutes`), but the gate handed the shared shell no
 * transport, and the shell withholds an offer nothing can answer — so a device paired to the desktop
 * never drew it. Measured at the seam: the gate hands one in, and it rides the bearer to that route.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("the gap offer's answer on a device paired to this desktop", () => {
  it("answers the exact mailbox offer through the wire handed to the frame", async () => {
    const requests = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ outcome: "pressed" }));
    const host = await capturePairedFrame(requests);
    expect(host.wires.gapLetters).not.toBe("none");
    const wire = host.wires.gapLetters as ReturnType<typeof gapLettersVia>;
    const answer = { file: true, count: 3, strangers: 1 };
    await expect(wire("mb-1", answer)).resolves.toBeUndefined();
    const relevant = requests.mock.calls.filter(([input]) => String(input).endsWith("/gap-letters"));
    expect(relevant.map(([input, init]) => [String(input), init?.method, JSON.parse(String(init?.body))])).toEqual([
      ["/mailboxes/mb-1/gap-letters", "POST", answer],
    ]);
  });

  it("the route it asks for is served on the paired-device table", () => {
    expect(read("packages/api/src/routes/desktop-host.ts")).toContain("...localRoutes,");
    expect(read("packages/api/src/routes/local.ts")).toContain("...mailboxRoutes,");
    expect(read("packages/api/src/routes/mailboxes.ts")).toContain('pattern: "/mailboxes/:id/gap-letters"');
  });
});
