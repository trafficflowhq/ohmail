/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";
import { DEFAULT_LOCALE, fillFrom, setActiveCatalog } from "../../webapp/app/shell/locale";
import type { MailboxFacts } from "../../webapp/app/shell/mail-state";
import type { EngineStatus } from "../src/bridge-fetch.js";

/**
 * A MACHINE THAT STOPPED ORGANIZING IS NOT CALLED THE ORGANIZER on the desktop's reader rows:
 * Settings → Desktop, About and Settings → Screener. Each read the Screener role's first NAMED
 * holder, so a laptop whose lease had lapsed read "Studio laptop organizes it". The rows now take
 * `readerHolder`, whose `nobody` is the refusal's own decider. Rendered text only; the live holder
 * is the control on every surface.
 */

let FACTS: MailboxFacts[] | null = null;
vi.mock("../../webapp/app/shell/MailStateProvider", async () => {
  const real = await vi.importActual<typeof import("../../webapp/app/shell/MailStateProvider")>(
    "../../webapp/app/shell/MailStateProvider",
  );
  return { ...real, useMailboxFacts: () => FACTS };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

const HOLDER = "Studio laptop";
const LIVE: MailboxFacts = {
  id: "mbx-1",
  address: "someone@example.test",
  status: "connected",
  errorCode: null,
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: "2026-09-02T09:00:00.000Z",
  initialImportCompletedAt: "2026-09-02T09:00:00.000Z",
  createdAt: "2026-09-01T09:00:00.000Z",
  organizerRole: "reader",
  organizedBy: { kind: "local", name: HOLDER, since: "2026-09-02T08:00:00.000Z" },
  organizerState: "held",
  organizeConsentedAt: "2026-09-01T09:00:00.000Z",
} as MailboxFacts;
/** The same claim, left by a machine that stopped renewing it. */
const STOPPED: MailboxFacts = { ...LIVE, organizerState: "stopped" } as MailboxFacts;

const status: EngineStatus = {
  state: "serving", mode: "local", credentialState: "ready", address: "someone@example.test",
} as EngineStatus;

const PREFERENCE = JSON.stringify({
  ohboxPolicy: "people_only",
  ohboxBar: "Only people who write to me by hand.",
  defaultBar: "Keep my Ohbox for real people writing to me.",
  screenerAutoApply: false,
});

/** Encode an answer exactly as the shell's `engine_request` does — length, metadata, bytes. */
function encode(code: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status: code, statusText: "", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
const shellHost = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } };

let hostEl: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(
  pane: "about" | "settings" | "screening",
  facts: MailboxFacts[],
  locale: "en" | "de" = "en",
): Promise<string> {
  FACTS = facts;
  if (pane === "settings") delete shellHost.__TAURI_INTERNALS__;
  // `DOOR_COPY` reads the injected catalogue, not the provider — see `locale.ts`.
  setActiveCatalog(locale, locale === "de" ? fillFrom(en as never, de as never) as never : en as never);
  const node = pane === "about"
    ? h((await import("../src/DesktopAbout.js")).DesktopAbout, { status })
    : pane === "settings"
      /* The hosted door, and no shell answer: the pane's model rows are not what is under test,
         and `desktop-seal-sentence.test.tsx` mounts it the same way. */
      ? h((await import("../src/DesktopSettings.js")).DesktopSettings, {
        status: { ...status, mode: "cloud" }, session: "live", sealFailed: false,
        onStatus: () => undefined, onSwitchDoor: () => undefined, onSignIn: () => undefined,
      } as never)
      : h((await import("../src/DesktopScreening.js")).DesktopScreening, { door: "local" });
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: (locale === "de" ? de : en) as never, timeZone: "UTC", children: node,
    }));
  });
  // The Screener pane reads its stored preference in an effect; the text belongs after it.
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
  return hostEl.textContent ?? "";
}

beforeEach(() => {
  shellHost.__TAURI_INTERNALS__ = {
    invoke: async (command) => (command === "engine_request" ? encode(200, PREFERENCE) : null),
  };
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  hostEl?.remove();
  hostEl = null;
  setActiveCatalog(DEFAULT_LOCALE, null);
  delete shellHost.__TAURI_INTERNALS__;
});

const named = (s: string) => s.replace("{name}", HOLDER);

describe("the desktop's reader rows over a holder that stopped", () => {
  for (const pane of ["about", "settings"] as const) {
    it(`${pane}: the mailbox row says nothing organizes it, and names no machine`, async () => {
      const text = await mount(pane, [STOPPED]);
      expect(text).toContain(en.desktopDoor.mailboxWhyReadsNobody);
      expect(text, "a machine that stopped was called the organizer")
        .not.toContain(named(en.desktopDoor.mailboxWhyReadsNamed));
      expect(text).not.toContain(en.desktopDoor.mailboxWhyReads);
    });

    it(`${pane}: in German too`, async () => {
      const text = await mount(pane, [STOPPED], "de");
      expect(text).toContain(de.desktopDoor.mailboxWhyReadsNobody);
      expect(text).not.toContain(named(de.desktopDoor.mailboxWhyReadsNamed));
    });

    it(`${pane}: CONTROL — a holder that still renews is named`, async () => {
      const text = await mount(pane, [LIVE]);
      expect(text).toContain(named(en.desktopDoor.mailboxWhyReadsNamed));
      expect(text).not.toContain(en.desktopDoor.mailboxWhyReadsNobody);
    });
  }

  it("screening: the reader note says nothing organizes it, and keeps the road", async () => {
    const text = await mount("screening", [STOPPED]);
    expect(text).toContain(en.desktopScreener.readerNoteNobody);
    expect(text, "a machine that stopped was called the organizer")
      .not.toContain(named(en.desktopScreener.readerNote));
    expect(text).not.toContain(en.desktopScreener.readerNoteUnknown);
    expect(text, "the controls stay").toContain(en.desktopScreener.postureLabel);
  });

  it("screening: in German too", async () => {
    const text = await mount("screening", [STOPPED], "de");
    expect(text).toContain(de.desktopScreener.readerNoteNobody);
    expect(text).not.toContain(named(de.desktopScreener.readerNote));
  });

  it("screening: CONTROL — a holder that still renews is named", async () => {
    const text = await mount("screening", [LIVE]);
    expect(text).toContain(named(en.desktopScreener.readerNote));
    expect(text).not.toContain(en.desktopScreener.readerNoteNobody);
  });
});
