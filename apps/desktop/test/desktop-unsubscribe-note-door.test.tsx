/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate } from "../src/DesktopGate.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { setActiveCatalog } from "../../webapp/app/shell/locale.js";
import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";

/**
 * WHERE A SCREEN-OUT'S UNSUBSCRIBE LEAVES FROM, AS THE DOOR'S OWN SCREENER PANE SAYS IT.
 *
 * On the standalone door the engine on this computer sends the one-click request itself: it wires
 * `unsubscribe` into its own screener and posts through `nodeOneClickPost`, so the list's endpoint
 * sees the computer's network address. A paired window's screen-out is sent the same way by the
 * host's engine, a computer of the person's own too. The pane said the request goes from ohmail's
 * servers and keeps that address out of the sender's log, which is true on Cloud alone. Mounted
 * through the real gate at `#/settings/screener`, as a person opens it, in both languages; the
 * Cloud door is the control that keeps the server sentence.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

const EMPTY_PAGE = JSON.stringify({
  changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "MA", hasMore: false,
  serverTime: "2026-01-01T00:00:00.000Z",
});
const EMPTY_SNAPSHOT = JSON.stringify({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } });
const MAILBOXES = JSON.stringify({
  items: [{ id: "mbx-1", address: "someone@example.com", status: "connected", lastSyncAt: null }],
});
/** The account's switch ON: a screen-out unsubscribes, so the note is the one a person reads before it does. */
const CONSENT = JSON.stringify({
  seedConfirmedAt: "2026-01-01T00:00:00.000Z", screeningResetAt: null, dormancyDays: 90,
  screeningBaselineAt: null, autoSuggestAt: null, blockRemoteImagesAt: null, loadTrackingPixelsAt: null,
  blockAutoUnsubscribeAt: null, folderMailboxesOff: {}, signatures: {}, themeFace: null,
});
/** `GET /account/screening`, which the same pane reads for its Ohbox words. */
const SCREENING = JSON.stringify({
  ohboxPolicy: null, ohboxBar: null, defaultBar: "People who write to me themselves.", screenerAutoApply: false,
});

function fakeShell(status: EngineStatus): void {
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      if (command === "engine_status") return status;
      if (command === "mailto_claim" || command === "plugin:event|listen") return null;
      if (command === "engine_request") {
        const url = String(payload?.url ?? "");
        if (url === "/health") return encode(200, JSON.stringify({ signedIn: true, sessionExpired: false }));
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        if (url.startsWith("/mailboxes")) return encode(200, MAILBOXES);
        if (url.startsWith("/consent")) return encode(200, CONSENT);
        if (url === "/account/screening") return encode(200, SCREENING);
        return encode(200, EMPTY_PAGE);
      }
      return null;
    },
  };
}

const LOCAL: EngineStatus = {
  state: "serving", mode: "local", address: "someone@example.com", mailboxId: "mbx-1", credentialState: "ready",
} as EngineStatus;
const MANAGED: EngineStatus = {
  state: "serving", mode: "cloud", address: "someone@ohmail.app", mailboxId: "mbx-1", credentialState: "ready",
  cloudUrl: "https://api.ohmail.app",
} as EngineStatus;
const PAIRED: EngineStatus = {
  ...MANAGED, flavor: "desktop-host", address: "someone@example.com",
  baseUrl: "http://sidecar", cloudUrl: "https://kestrel.tail1234.ts.net",
} as EngineStatus;

const CATALOGUES = { en, de } as const;
type Locale = keyof typeof CATALOGUES;
const SERVERS = /our servers|unseren Servern/i;
const COMPUTER: Record<Locale, RegExp> = { en: /\bcomputer\b/i, de: /\bComputer\b/ };

let root: Root | null = null;
let el: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  el?.remove();
  root = null;
  el = null;
  delete host.__TAURI_INTERNALS__;
  window.location.hash = "";
  setActiveCatalog("en", null);
});

/** The note under the auto-unsubscribe switch, once the gate has routed to the Screener pane. */
async function screenerNote(status: EngineStatus, locale: Locale): Promise<string> {
  fakeShell(status);
  if (locale === "de") setActiveCatalog("de", de as never);
  window.location.hash = "#/settings/screener";
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(
      <IntlProvider locale={locale} messages={CATALOGUES[locale] as never} timeZone="UTC">
        <ThemeProvider storageKey="ohmail.theme"><ToastHost><DesktopGate /></ToastHost></ThemeProvider>
      </IntlProvider>,
    );
  });
  const title = CATALOGUES[locale].settings.autoUnsub.title;
  const row = (): HTMLElement | undefined =>
    [...el!.querySelectorAll<HTMLElement>(".set-row")].find((r) => r.querySelector("b")?.textContent === title);
  const t0 = Date.now();
  while (!row()) {
    if (Date.now() - t0 > 15_000) throw new Error(`no auto-unsubscribe switch on the pane; it read: ${(el.textContent ?? "").slice(0, 300)}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
  const note = row()!.nextElementSibling;
  expect(note?.classList.contains("set-note-inline"), "the switch's note is not under its row").toBe(true);
  return note!.textContent ?? "";
}

describe("the Screener pane says where a screen-out's unsubscribe leaves from", () => {
  for (const locale of ["en", "de"] as const) {
    it(`the standalone door names this computer, never our servers (${locale})`, { timeout: 30_000 }, async () => {
      const note = await screenerNote(LOCAL, locale);
      expect(note, `${locale}: the standalone door says the request goes from our servers`).not.toMatch(SERVERS);
      expect(note, `${locale}: the standalone door does not name the computer`).toMatch(COMPUTER[locale]);
    });
  }

  it("a paired window names the computer too: the host's engine sends it", { timeout: 30_000 }, async () => {
    const note = await screenerNote(PAIRED, "en");
    expect(note).not.toMatch(SERVERS);
    expect(note).toMatch(COMPUTER.en);
  });

  it("CONTROL: the Cloud door keeps the server sentence, which is true there", { timeout: 30_000 }, async () => {
    const note = await screenerNote(MANAGED, "en");
    expect(note).toBe(en.settings.autoUnsub.microcopy);
    expect(note).toMatch(SERVERS);
  });
});
