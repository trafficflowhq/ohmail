/** @vitest-environment jsdom */
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import messages from "../../messages/en.json";
import { reportSays } from "../ohbox/_finders";
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
