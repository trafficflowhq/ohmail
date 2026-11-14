/**
 * SEND LATER'S PLAN: no time where none may stand (a forward, files not kept, a file still being read), the files'
 * horizon over the presets and the typed time, and a typed time under the floor refused before the wire.
 */
import { describe, expect, it } from "vitest";
import { laterPlan, type LaterInput } from "../../src/write/later.js";

const OPENED = Date.parse("2026-11-16T09:00:00.000Z");
const at = (h: number): string => new Date(OPENED + h * 3_600_000).toISOString();
const base: LaterInput = {
  openedAt: OPENED,
  floor: OPENED + 3 * 60_000,
  forward: false,
  hasFiles: false,
  files: null,
  attaching: [],
  presets: [
    { id: "evening", at: at(9) },
    { id: "tomorrow", at: at(24) },
    { id: "monday", at: at(24 * 7) },
  ],
  custom: { at: at(2), shifted: null },
};

describe("laterPlan", () => {
  it("offers the presets and a typed time ahead of the floor", () => {
    const p = laterPlan(base);
    expect(p.refusal).toBeNull();
    expect(p.presets.map((x) => x.id)).toEqual(["evening", "tomorrow", "monday"]);
    expect(p.custom?.at).toBe(at(2));
  });

  it("refuses a typed time under the floor", () => {
    const p = laterPlan({ ...base, custom: { at: new Date(OPENED + 60_000).toISOString(), shifted: null } });
    expect(p.custom).toBeNull();
    expect(p.customRefused).toBe("past");
  });

  it("offers no time for a forward, nor for files no server said it keeps", () => {
    expect(laterPlan({ ...base, forward: true }).refusal).toEqual({ why: "forward" });
    expect(laterPlan({ ...base, hasFiles: true }).refusal).toEqual({ why: "filesUnknown" });
    const no = laterPlan({ ...base, hasFiles: true, files: { kept: false, days: null } });
    expect(no.refusal).toEqual({ why: "filesNotHere" });
    expect(no.presets).toEqual([]);
    expect(no.custom).toBeNull();
  });

  it("holds every time while a file is still being read", () => {
    const p = laterPlan({ ...base, attaching: ["photo.jpg", "b.pdf"] });
    expect(p.refusal).toEqual({ why: "attaching", name: "photo.jpg", count: 2 });
    expect(p.presets).toEqual([]);
  });

  it("with kept files, offers only what stands within their horizon, and says it", () => {
    const p = laterPlan({
      ...base,
      hasFiles: true,
      files: { kept: true, days: 2 },
      custom: { at: at(72), shifted: null },
    });
    expect(p.presets.map((x) => x.id)).toEqual(["evening", "tomorrow"]);
    expect(p.customRefused).toBe("tooFar");
    expect(p.horizonDays).toBe(2);
  });

  it("says the appointment waits for this computer where its own engine keeps it", () => {
    expect(laterPlan({ ...base, files: { kept: true, days: null } }).thisComputer).toBe(true);
    expect(laterPlan(base).thisComputer).toBe(false);
  });
});
