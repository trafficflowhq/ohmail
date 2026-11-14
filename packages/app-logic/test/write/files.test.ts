/**
 * A LETTER'S FILES, the two commits: a pick admitted against the list as it stands (twins skipped, the ceiling
 * held, in pick order), and a quality move landed over the whole list (shrinks first, grows while they fit).
 */
import { describe, expect, it } from "vitest";
import type { ComposeAttachment } from "@ohmail/client-engine";
import { admit, base64Bytes, letterCap, requalified, type Picked } from "../../src/write/files.js";

const file = (filename: string, n: number, fill = "A"): ComposeAttachment => ({
  filename,
  contentType: "application/octet-stream",
  contentBase64: Buffer.from(fill.repeat(n)).toString("base64"),
});
const picked = (a: ComposeAttachment, compressedFrom?: number): Picked => ({
  attachment: a,
  bytes: base64Bytes(a.contentBase64),
  originalBytes: compressedFrom ?? base64Bytes(a.contentBase64),
  compressed: compressedFrom !== undefined,
});

describe("admit", () => {
  it("skips a twin of a file on the letter and of one earlier in the same pick", () => {
    const on = file("a.txt", 10);
    const r = admit(
      [on],
      [picked(file("a.txt", 10)), picked(file("b.txt", 10)), picked(file("b.txt", 10))],
      1000,
    );
    expect(r.list.map((a) => a.filename)).toEqual(["a.txt", "b.txt"]);
    expect(r.twice).toEqual(["a.txt", "b.txt"]);
  });

  it("refuses what would cross the ceiling, says the ceiling, and admits a later file that fits", () => {
    const r = admit([file("a", 60)], [picked(file("big", 50)), picked(file("small", 30))], 100);
    expect(r.list.map((a) => a.filename)).toEqual(["a", "small"]);
    expect(r.refusedAt).toBe(100);
  });

  it("hands back the same list when nothing was added", () => {
    const latest = [file("a", 5)];
    expect(admit(latest, [picked(file("a", 5))], 100).list).toBe(latest);
  });

  it("totals what the shrink saved on the files added", () => {
    const r = admit([], [picked(file("p.jpg", 20), 80)], 100);
    expect(r.saved).toEqual({ from: 80, to: 20 });
  });
});

describe("requalified", () => {
  it("lands shrinks first, then grows while the whole list stays under the ceiling; a grow over it keeps its bytes", () => {
    const a = file("a.jpg", 40, "a");
    const b = file("b.jpg", 40, "b");
    const smaller = file("b.jpg", 10, "b");
    const bigger = file("a.jpg", 70, "a");
    const r = requalified(
      [a, b],
      new Map([
        [a, picked(bigger)],
        [b, picked(smaller)],
      ]),
      100,
    );
    expect(r.list).toEqual([bigger, smaller]);
    expect(r.kept).toBe(false);
    const tight = requalified([a, b], new Map([[a, picked(bigger)]]), 100);
    expect(tight.list).toEqual([a, b]);
    expect(tight.kept).toBe(true);
  });

  it("collapses two rows whose targets are the same file", () => {
    const a = file("x.png", 10, "x");
    const twin = file("x.png", 20, "y");
    const r = requalified([a, twin], new Map([[twin, picked(file("x.png", 10, "x"))]]), 1000);
    expect(r.list).toEqual([a]);
  });
});

describe("letterCap", () => {
  it("binds to the window when it carries less than a measured mailbox", () => {
    const c = letterCap(50 * 1024 * 1024, 1024);
    expect(c).toEqual({ bytes: 1024, binding: "surface" });
    expect(letterCap(null, "mailbox").binding).toBe("unmeasured");
  });
});
