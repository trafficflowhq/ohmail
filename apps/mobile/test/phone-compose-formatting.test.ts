import { expect, it } from "vitest";
import { editRuns, markupOf, runsOf, toggleMark } from "../src/compose/formatting";

it("formats only the selected words and escapes typed tags", () => {
  const body = "Bring <cups>\nThanks";
  const result = toggleMark([{ text: body, marks: [] }], 6, 12, "strong");
  const html = "<p>Bring <strong>&lt;cups&gt;</strong><br>Thanks</p>";
  expect(markupOf(result)).toBe(html);
  expect(runsOf(body, html)).toEqual(result);
  expect(markupOf(toggleMark(result, 6, 12, "strong"))).toBeUndefined();
});

it("keeps the formatting of unedited words and restores only markup this editor understands", () => {
  const html = "<p>Bring <em>cups</em></p>";
  const runs = runsOf("Bring cups", html)!;
  expect(markupOf(editRuns(runs, "Please bring cups"))).toBe("<p>Please bring <em>cups</em></p>");
  expect(runsOf("Bring cups", "<p>Bring <a href='/x'>cups</a></p>")).toBeNull();
  expect(runsOf("Bring bowls", html)).toBeNull();
});

it("keeps indentation and repeated spaces across mark boundaries when a draft reopens", () => {
  const body = "  One  two\n  Three";
  const runs = toggleMark([{ text: body, marks: [] }], 2, 6, "strong");
  const html = markupOf(runs)!;
  expect(html).toBe("<p>&nbsp; <strong>One </strong>&nbsp;two<br>&nbsp; Three</p>");
  expect(runsOf(body, html)).toEqual(runs);
});


it("reopens formatted drafts with the nonbreaking characters stored by the server", () => {
  const body = "  One  two\n  Three";
  const runs = toggleMark([{ text: body, marks: [] }], 2, 6, "strong");
  const stored = markupOf(runs)!.replaceAll("&nbsp;", "\u00a0");
  expect(runsOf(body, stored)).toEqual(runs);
});
