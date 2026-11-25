/** @vitest-environment jsdom */
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import messages from "../../messages/en.json";
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
