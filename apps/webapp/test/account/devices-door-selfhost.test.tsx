/** @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { fireEvent, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en, json, serve, type Server } from "./account-harness";
import { hello, scanned } from "./devices-support";
import {
  act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, sessionFull, teardownConfirmEnv, tick,
} from "../fixtures/cloud-confirm-shell";
import { resetSessionTruthForTests } from "@ohmail/app-logic/session/session-truth";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import { bindApiOwner } from "../../app/api-client";

/**
 * THE SELF-HOSTED ARM OF WHERE A PAIRING LINK POINTS. One flavour a process: this file is the self-hosted build,
 * where the page's own origin answers the API at its root, so the link a device scans is on this page's origin. A
 * link on the managed service's origin here would point a household's phone at somebody else's server.
 */

/* The build's flavour, set before any module under test loads: it is read as they load. */
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_OHMAIL_FLAVOR = "selfhost";
});
afterAll(() => {
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
});

const MADE = createHash("sha256").update("devices-door-selfhost fixture").digest("base64url");

let server: Server;
beforeEach(() => {
  server = serve({
    "GET /api/devices": () => json({ items: [] }),
    "GET /api/pair": () => json({ items: [] }),
    "GET /api/hello": () => hello("selfhost"),
    "POST /api/pair": () =>
      json({
        id: "pt-9",
        token: MADE,
        grant: "device-pair",
        label: "",
        expiresAt: "2026-08-20T09:05:00.000Z",
      }),
  });
});
afterEach(async () => {
  await teardownConfirmEnv();
  server.restore();
  bindApiOwner(null);
  resetSessionTruthForTests();
  resetStorageOwnerForTest();
});

async function openDevices() {
  const deviceFetch = globalThis.fetch;
  installConfirmEnv();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  rememberOwner();
  const shellFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const { pathname } = new URL(String(input), window.location.origin);
    return pathname === "/api/devices" || pathname === "/api/pair" || pathname === "/api/hello"
      ? deviceFetch(input, init)
      : shellFetch(input, init);
  };
  window.location.hash = "#/settings/devices";
  await mountCloudShell();
  await tick(2500);
}

describe("a pairing link made on a self-hosted server", () => {
  it("is on this page's own origin, in the picture and in print, and never on the managed service's", async () => {
    await openDevices();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.devices.addAction }));
    });
    await tick(0);
    const link = `${window.location.origin}/pair#${MADE}`;
    expect(scanned()).toBe(link);
    expect(document.body.textContent).toContain(link);
    expect(document.body.textContent).not.toContain("api.ohmail.app");
  });
});
