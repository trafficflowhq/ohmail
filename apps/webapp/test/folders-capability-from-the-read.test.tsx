/** @vitest-environment jsdom */

/**
 * "USE FOLDERS" IS DRAWN ONLY WHERE THE SERVER'S OWN CONSENT READ CARRIES THE AXIS.
 *
 * A self-hosted server wraps its consent group in `withoutFoldersFlag`: the read REMOVES
 * `foldersEnabledAt` and the write drops the flag. The browser declared the flag storable for
 * every server it talks to, so a self-hosted tab drew a switch whose every press answered
 * "Couldn't save that — try again". The capability is the read's own key (the phone's rule):
 * present, null or an instant, the server can keep the flag; absent, it cannot.
 */

import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConsentTransport, useConsentState as UseConsentState } from "@ohmail/app-logic/consent/consent-state";
import type { ConsentStateWire } from "../app/api-client";

/* The API base is read when `api-client` LOADS, and static imports are hoisted above any
   assignment here — so the hook is imported after the browser build's base is set. */
let useConsentState: typeof UseConsentState;
/** The browser's own wire, as the web's host hands it. */
let CLOUD_CONSENT: ConsentTransport;
beforeAll(async () => {
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  ({ useConsentState } = await import("@ohmail/app-logic/consent/consent-state"));
  ({ CLOUD_CONSENT } = await import("../app/(product)/mailbox/consent-over-api"));
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ISO = "2026-09-25T09:00:00.000Z";
/** The consent read every door answers, minus the folders axis. */
const BASE: Record<string, unknown> = {
  seedConfirmedAt: ISO, screeningResetAt: null, dormancyDays: 60, screeningBaselineAt: ISO,
  autoSuggestAt: null, blockRemoteImagesAt: null, loadTrackingPixelsAt: null, blockAutoUnsubscribeAt: null,
};
const WITH_AXIS = { ...BASE, foldersEnabledAt: null } as unknown as ConsentStateWire;
const WITHOUT_AXIS = { ...BASE } as unknown as ConsentStateWire;

const stub = (wire: ConsentStateWire, declared = true): ConsentTransport => ({
  foldersStorable: declared,
  state: () => Promise.resolve(wire),
  setAutoSuggest: () => Promise.reject(new Error("unused")),
  setDormancyDays: () => Promise.reject(new Error("unused")),
  setBlockRemoteImages: () => Promise.reject(new Error("unused")),
  setBlockTrackingPixels: () => Promise.reject(new Error("unused")),
  setBlockAutoUnsubscribe: () => Promise.reject(new Error("unused")),
  setFoldersEnabled: () => Promise.reject(new Error("unused")),
  setMailboxFoldersEnabled: () => Promise.reject(new Error("unused")),
  setMailboxSignature: () => Promise.reject(new Error("unused")),
});

let seen: { known: boolean; foldersStorable: boolean } | null = null;
function Probe(props: { transport: ConsentTransport }) {
  const consent = useConsentState(true, null, props.transport);
  seen = { known: consent.known, foldersStorable: consent.foldersStorable };
  return null;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
const flush = async () => {
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
};
async function mount(transport: ConsentTransport) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Probe transport={transport} />); });
  await flush();
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null; host = null; seen = null;
  globalThis.fetch = originalFetch;
});

describe("the folders capability is the consent read's own key", () => {
  it("a read that carries the axis (null: off) can keep the flag — the pane is drawn", async () => {
    await mount(stub(WITH_AXIS));
    expect(seen).toEqual({ known: true, foldersStorable: true });
  });

  it("a read WITHOUT the axis (a self-hosted server) cannot — no pane, though the wire says true", async () => {
    await mount(stub(WITHOUT_AXIS));
    expect(seen, "a door that drops the flag was offered its switch").toEqual({ known: true, foldersStorable: false });
  });

  it("a transport that declares it cannot store stays withheld whatever the read carries", async () => {
    await mount(stub(WITH_AXIS, false));
    expect(seen).toEqual({ known: true, foldersStorable: false });
  });

  describe("the browser's own wire, on a self-hosted build", () => {
    let answer: Record<string, unknown>;
    beforeEach(() => {
      globalThis.fetch = ((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/api/consent")) {
          return Promise.resolve(new Response(JSON.stringify(answer), {
            status: 200, headers: { "content-type": "application/json" },
          }));
        }
        return Promise.resolve(new Response("{}", { status: 404 }));
      }) as typeof fetch;
    });

    it("the self-hosted answer (no axis) withholds the pane", async () => {
      answer = { ...WITHOUT_AXIS };
      await mount(CLOUD_CONSENT);
      expect(seen).toEqual({ known: true, foldersStorable: false });
    });

    it("the managed answer (axis present, off) draws it — the control", async () => {
      answer = { ...WITH_AXIS };
      await mount(CLOUD_CONSENT);
      expect(seen).toEqual({ known: true, foldersStorable: true });
    });
  });
});
