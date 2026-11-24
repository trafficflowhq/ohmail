/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import messages from "../messages/en.json";
import {
  ACCOUNT, act, installConfirmEnv, ISO, mountCloudShell, refresh204, rememberOwner, scriptRefresh,
  scriptSession, sessionFull, teardownConfirmEnv, tick,
} from "./fixtures/cloud-confirm-shell";

describe("the Settings copy names the machine that fetches the pictures", () => {
  it("CONTROL: the Cloud door keeps the proxy sentence it can keep", async () => {
    const { bindApiOwner } = await import("../app/api-client");
    installConfirmEnv();
    try {
      rememberOwner();
      scriptRefresh(refresh204);
      scriptSession(sessionFull);
      const replies = (body: unknown): Response =>
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      const writes: unknown[] = [];
      const pictures: string[] = [];
      const consent = {
        seedConfirmedAt: ISO,
        screeningResetAt: null,
        dormancyDays: 60,
        counts: { decidedSenders: 0, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 },
        blockRemoteImagesAt: null as string | null,
        loadTrackingPixelsAt: ISO as string | null,
      };
      const fetchShell = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const path = new URL(String(input), window.location.origin).pathname;
        if (path === "/api/hello") {
          return replies({ product: "ohmail", needsSetup: false, features: { pairing: false, remoteImages: true } });
        }
        if (path === "/api/consent") return replies(consent);
        if (path === "/api/consent/settings" && init?.method === "PATCH") {
          const body = JSON.parse(String(init.body)) as { blockRemoteImages?: boolean; blockTrackingPixels?: boolean };
          writes.push(body);
          if (body.blockRemoteImages !== undefined) {
            consent.blockRemoteImagesAt = body.blockRemoteImages ? ISO : null;
            return replies({ blockRemoteImagesAt: consent.blockRemoteImagesAt });
          }
          consent.loadTrackingPixelsAt = body.blockTrackingPixels ? null : ISO;
          return replies({ loadTrackingPixelsAt: consent.loadTrackingPixelsAt });
        }
        if (/\/(img|load-remote|remote-images)(\/|$)/.test(path)) pictures.push(path);
        return fetchShell(input, init);
      };

      window.location.hash = "#/settings";
      const frame = await mountCloudShell();
      await tick(3000);
      const nav = within(frame).getByRole("navigation", { name: messages.settings.navAria });
      await act(async () => { within(nav).getByRole("button", { name: messages.settings.general }).click(); });
      await tick(250);
      expect(window.location.hash).toBe("#/settings/general");
      const pane = within(within(frame).getByRole("region", { name: messages.settings.general }));
      const { images, pixels } = messages.settings;

      expect(pane.queryByText(/through our proxy|asks first|sender can tell/i)).toBeNull();
      const control = (name: string) => within(pane.getByRole("group", { name })).getByRole("switch");
      expect(control(images.title).getAttribute("aria-checked")).toBe("true");
      expect(control(pixels.title).getAttribute("aria-checked")).toBe("false");
      expect(writes).toEqual([]);
      await act(async () => { control(images.title).click(); });
      await tick(25);
      await act(async () => { control(pixels.title).click(); });
      await tick(25);
      expect(writes).toEqual([{ blockRemoteImages: true }, { blockTrackingPixels: true }]);
      expect(control(images.title).getAttribute("aria-checked")).toBe("false");
      expect(control(pixels.title).getAttribute("aria-checked")).toBe("true");

      const previous = control(images.title) as HTMLButtonElement;
      expect(previous.disabled).toBe(false);
      bindApiOwner("acct_image_copy_other");
      await act(async () => { control(images.title).click(); });
      await tick(25);
      expect(writes).toEqual([{ blockRemoteImages: true }, { blockTrackingPixels: true }]);
      expect(control(images.title).getAttribute("aria-checked")).toBe("false");
      expect(pane.getByText(images.failed, { exact: false })).toBeTruthy();
      expect(pictures).toEqual([]);
    } finally {
      bindApiOwner(ACCOUNT);
      await teardownConfirmEnv();
      bindApiOwner(null);
    }
  });
});
