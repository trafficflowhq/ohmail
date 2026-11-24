/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { en } from "../../../test/support/web-catalogues.js";
import { BearerManager } from "../src/bearer.js";
import { HostGate } from "../src/HostGate.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.location.hash = "";
});

it("changes the Ohbox preference through the paired computer's registered Screener pane", async () => {
  const preference = { ohboxPolicy: null, ohboxBar: null, defaultBar: "People who write to me themselves." };
  const patch = vi.fn(() => ({ ...preference, ohboxPolicy: "people_only" }));
  const bearer = new BearerManager({
    storage: localStorage,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      switch (url.split("?")[0]) {
        case "/account/screening":
          return Response.json(init?.method === "PATCH" ? patch() : preference);
        case "/mailboxes":
        case "/screener/auto-filed":
          return Response.json({ items: [], more: false });
        case "/sync/snapshot":
          return Response.json({
            asOfSeq: 0,
            changes: [],
            nextCursor: null,
            window: { days: 90, minRows: 500 },
          });
        default:
          return Response.json({}, { status: 404 });
      }
    }) as never,
  });
  bearer.adopt({ accessToken: "fixture", refreshToken: "fixture" }, { fresh: true });
  window.location.hash = "#/settings/screener";
  render(
    <NextIntlClientProvider locale="en" messages={en as never} timeZone="UTC">
      <ThemeProvider storageKey={null}>
        <ToastHost>
          <HostGate bearer={bearer} />
        </ToastHost>
      </ThemeProvider>
    </NextIntlClientProvider>,
  );

  const pane = within(await screen.findByRole("region", { name: en.settings.screener }));
  const posture = await pane.findByRole("switch", { name: en.settings.screening.postureTitle });
  await act(async () => {
    fireEvent.click(posture);
  });
  expect(patch).toHaveBeenCalledTimes(1);
  expect(posture.getAttribute("aria-checked")).toBe("true");
});
