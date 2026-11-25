/** @vitest-environment jsdom */
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import messages from "../../messages/en.json";
import { reportSays } from "../ohbox/_finders";
import { typeInto } from "../fixtures/rich-editor-driver";
async function demo(width: number, route: string): Promise<void> {
  vi.stubGlobal("React", React);
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: width === 390 && query.includes("max-width"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.scrollTo ??= () => {};
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  localStorage.clear();
  window.location.hash = `#/${route}`;
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const { DemoShell } = await import("../../app/(product)/demo/DemoShell");

  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <ThemeProvider storageKey={null}>
        <ToastHost>
          <DemoShell serverDemo says={{ service: "managed", sendCeiling: "strict" }} />
        </ToastHost>
      </ThemeProvider>
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  resetStorageOwnerForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("opening mail in the demo", () => {
  it.each([
    { pile: "Parked", route: "triage/aside", row: /Alpenbahn/, body: "Sitzplatz 44" },
    { pile: "Resurface", route: "triage/resurface", row: /Domain renewal/i, body: "Auto-renew is off" },
  ])("opens the $pile message and its reader actions", async ({ pile, route, row, body }) => {
    await demo(1440, route);
    for (let visit = 0; visit < 2; visit++) {
      const list = await screen.findByRole("listbox", { name: pile });
      fireEvent.click(await within(list).findByRole("option", { name: row }));
      await screen.findByText(new RegExp(body));
      expect(screen.getByRole("button", { name: "Reply" })).toBeTruthy();
      if (visit === 0) {
        await act(async () => { window.location.hash = "#/ohbox"; });
        await screen.findByRole("heading", { name: "Ohbox" });
        await act(async () => { window.location.hash = `#/${route}`; });
      }
    }
  });

  it.each([
    { width: 1440, start: "search" },
    { width: 390, start: "ohbox" },
  ])("opens a blank Write editor from $start at $width pixels", async ({ width, start }) => {
    await demo(width, start);
    fireEvent.click(await screen.findByRole("button", { name: "Write" }));
    const subject = await screen.findByRole<HTMLInputElement>("textbox", { name: "Subject" });
    expect(subject.value).toBe("");
    expect(screen.queryByRole("button", { name: "Use draft" })).toBeNull();
    expect((await screen.findByRole("textbox", { name: "Message" })).textContent).toBe("");
  });
});

describe("recovering deleted demo mail", () => {
  it.each([1440, 390])("opens the moved letter in Trash at %i pixels", async (width) => {
    await demo(width, "ohbox");
    const subject = /Your talk is in!/;
    fireEvent.click(await screen.findByRole("option", { name: subject }));
    const reader = await screen.findByRole("region", { name: "Open message" });
    fireEvent.click(within(reader).getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirmation = screen.queryByRole("dialog", { name: "Move to Trash" });
    if (confirmation) fireEvent.click(within(confirmation).getByRole("button", { name: "Move" }));

    await waitFor(() => expect(reportSays()).toContain("Moved to Trash"), { timeout: 12_000 });
    if (width === 1440) {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "g" });
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "t" });
    } else {
      fireEvent.click(await screen.findByRole("button", { name: "More" }));
      const drawer = await screen.findByRole("dialog", { name: "More" });
      const trash = within(drawer).getByRole("button", { name: "Trash" });
      expect(trash).toHaveProperty("disabled", false);
      fireEvent.click(trash);
    }

    const trash = await screen.findByRole("listbox", { name: "Trash" });
    fireEvent.click(await within(trash).findByRole("option", { name: subject }));
    const trashedLetter = await screen.findByRole("region", { name: subject });
    expect(within(trashedLetter).getByText(/made the final program/)).toBeTruthy();
    const restore = within(trashedLetter).getByRole("button", { name: "Restore" });
    if (width === 1440) {
      fireEvent.click(restore);
      await waitFor(() => expect(reportSays()).toContain("Restoring to Ohbox"), { timeout: 12_000 });
      fireEvent.click(screen.getByRole("button", { name: /^Ohbox/ }));
      expect(await screen.findByRole("option", { name: subject })).toBeTruthy();
    }
  }, 30_000);
});
it("keeps the demo's narrow Write open until its latest words are in one draft", async () => {
  const gates = Array.from({ length: 3 }, () => {
    let answer!: () => void;
    const pending = new Promise<void>((resolve) => { answer = resolve; });
    return { pending, answer };
  });
  let asked = 0;
  const mutate = FixturesAdapter.prototype.mutate;
  const save = vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(async function (
    this: FixturesAdapter, mutation, options,
  ) {
    if (mutation.kind === "draft_save") await gates[asked++]?.pending;
    return mutate.call(this, mutation, options);
  });
  await demo(390, "ohbox");
  const subject = "An unfinished demo letter";
  const body = "Keep all of these words.";
  fireEvent.click(await screen.findByRole("button", { name: "Write" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "Subject" }), { target: { value: subject } });
  const editor = await screen.findByRole("textbox", { name: "Message" });
  const writes = () => save.mock.calls.flatMap(([m]) => m.kind === "draft_save" ? [m] : []);
  try {
    await act(async () => { typeInto(editor, "Keep all"); });
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 5_000 });
    fireEvent.click(within(screen.getByRole("region", { name: "New message" })).getByRole("button", { name: "Ohbox" }));
    await act(async () => { typeInto(editor, "Keep all of these"); });
    await act(async () => { gates[0]!.answer(); });
    await waitFor(() => expect(writes()).toHaveLength(2));
    await act(async () => { typeInto(editor, body); });
    await act(async () => { gates[1]!.answer(); });
    await waitFor(() => expect(writes()).toHaveLength(3));
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(editor);
    expect(writes()).toEqual([
      expect.objectContaining({ body: "Keep all", draftId: null }),
      expect.objectContaining({ body: "Keep all of these", draftId: expect.any(String) }),
      expect.objectContaining({ body, draftId: writes()[1]!.draftId }),
    ]);
  } finally {
    await act(async () => { for (const gate of gates) gate.answer(); });
  }
  await screen.findByRole("heading", { name: "Ohbox" });

  fireEvent.click(screen.getByRole("button", { name: "More" }));
  const more = await screen.findByRole("dialog", { name: "More" });
  fireEvent.click(within(more).getByText("Drafts", { exact: true }));
  const list = await screen.findByRole("listbox", { name: "Drafts" });
  const saved = await within(list).findByRole("option", { name: new RegExp(subject) });
  fireEvent.click(saved);
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe(body));
}, 15_000);
