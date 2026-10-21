import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { SEARCH_LANES_KEPT, SEARCH_LANE_HEADER, createSearchLanes } from "../src/search-lanes.js";

/**
 * THE LANE REGISTRY: a newer generation supersedes the older requests still pending, an older one is
 * stale on arrival, one generation never supersedes itself; answered entries go, and at most
 * {@link SEARCH_LANES_KEPT} lanes are kept, the least recently used dropped.
 */
const req = (lane: string | null, path = "/search", method = "GET"): Request =>
  new Request(`http://local${path}?q=x`, { method, headers: lane === null ? {} : { [SEARCH_LANE_HEADER]: lane } });
const refused = (t: { supersede: { check(): void } }): boolean => {
  try { t.supersede.check(); return false; } catch (err) { return (err as { code?: string }).code === "search_superseded"; }
};

describe("the search lanes", () => {
  it("a newer generation supersedes the older pending ones, not its own", async () => {
    const lanes = createSearchLanes();
    const a1 = lanes.admit(req("w1.1"))!;
    const a1b = lanes.admit(req("w1.1"))!;
    expect(refused(a1) || refused(a1b), "one generation never supersedes itself").toBe(false);
    const b = lanes.admit(req("w1.2"))!;
    expect(refused(a1)).toBe(true);
    expect(refused(a1b)).toBe(true);
    expect(refused(b)).toBe(false);
    await expect(a1.supersede.turn()).rejects.toMatchObject({ code: "search_superseded", httpStatus: 409 });
    await expect(b.supersede.turn()).resolves.toBeUndefined();
    const late = lanes.admit(req("w1.1"))!;
    expect(refused(late), "an older generation is stale on arrival").toBe(true);
    const other = lanes.admit(req("w2.1"))!;
    expect(refused(other), "another lane is untouched").toBe(false);
    for (const t of [a1, a1b, b, late, other]) t.done();
    expect(lanes.census()).toEqual({ lanes: 2, pending: 0 });
  });

  /**
   * A TURN CROSSES ONE POLL PHASE. A statement runs synchronously, so a request that arrives during
   * it waits in the pipe; one `setImmediate` runs in the check phase before the next read, two let
   * the read in first. The request here comes from a child process, as the window's frames do.
   */
  it("a turn after a statement lets a request that arrived during it supersede first", async () => {
    const lanes = createSearchLanes();
    const busy = (ms: number): void => { const end = performance.now() + ms; while (performance.now() < end) { /* a statement */ } };
    const child = spawn(process.execPath, ["-e", "process.stdout.write('1'); setTimeout(() => process.stdout.write('2'), 20); setTimeout(() => {}, 2000)"]);
    try {
      const verdict = await new Promise<string>((resolve) => {
        child.stdout.on("data", (d: Buffer) => {
          for (const c of String(d)) {
            if (c === "2") lanes.admit(req("w1.2"));
            if (c !== "1") continue;
            const a = lanes.admit(req("w1.1"))!;
            busy(300);
            a.supersede.turn().then(() => resolve("answered"), (err: { code?: string }) => resolve(String(err.code)));
          }
        });
      });
      expect(verdict, "the request read during the statement superseded it").toBe("search_superseded");
    } finally {
      child.kill();
    }
  });

  it("only a GET /search with a well-formed header joins a lane", () => {
    const lanes = createSearchLanes();
    for (const bad of [null, "", "Wx.1", "w1", "w1.", "w1.-1", "w1.1.2", "w1.1234567890123456", `${"a".repeat(33)}.1`]) {
      expect(lanes.admit(req(bad)), String(bad)).toBeNull();
    }
    expect(lanes.admit(req("w1.1", "/messages"))).toBeNull();
    expect(lanes.admit(req("w1.1", "/search", "POST"))).toBeNull();
    expect(lanes.census()).toEqual({ lanes: 0, pending: 0 });
  });

  it("keeps the most recently used lanes", () => {
    const lanes = createSearchLanes();
    for (let i = 0; i <= SEARCH_LANES_KEPT; i++) lanes.admit(req(`w${i}.1`))!.done();
    expect(lanes.census().lanes).toBe(SEARCH_LANES_KEPT);
    // `w0` was dropped: its old generation is no longer known to be stale.
    expect(refused(lanes.admit(req("w0.0"))!)).toBe(false);
    expect(refused(lanes.admit(req(`w${SEARCH_LANES_KEPT}.0`))!)).toBe(true);
  });
});
