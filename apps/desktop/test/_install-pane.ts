import { cleanup, render, screen } from "@testing-library/react";
import { createElement as h } from "react";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { vi } from "vitest";
import { clearTestCatalogue, installTestCatalogue } from "../../../test/support/web-catalogues.js";
import { DesktopGate } from "../src/DesktopGate.js";
import { desktopPaneLabel } from "../src/DesktopSettings.js";
import type { EngineStatus } from "../src/bridge-fetch.js";

export type DesktopPaneRequest = { method: unknown; url: unknown; path: string; body: unknown };
type Answer = { body: unknown; status?: number };

export function encodeDesktopAnswer({ body, status = 200 }: Answer): Uint8Array {
  const encoder = new TextEncoder();
  const meta = encoder.encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const data = encoder.encode(JSON.stringify(body));
  const out = new Uint8Array(4 + meta.length + data.length);
  new DataView(out.buffer).setUint32(0, meta.length, false);
  out.set(meta, 4);
  out.set(data, 4 + meta.length);
  return out;
}

function emptyResponse(path: string): Answer {
  if (path === "/health") return { body: { signedIn: true, sessionExpired: false } };
  if (path === "/mailboxes") return { body: { items: [] } };
  if (path === "/local/ai") return { body: {}, status: 404 };
  if (path === "/sync/snapshot") {
    return { body: { asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } } };
  }
  return {
    body: {
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "MA", hasMore: false, serverTime: "2026-01-01T00:00:00.000Z",
    },
  };
}

/** Mount a native Settings section with replies at the native command boundary. */
export async function mountInstallPane({
  status, locale = "en", section = "desktop", answer,
}: {
  status: EngineStatus;
  locale?: "en" | "de";
  section?: "desktop" | "mailboxes";
  answer: (request: DesktopPaneRequest) => Answer | undefined | Promise<Answer | undefined>;
}): Promise<HTMLElement> {
  const messages = installTestCatalogue(locale);
  window.history.replaceState(null, "", `#/settings/${section}`);
  vi.stubGlobal("fetch", async () => { throw new Error("unexpected network request"); });
  vi.stubGlobal("__TAURI_INTERNALS__", {
    transformCallback: () => 1,
    invoke: async (command: string, payload?: Record<string, unknown>) => {
      if (command === "engine_status") return status;
      if (command !== "engine_request") return null;
      const { method, url, body } = payload ?? {};
      const path = String(url ?? "").split("?")[0]!;
      return encodeDesktopAnswer(await answer({ method, url, path, body }) ?? emptyResponse(path));
    },
  });
  render(h(IntlProvider, {
    locale, messages: messages as never, timeZone: "UTC",
    children: h(ThemeProvider, { storageKey: null, children: h(ToastHost, null, h(DesktopGate)) }),
  }));
  return screen.findByRole("region", { name: section === "desktop" ? desktopPaneLabel() : messages.settings.mailboxes });
}

export function cleanInstallPane(): void {
  cleanup();
  vi.unstubAllGlobals();
  clearTestCatalogue();
  window.history.replaceState(null, "", "/");
  localStorage.clear();
}
