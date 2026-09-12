/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import messages from "../../webapp/messages/en.json";
import type { ConsentTransport } from "../../webapp/app/shell/consent-state";
import { consentOverBridge } from "../src/local-consent.js";
import { BearerManager } from "../src/host-client/bearer.js";
import { HostGate } from "../src/host-client/HostGate.js";

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
  it("arrives at all — without it the hook rests and every consent-backed control is withheld", async () => {
    const props = await mountGate();
    const consent = props.consentTransport as ConsentTransport | undefined;
    expect(consent, "no consentTransport: `reachable` is false and `known` never goes true")
      .toBeDefined();
    expect(typeof consent?.state).toBe("function");
    // The wires this door already had, unchanged — this adds beside them and replaces nothing.
    expect(props.junkWire, "the Junk wire was disturbed").toBeDefined();
    expect(props.trashWire, "the Trash wire was disturbed").toBeDefined();
    expect(props.olderBodyWire, "the reach-past body wire was disturbed").toBeDefined();
  });

  it("makes exactly the calls the desktop window's own transport makes", async () => {
    const props = await mountGate();
    const consent = props.consentTransport as ConsentTransport;
    /* ONE DEFINITION OF WHAT A CONSENT MEANS. Both doors are a `consentVia` call, so this is a
       parity assertion rather than a list somebody keeps in step by hand: a call added to the
       window and not to the paired door is a control that exists on a laptop and is silently
       missing on the phone beside it — which is the shape of the defect this file closes. */
    const paired = Object.keys(consent).sort();
    const window_ = Object.keys(consentOverBridge).sort();
    expect(paired).toEqual(window_);
  });

  it("declares the folders flag unstorable, because this door serves no folder verb", async () => {
    const props = await mountGate();
    const consent = props.consentTransport as ConsentTransport;
    /* The host's table wraps its consent group in `withoutFoldersFlag`. Declared, not probed:
       which routes this bundle's own server mounts is a build fact. With `true` the shared shell
       draws the whole Folders pane over a door that drops the write. */
    expect(consent.foldersStorable).toBe(false);
  });

  it("rides the ONE bearer door, root-relative, one axis per PATCH", async () => {
    const props = await mountGate();
    const consent = props.consentTransport as ConsentTransport;
    sent.length = 0;

    await consent.state();
    await consent.setDormancyDays(30);
    await consent.setBlockRemoteImages(true);

    expect(sent.map((s) => s.url)).toEqual([
      "/consent", "/consent/settings", "/consent/settings",
    ]);
    expect(sent[0]!.init?.method, "the read carried a verb").toBeUndefined();
    for (const s of sent) {
      expect(s.init?.headers?.authorization, `${s.url} carried no bearer`).toBe("Bearer a1");
    }
    // ONE AXIS PER WRITE: the route tests presence with `in`, so a body carrying a second field
    // would overwrite a setting this control does not own — a window set in a browser tab a
    // moment ago, silently replaced by whatever this page last rendered.
    expect(JSON.parse(sent[1]!.init!.body!)).toEqual({ dormancyDays: 30 });
    expect(JSON.parse(sent[2]!.init!.body!)).toEqual({ blockRemoteImages: true });
    // Nothing on this page opens a socket of its own, and the refusing Cloud client is never
    // reached either — it would have thrown.
    expect(platformFetchCalls, "a second fetch door was opened").toBe(0);
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
});
