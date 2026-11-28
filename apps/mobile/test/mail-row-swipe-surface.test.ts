/**
 * THE SHAPE GUARD, AND IT IS ONLY THAT.
 *
 * Whether a swiped row is clipped and opaque is a fact about PIXELS, and this suite has no React
 * Native renderer — so the behaviour is measured on a device, by
 * the device rig's swipe-clip reader, which reads two frames of the same
 * row and refuses a row that draws past its card or lets the verb behind show through it. What is
 * kept here is the SHAPE that reading depends on, so a rewrite cannot quietly take it away: the
 * clip on the parent that does not move, the surface token on the one that does. Neither assertion
 * claims the visual fact; the frame reader does.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bracketSpan, withoutComments } from "../../../scripts/lib/source-scan.mjs";

const ROW = fileURLToPath(new URL("../src/ui/MailRow.tsx", import.meta.url));
const BASE = fileURLToPath(new URL("../src/ui/base.tsx", import.meta.url));
const MAILLIST = fileURLToPath(new URL("../src/ui/MailList.tsx", import.meta.url));
const LISTS = [
  "../app/(tabs)/index.tsx", "../app/history.tsx", "../app/folder/[id].tsx",
].map((p) => fileURLToPath(new URL(p, import.meta.url)));

const RECEIPTS = fileURLToPath(new URL("../app/(tabs)/receipts.tsx", import.meta.url));

/** A file with its comments blanked — a needle must not be satisfiable by prose about the fix. */
function source(path: string): string {
  return withoutComments(readFileSync(path, "utf8"));
}

/** The `{…}` object of the first `style={{` at or after `from`, as text. */
function styleObjectAfter(src: string, from: number): { at: number; body: string } {
  const at = src.indexOf("style={{", from);
  expect(at, "a style={{…}} after index " + String(from)).toBeGreaterThan(-1);
  const s = bracketSpan(src, at + "style={".length, "{", "}");
  expect(s.closed, "the style object closes").toBe(true);
  return { at, body: src.slice(s.start, s.end) };
}

describe("a swiped row is a clipped, opaque surface", () => {
  const src = source(ROW);
  const branch = src.indexOf("if (swipe !== true) return row;");
  const panAt = src.indexOf("responder.panHandlers", branch);

  it("the row this suite cannot render still has the swipe branch these needles read", () => {
    expect(branch).toBeGreaterThan(-1);
    expect(panAt).toBeGreaterThan(branch);
  });

  it("the CLIP is on the parent that stands still, never on the view the gesture moves", () => {
    /* Clipping a translated view to its own bounds clips nothing — the bounds travel with it. That
       was written once, proved present in the running bundle and changed nothing on the device, so
       the guard states which of the two views carries it rather than that somebody carries it. */
    const parent = styleObjectAfter(src, branch);
    expect(parent.at).toBeLessThan(panAt);
    expect(parent.body).toMatch(/overflow:\s*"hidden"/);
    expect(parent.body).toMatch(/borderRadius:\s*receipt\s*\?\s*t\.radius\.card\s*:\s*t\.radius\.row\b/);

    const moving = styleObjectAfter(src, panAt);
    expect(moving.body).toMatch(/transform:\s*\[\s*\{\s*translateX:\s*pan\.x/);
    expect(moving.body, "the moving view must not be the one that clips").not.toMatch(/overflow/);
  });

  it("the moving row carries a THEME SURFACE, not a colour somebody typed", () => {
    const moving = styleObjectAfter(src, panAt);
    const token = /backgroundColor:\s*t\.c\.([A-Za-z][A-Za-z0-9]*)\b/.exec(moving.body);
    expect(token, "backgroundColor reads a theme token").not.toBeNull();
    expect(moving.body).not.toMatch(/backgroundColor:\s*["'#]/);
    expect(token?.[1]).toBe("panel");
  });

  it("and `panel` is the surface every list that offers the gesture actually puts it on", () => {
    /* The token above is right only while the rows rest on the l1 panel face. The rows now sit on
       `MailList`'s one surface, painted with `panelSurface(t)` at its default level — so the face
       is read for the l1 token, the primitive for painting it at the default, and the ordinary lists
       for mounting `MailList` with its surface on. Receipt cards carry the same token on the
       moving surface and clip at their own rounded edge. */
    expect(source(BASE)).toMatch(/level\s*===\s*"l1"\s*\?\s*t\.c\.panel\s*:\s*t\.c\.float/);
    expect(source(BASE)).toMatch(/export function panelSurface\(t: Theme, level: PanelLevel = "l1"/);
    expect(source(MAILLIST)).toContain("panelSurface(t)");
    for (const list of LISTS) {
      const text = source(list);
      expect(text, list + " renders its rows through MailList").toMatch(/<MailList[\s>]/);
      expect(text, list + " keeps the panel under its rows").not.toMatch(/surface=\{false\}/);
    }
    const receipts = source(RECEIPTS);
    expect(receipts, "Receipts renders its cards through the virtualized list").toMatch(/<MailList[\s>]/);
    expect(receipts, "Receipt cards carry the swipe surface themselves").toMatch(/surface=\{false\}/);
    const row = receipts.slice(receipts.indexOf("renderRow="), receipts.indexOf("surface={false}"));
    expect(row, "The list cell opens its own receipt").toContain("const read = () => openRow(m.id);");
    const faces = /t\.mail\s*\?\s*\(\s*<ReceiptPreview m=\{m\} onRead=\{read\}\s+render=\{\(preview\) => (<MailRow[^>]*\/>)\} \/>\s*\)\s*:\s*(<MailRow[^>]*\/>)/.exec(row);
    expect(faces, "The list cell renders the Paper preview and the other face").not.toBeNull();
    const swipe = "<MailRow m={m} onPress={read} swipe receipt";
    expect(faces?.[1]?.replace(/\s+/g, " "), "Paper's swipe row receives the preview content").toBe(
      `${swipe} receiptHead={preview.receiptHead} receiptBody={preview.receiptBody} receiptDetail={preview.receiptDetail} />`,
    );
    expect(faces?.[2], "The other face uses the same swipe row and open handler").toBe(`${swipe} />`);
    const card = receipts.slice(receipts.indexOf("function ReceiptPreview("));
    expect(card, "The Paper card carries its calendar affordances inside the swipe surface").toMatch(
      /return render\(\{[\s\S]*receiptDetail:\s*\(\s*<>\s*<EventCards[^\n]*\/>\s*<MailFoundEvents found=\{found\} \/>/,
    );
  });
});
