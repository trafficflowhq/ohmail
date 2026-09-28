/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";
import { DEFAULT_LOCALE, setActiveCatalog } from "../../webapp/app/shell/locale";
import type { MailboxFacts } from "../../webapp/app/shell/mail-state";
import type { EngineStatus } from "../src/bridge-fetch.js";

/**
 * SETTINGS → DESKTOP NAMES THE MAILBOX THIS INSTALL HOLDS. It rendered `EngineStatus.address`, the
 * seed from the install's settings file, which stays put when the seed is removed while another
 * mailbox remains: the pane named a mailbox the install no longer held. It reads the roster now.
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

const row = (id: string, address: string, over: Partial<MailboxFacts> = {}): MailboxFacts => ({
  id,
  address,
  status: "connected",
  errorCode: null,
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: "2026-09-02T09:00:00.000Z",
  initialImportCompletedAt: "2026-09-02T09:00:00.000Z",
  createdAt: "2026-09-01T09:00:00.000Z",
  ...over,
} as MailboxFacts);

const SEED = "removed@example.test";
const SURVIVOR = "survivor@example.test";
const status = { state: "serving", mode: "local", credentialState: "ready", address: SEED } as EngineStatus;

let hostEl: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(facts: MailboxFacts[] | null): Promise<string> {
  FACTS = facts;
  setActiveCatalog(DEFAULT_LOCALE, en as never);
  const { DesktopSettings } = await import("../src/DesktopSettings.js");
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages: en as never, timeZone: "UTC",
      children: h(DesktopSettings, {
        status, session: "live", sealFailed: false,
        onStatus: () => undefined, onSwitchDoor: () => undefined, onSignIn: () => undefined,
      } as never),
    }));
  });
  return hostEl.textContent ?? "";
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  hostEl?.remove();
  hostEl = null;
  FACTS = null;
});

describe("Settings → Desktop names the mailbox this install holds", () => {
  it("the seed was removed while another mailbox remains: the survivor, never the seed", async () => {
    const said = await mount([
      row("mbx-seed", SEED, { status: "disabled", disabledReason: null }),
      row("mbx-2", SURVIVOR),
    ]);
    expect(said).toContain(SURVIVOR);
    expect(said, "the pane named a mailbox this install no longer holds").not.toContain(SEED);
  });

  it("two mailboxes held: both are named", async () => {
    const said = await mount([row("mbx-1", SEED), row("mbx-2", SURVIVOR)]);
    expect(said).toContain(SEED);
    expect(said).toContain(SURVIVOR);
  });

  it("CONTROL: before the roster has answered, the pane says what it always said", async () => {
    expect(await mount(null)).toContain(SEED);
  });
});
