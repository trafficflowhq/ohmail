/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import messages from "../../webapp/messages/en.json";
import type { MailboxFacts } from "../../webapp/app/shell/mail-state";

/**
 * THE DESKTOP PANE SAYS WHO FILES THE MAILBOX. On its own door this computer files what it
 * organizes; on a hosted door the organizer is ohmail Cloud or the self-hosted server; on a paired
 * door it is the other computer, named as the pane names it. The one sentence a hosted or paired
 * row can wear about the organizer is the refused stop ("Another copy of … keeps organizing"),
 * and it said "this computer" on every door; the countermand's gloss said so too, beside a press
 * those doors do not serve. The standalone cases are the positive controls.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const copy = (messages as unknown as { mailboxes: Record<string, string> }).mailboxes;

let FACTS: MailboxFacts[] | null = null;

vi.mock("../../webapp/app/shell/MailStateProvider", async () => {
  const real = await vi.importActual<typeof import("../../webapp/app/shell/MailStateProvider")>(
    "../../webapp/app/shell/MailStateProvider",
  );
  return {
    ...real,
    useMailState: () => ({
      state: { key: "quiet", clock: false, settled: true },
      mailboxes: FACTS,
      mirrored: 0,
      freshness: { state: "current" },
      refresh: () => {},
    }),
  };
});

vi.mock("../src/bridge-fetch.js", async () => {
  const real = await vi.importActual<typeof import("../src/bridge-fetch.js")>("../src/bridge-fetch.js");
  const quiet = async () => new Response(null, { status: 202 });
  return {
    ...real,
    bridgeFetch: quiet,
    retryingBridgeFetch: quiet,
    engineLogout: async () => ({ state: "not_configured", mode: null }),
  };
});

const ORGANIZING: MailboxFacts = {
  id: "mbx-1",
  address: "someone@example.test",
  status: "connected",
  errorCode: null,
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: "2026-08-07T09:00:00.000Z",
  initialImportCompletedAt: "2026-08-01T09:00:00.000Z",
  createdAt: "2026-08-01T08:00:00.000Z",
  organizerRole: "organizer",
  organizeConsentedAt: "2026-08-01T09:00:00.000Z",
};
/** A stop somebody asked for, refused because a live copy of the organizer holds the claim. */
const REFUSED: MailboxFacts = {
  ...ORGANIZING,
  releaseRequestedAt: "2026-09-07T09:00:00.000Z",
  releaseRefusal: "sibling_lapse",
};

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

async function render(props: { door: string; host?: string | null; flavor?: string | null }): Promise<string> {
  const { DesktopMailboxes } = await import("../src/DesktopMailboxes.js");
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(h(
      IntlProvider,
      { locale: "en", messages: messages as never, timeZone: "UTC" } as never,
      h(ThemeProvider, { storageKey: "ohmail.theme" } as never,
        h(ToastHost, null, h(DesktopMailboxes, props as never))),
    ));
  });
  return mountPoint.querySelector(".mbx-org")?.textContent ?? "";
}

beforeEach(() => { FACTS = null; });
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
});

describe("the desktop pane names who files the mailbox", () => {
  it("CONTROL — on its own door, this computer files it", async () => {
    FACTS = [ORGANIZING];
    const said = await render({ door: "local" });
    expect(said).toContain(copy.stateOrganizingHere!);
  });

  it("CONTROL — on its own door, a refused stop names another copy of this computer", async () => {
    FACTS = [REFUSED];
    const said = await render({ door: "local" });
    expect(said).toContain(copy.stopOrganizingSiblingLapse!);
  });

  it("on the hosted door, ohmail Cloud is the organizer the refusal names", async () => {
    FACTS = [REFUSED];
    const said = await render({ door: "cloud", flavor: "managed" });
    expect(said, "the hosted row says this computer organizes").not.toMatch(/this computer/i);
    expect(said).toContain(copy.stopOrganizingSiblingLapseCloud!);
  });

  it("an engine that does not say its flavor reads as the managed service", async () => {
    FACTS = [REFUSED];
    const said = await render({ door: "cloud" });
    expect(said).toContain(copy.stopOrganizingSiblingLapseCloud!);
  });

  it("on a self-hosted server's door, the server is the organizer", async () => {
    FACTS = [REFUSED];
    const said = await render({ door: "cloud", flavor: "selfhost" });
    expect(said).not.toMatch(/this computer/i);
    expect(said).toContain(copy.stopOrganizingSiblingLapseServer!);
  });

  it("a hosted or paired row offers no countermand: that door serves no takeover", async () => {
    const organizeHere = (): HTMLButtonElement | undefined => [...mountPoint!.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").trim() === copy.organizeHere);
    FACTS = [{ ...ORGANIZING, releaseRequestedAt: "2026-09-07T09:00:00.000Z" }];
    await render({ door: "local" });
    expect(organizeHere(), "CONTROL — the standalone door lost its countermand").toBeDefined();
    await act(async () => { root!.unmount(); });
    mountPoint?.remove();
    for (const props of [{ door: "cloud", flavor: "managed" }, { door: "cloud", host: "studio" }]) {
      const said = await render(props);
      expect(organizeHere(), `${JSON.stringify(props)} offers a press its door cannot serve`).toBeUndefined();
      expect(said, "the hosted row says this computer keeps organizing").not.toMatch(/this computer/i);
      await act(async () => { root!.unmount(); });
      mountPoint?.remove();
    }
    root = null;
  });

  it("on a paired door, the other computer is the organizer, by the name the pane uses", async () => {
    FACTS = [REFUSED];
    const said = await render({ door: "cloud", host: "studio", flavor: "desktop-host" });
    expect(said).not.toMatch(/this computer/i);
    expect(said).toContain(copy.stopOrganizingSiblingLapseHost!.replace("{name}", "studio"));
  });
});
