/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chromium, pageOf } from "../support/browser-page.js";
import { letter, mountReader } from "./support/mail.js";

const ANSWERED = "2026-09-09T08:15:00.000Z";
const ARRIVED = "2026-09-09T07:00:00.000Z";
const LABEL = "Answered by the away responder";
const ANNOUNCEMENT = `${LABEL} Wed 9 Sep 2026, 10:15`;
const mark = () => screen.queryByRole("note", { name: new RegExp(LABEL) });

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-09T10:15:00.000Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function open(
  patch: Partial<EngineMessage>,
  lang: "en" | "de" = "en",
  size: "phone" | "desktop" = "desktop",
) {
  return mountReader({
    letters: [letter("roundup", { date: ARRIVED, ...patch })],
    open: "roundup",
    lang,
    size,
  });
}

it("marks the original letter with the responder's time and its full accessible announcement", () => {
  open({ awayRepliedAt: ANSWERED });
  const note = screen.getByRole("note", { name: ANNOUNCEMENT });
  expect(note.textContent).toBe(`${LABEL} · 10:15`);
  expect(note.textContent).not.toContain("09:00");
  expect(note.hasAttribute("tabindex")).toBe(false);
  expect(note.querySelector("a,button,input,[tabindex]")).toBeNull();
});

it.each([
  ["an unanswered letter", { awayRepliedAt: null }],
  ["a letter from an older mirror", {}],
  ["the person's own reply", { local: true, awayRepliedAt: ANSWERED }],
  ["a Sent copy", { folder: "Sent" as EngineMessage["folder"], awayRepliedAt: ANSWERED }],
  ["the responder's reply", { autoReplyByUs: true, awayRepliedAt: ANSWERED }],
] satisfies [string, Partial<EngineMessage>][])("omits the mark on %s", (_case, patch) => {
  open(patch);
  expect(mark()).toBeNull();
});

it("keeps the claim without a separator or date when the stored instant is malformed", () => {
  open({ awayRepliedAt: "not-a-date" });
  const note = screen.getByRole("note", { name: LABEL });
  expect(note.textContent).toBe(LABEL);
  expect(note.textContent).not.toContain("Invalid Date");
});

it("uses the German catalogue and formats the exact instant in German", () => {
  open({ awayRepliedAt: ANSWERED }, "de");
  const note = screen.getByRole("note", { name: /Vom Abwesenheitsassistenten beantwortet.*\bMi\b.*10:15/ });
  expect(note.textContent).toBe("Vom Abwesenheitsassistenten beantwortet · 10:15");
});

it("keeps the exact announcement at phone width while hiding the separator and visible time", async () => {
  const mounted = open({ awayRepliedAt: ANSWERED }, "en", "phone");
  expect(mark()?.textContent).toBe(`${LABEL} · 10:15`);
  const html = pageOf({ html: mounted.view.container.outerHTML, root: 'data-device="phone"' });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(html);
    const note = page.getByRole("note", { name: ANNOUNCEMENT });
    expect(await note.innerText()).toBe(LABEL);
  } finally {
    await browser.close();
  }
});
