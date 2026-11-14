/** @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en, json, serve, settle, type Server } from "./account-harness";
import { hello, qr, scanned, Words } from "./devices-support";
import { DevicesPane, useDevices } from "../../../../packages/app/src/account/devices/index.js";
import { useDevicesDoor } from "../../app/(product)/mailbox/devices-door";

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
afterEach(() => {
  cleanup();
  server.restore();
});

function Pane() {
  return <DevicesPane model={useDevices(useDevicesDoor())} factor={() => null} qr={qr} />;
}

describe("a pairing link made on a self-hosted server", () => {
  it("is on this page's own origin, in the picture and in print, and never on the managed service's", async () => {
    render(
      <Words>
        <Pane />
      </Words>,
    );
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.devices.addAction }));
    });
    await settle();
    const link = `${window.location.origin}/pair#${MADE}`;
    expect(scanned()).toBe(link);
    expect(document.body.textContent).toContain(link);
    expect(document.body.textContent).not.toContain("api.ohmail.app");
  });
});
