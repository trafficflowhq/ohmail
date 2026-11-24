/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DoorsContext } from "@ohmail/app-logic/reader/doors";
import type { ScreenerSenderDTO } from "@ohmail/wire";
import DOMPurify from "dompurify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import readerWords from "../../../packages/app/messages/reader.en.json" with { type: "json" };
import { Frame } from "../../../packages/app/src/frame/index.js";
import { NONE } from "../../../packages/app/src/host/index.js";
import { mailReader } from "../../../packages/app/src/mail/reader-parts.js";
import { letterBody } from "../../../packages/app/src/reader/body/index.js";
import { ScreenerAbove, screenerPlace } from "../../../packages/app/src/screener/index.js";
import { TextProvider } from "../../../packages/app/src/text/index.js";
import { fakeHost, SEAM_AT_REST } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeAppearance } from "../../../packages/app/test/support/fake-window.js";
import { BESIDE, TestConsent, modelOf, screenerEngine, sender, WORDS } from "../../../packages/app/test/screener/screener-world.js";

const designed = '<table width="600" bgcolor="#ffffff" cellpadding="0"><tr><td><h1>Designed</h1><p>Original body</p></td></tr></table>';
const reader = mailReader({ body: letterBody, look: NONE });
const reading = () => within(screen.getByRole("region", { name: "Reading" }));

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(html: string | null) {
  const screened = sender("kept", "Held correspondent", {
    held: [{ id: "held", time: "09:00", subject: "Held letter", snippet: "Preview" }],
  }) as ScreenerSenderDTO;
  const model = modelOf({ flushes: 0 }, { screenedOut: [screened] });
  const { engine } = screenerEngine({ held: { state: "ready", text: "Original body", html } });
  const { host } = fakeHost({
    engine: { ...SEAM_AT_REST, ...engine } as typeof engine,
    reader, scope: "acct-1", service: "self", places: { screener: screenerPlace },
    address: fakeAddress("#/screener/screened"), appearance: fakeAppearance({ face: "paper", scheme: "dark" }),
  });
  const useHeldParts = reader.useHeldParts!;
  function ScreenedMail() {
    const letters = useHeldParts();
    return <ScreenerAbove model={model} beside={{ ...BESIDE, letters }}><Frame host={host} /></ScreenerAbove>;
  }
  render(
    <TextProvider locale="en" messages={{ ...WORDS.en, ...readerWords }} timeZone="UTC">
      <DoorsContext.Provider value={{ files: undefined, pictures: undefined }}>
        <TestConsent scope="acct-1" transport="none">
          <ScreenedMail />
        </TestConsent>
      </DoorsContext.Provider>
    </TextProvider>,
  );
}

it("switches the held message between dark adaptation and original colours", () => {
  mount(designed);
  const subject = reading().getByRole("heading", { name: "Held letter" });
  const original = reading().getByRole("button", { name: "Original" });
  const frame = reading().getByTitle<HTMLIFrameElement>("Message content");
  const dark = () => frame.contentDocument?.documentElement?.hasAttribute("data-ohmail-dark");
  expect(frame.getAttribute("srcdoc")).toContain("Designed");
  fireEvent.load(frame);
  expect(dark()).toBe(true);
  expect(subject.compareDocumentPosition(original) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(original.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(original);
  expect(dark()).toBe(false);
  fireEvent.click(reading().getByRole("button", { name: "Adapt to dark" }));
  expect(dark()).toBe(true);
});

it("offers plain text without appearance controls", () => {
  mount(null);
  expect(reading().getByText("Original body")).toBeTruthy();
  expect(reading().queryByRole("button", { name: "Original" })).toBeNull();
  expect(reading().queryByTitle("Message content")).toBeNull();
});

it("uses the sanitized letter when returning to Screened out", () => {
  const sanitize = vi.spyOn(DOMPurify, "sanitize");
  mount(designed);
  expect(reading().getByTitle("Message content")).toBeTruthy();
  const count = sanitize.mock.calls.length;
  expect(count).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Spam" }));
  expect(screen.queryByRole("heading", { name: "Held letter" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Screened out/ }));
  expect(reading().getByTitle("Message content")).toBeTruthy();
  expect(sanitize.mock.calls).toHaveLength(count);
});
