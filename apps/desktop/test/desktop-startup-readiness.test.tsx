/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@ohmail/ui";
import { expect, it, vi } from "vitest";
import { DesktopGate } from "../src/DesktopGate.js";
import { DesktopLocale } from "../src/DesktopLocale.js";
import type { EngineStatus } from "../src/bridge-fetch.js";

it("leaves the opening screen promptly when the native engine is ready", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let status: EngineStatus = { state: "starting", mode: "local" };
  vi.stubGlobal("__TAURI_INTERNALS__", {
    transformCallback: () => 1,
    invoke: async (command: string) => {
      if (command === "engine_status") return status;
      if (command === "engine_request") return new Promise(() => {});
      return null;
    },
  });
  const node = document.body.appendChild(document.createElement("div"));
  const root = createRoot(node);
  try {
    await act(async () => {
      root.render(
        <DesktopLocale>
          <ThemeProvider>
            <DesktopGate />
          </ThemeProvider>
        </DesktopLocale>,
      );
    });
    expect(node.textContent).toContain("Opening your mailbox");

    status = { state: "serving", mode: "local", mailboxId: "mailbox", credentialState: "ready" };
    await act(async () => vi.advanceTimersByTimeAsync(50));

    expect(node.textContent).not.toContain("Opening your mailbox");
  } finally {
    await act(async () => root.unmount());
    node.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
