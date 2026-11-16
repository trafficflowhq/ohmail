/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import messages from "../../webapp/messages/en.json";
import type { ConsentTransport } from "@ohmail/app-logic/consent/consent-state";
import { consentOverBridge } from "../src/local-consent.js";
import type { ConsentStateWire as StandInConsentRead } from "../src/no-api-client.js";
import { BearerManager } from "../../paired-page/src/bearer.js";
import { HostGate } from "../../paired-page/src/HostGate.js";

/**
 * ═══ THE PAIRED PHONE'S CONSENT ROW — the wire the host door was not handing in ══════════════
 *
 * ── WHAT WAS BROKEN ─────────────────────────────────────────────────────────────────────────
 *
 * `HostGate` mounts the SAME shell the desktop window mounts, and this artifact aliases
 * `app/api-client` to a refusing stub exactly as the window's does. `useConsentState` decides
 * whether to ask at all from `transport !== undefined || apiConfigured()`, so with no transport
 * and no Cloud client the hook rested: `known` false, and the screening window, the dormancy
 * dial and the remote-image, tracking-pixel and auto-unsubscribe rows all withheld — on a door
 * whose host serves every one of those routes one hop away (`desktopHostRoutes` spreads
 * `localRoutes`, which mounts `consentRoutes`). The desktop's own window had the wire; the phone
 * paired to it did not, for no stated reason.
 *
 * ── WHAT IS MEASURED HERE ───────────────────────────────────────────────────────────────────
 *
 * The composition, driven: the gate renders with a bearer whose transport RECORDS, the wire it
 * hands the shell is taken from the render and used, and the calls are compared with the desktop
 * window's own transport — both are one `consentVia` call, so a call added on one door and not
 * the other is a build error here rather than a surface missing on a phone. What the controls
 * ABOVE the seam do with the answers is the shared shell's and lives in `apps/webapp/test`.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(APP, "../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

/** One render's worth of the props `HostGate` hands the shared shell. */
let shellProps: Record<string, unknown> | null = null;

vi.mock("../../webapp/app/shell/AppShell", async () => {
  const real = await vi.importActual<typeof import("../../webapp/app/shell/AppShell")>(
    "../../webapp/app/shell/AppShell",
  );
  return {
    ...real,
    /* A capture rather than the shell: the shell's own behaviour is not this file's subject, and
       mounting it would measure the wire only through whatever it happens to ask for. */
    AppShell: (props: Record<string, unknown>) => {
      shellProps = props;
      return null;
    },
  };
});

/** The Cloud client as this artifact has it — refusing, so `apiConfigured()` is false here too. */
vi.mock("../../webapp/app/api-client", async () => {
  const real = await vi.importActual<typeof import("../../webapp/app/api-client")>(
    "../../webapp/app/api-client",
  );
  return { ...real, apiConfigured: () => false };
});

interface Sent { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } | undefined }
let sent: Sent[];
/** The page's ONE door. Anything reaching the platform `fetch` instead is a second one. */
let platformFetchCalls: number;

beforeEach(() => {
  sent = [];
  platformFetchCalls = 0;
  shellProps = null;
  window.localStorage.clear();
  (globalThis as { fetch: typeof fetch }).fetch = (async () => {
    platformFetchCalls += 1;
    throw new Error("the page opened a socket of its own");
  }) as typeof fetch;
});

let root: Root | null = null;
let hostEl: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  hostEl?.remove();
  hostEl = null;
  window.history.replaceState(null, "", "/");
});

/** What the host's consent group answers — the shape `GET /consent` really carries on that door. */
const CONSENT_BODY = {
  dormancyDays: 45,
  screeningScope: "window",
  screeningBaselineAt: "2026-01-02T03:04:05.000Z",
  blockRemoteImagesAt: null,
  loadTrackingPixelsAt: null,
  blockAutoUnsubscribeAt: null,
  autoSuggestAt: null,
  signatures: {},
};

/** A bearer holding a live pairing, over a transport that records and answers the consent row. */
function pairedBearer(): BearerManager {
  const bearer = new BearerManager({
    storage: window.localStorage,
    fetchImpl: (async (url: string, init?: unknown) => {
      sent.push({ url, init: init as Sent["init"] });
      return new Response(JSON.stringify(CONSENT_BODY), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as never,
  });
  bearer.adopt({ accessToken: "a1", refreshToken: "r1" }, { fresh: true });
  return bearer;
}

/** Render the gate on a live pairing and return the props it handed the shell. */
async function mountGate(): Promise<Record<string, unknown>> {
  const bearer = pairedBearer();
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", children: h(HostGate, { bearer }),
    }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(shellProps, "the gate did not mount the shared shell on a live pairing").not.toBeNull();
  return shellProps!;
}

describe("the consent wire a paired device's gate hands the shared shell", () => {

  /* The pane reads WHY a write was refused from the envelope's code and details, as the web's
     `ApiError` carries them; a door that kept only the sentence left the pane saying "try again". */
  it("a refused write keeps the envelope's status, code and details", async () => {
    const { consentVia } = await import("../src/consent-wire.js");
    const details = { reason: "no_organizer", by: null };
    const wire = consentVia(async () => new Response(JSON.stringify({
      error: { code: "organized_elsewhere", message: "nothing organizes this mailbox", details },
    }), { status: 409, headers: { "content-type": "application/json" } }));
    await expect(wire.setMailboxSignature("mb-one", "-- mine")).rejects.toMatchObject({
      status: 409, code: "organized_elsewhere", details, message: "nothing organizes this mailbox",
    });
  });

  it("the routes it asks for are served on the paired-device table", () => {
    /* A cross-package read rather than an import: `apps/desktop` does not depend on the api
       package. `desktopHostRoutes` spreads `localRoutes`, and `localRoutes` mounts the consent
       group — a dropped spread on either line reddens this. */
    expect(read("packages/api/src/routes/desktop-host.ts")).toContain("...localRoutes,");
    expect(read("packages/api/src/routes/local.ts"))
      .toContain("...withoutFoldersFlag(consentRoutes)");
    const consentSrc = read("packages/api/src/routes/consent.ts");
    expect(consentSrc).toContain('pattern: "/consent"');
    expect(consentSrc).toContain('pattern: "/consent/settings"');
  });

  /* The desktop's stand-in for the server client restates the consent read, and the shared hook declares the read it
     takes. Held here by the compiler, beside the stand-in: no file of the web app may import this app to say it. */
  it("the read the client's stand-in declares is one the consent row takes", () => {
    expectTypeOf<StandInConsentRead>().toMatchTypeOf<Awaited<ReturnType<ConsentTransport["state"]>>>();
  });
});
