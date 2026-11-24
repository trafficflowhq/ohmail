/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, getByRole, getByText } from "@testing-library/react";
import { resetSessionTruthForTests } from "@ohmail/app-logic/session/session-truth";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import {
  act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner, scriptRefresh, scriptSession,
  sessionFull, teardownConfirmEnv, tick, ISO,
} from "./fixtures/cloud-confirm-shell";
import { bindApiOwner, type AwayResponderWire, type MailboxDTO } from "../app/api-client";
import type { TravelledChangeWire } from "../app/shell/travelled-change";
import messages from "../messages/en.json";

/**
 * THE AWAY ROW, THE DORMANCY DIAL AND THE SIGNATURE EDITORS SAY WHERE A READER'S CHANGE WENT —
 * the Screening pane's sentence on the three other settings that travel, through the real
 * components: the refusal a read carries, the dial's "sent" at the press, and each mailbox's own
 * line. And the hosted transport carries a signature's formatting: it dropped it, so a formatted
 * save in the browser was sent as "clear the signature".
 */

const S = messages.settings.screening;
const ASKED = messages.away.asked;
const REFUSED: TravelledChangeWire = { state: "refused", holder: "work-laptop", refusal: "unreadable" };
const REFUSED_TEXT = S.refusedUnreadable.replace("{name}", "work-laptop");

type SettingsAnswer = (method: string, path: string) => Response | undefined;
let mounted = false;
let host: HTMLElement;

async function unmount(): Promise<void> {
  if (mounted) await teardownConfirmEnv();
  mounted = false;
  bindApiOwner(null);
  resetSessionTruthForTests();
  resetStorageOwnerForTest();
  localStorage.clear();
  history.replaceState(null, "", "/");
}

async function mount(pane: "away" | "screener" | "signatures", answer: SettingsAnswer): Promise<void> {
  await unmount();
  installConfirmEnv();
  mounted = true;
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  rememberOwner();
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const { pathname } = new URL(String(input), window.location.origin);
    if (pathname === "/api/account/screening") {
      return Response.json({ ohboxPolicy: "people_and_replied", ohboxBar: null, defaultBar: "Mail from people I know." });
    }
    return answer(init?.method ?? "GET", pathname) ?? fetch(input, init);
  };
  history.replaceState(null, "", `#/settings/${pane}`);
  host = await mountCloudShell();
  await tick(2500);
}

const text = (): string => host.textContent ?? "";
const currentConsent = {
  dormancyDays: 90, screeningScope: "window", seedConfirmedAt: ISO, screeningResetAt: null,
  counts: { decidedSenders: 0, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 },
};
const consent = (extra: object) => Response.json({ ...currentConsent, ...extra });

afterEach(unmount);

const ROW: AwayResponderWire = {
  enabled: false, body: "Back Monday.", startsAt: null, endsAt: null,
  audience: "screened_in", throttle: "per_day", piles: ["INBOX"], updatedAt: "2026-09-26T08:00:00.000Z",
};

describe("the away row on a reader", () => {
  it("says a refusal the read carries when the pane opens", async () => {
    await mount("away", (_method, path) =>
      path === "/api/away-responder" ? Response.json({ ...ROW, change: REFUSED }) : undefined);
    expect(text(), "the refusal reached no surface").toContain(REFUSED_TEXT);
  });

  it("CONTROL: an applied change the read carries says nothing on open", async () => {
    await mount("away", (_method, path) => path === "/api/away-responder"
      ? Response.json({ ...ROW, change: { state: "applied", holder: null, refusal: null } })
      : undefined);
    expect(getByRole(host, "switch", { name: messages.away.title })).toBeTruthy();
    expect(text()).not.toContain(S.applied);
    expect(text()).not.toContain("Not applied");
  });

  it("ends its wait on the refusal instead of standing on 'asked'", async () => {
    let answer: AwayResponderWire = ROW;
    await mount("away", (method, path) => {
      if (path !== "/api/away-responder") return undefined;
      return Response.json(method === "PUT" ? { ...ROW, pending: true } : answer);
    });
    const a = messages.away;
    const panel = getByRole(host, "region", { name: a.title });
    await act(() => { fireEvent.click(getByRole(panel, "switch", { name: a.title })); });
    const unsaved = getByText(panel, a.unsavedStillOff).closest<HTMLElement>("[aria-live]");
    if (!unsaved) throw new Error("the unsaved announcement is missing");
    await act(() => { fireEvent.click(getByRole(unsaved, "button", { name: a.save })); });
    await tick(100);
    expect(text()).toContain(ASKED);
    answer = { ...ROW, change: REFUSED };
    await tick(20_000);
    expect(text()).toContain(REFUSED_TEXT);
    expect(text()).not.toContain(ASKED);
  });
});

describe("the dormancy dial on a reader", () => {
  it("says the change was sent, and says a refusal", async () => {
    await mount("screener", (_method, path) => path === "/api/consent"
      ? consent({ dormancyChange: { state: "asked", holder: null, refusal: null } })
      : undefined);
    expect(getByRole(host, "button", { name: "All time" })).toBeTruthy();
    expect(text(), "the dial snapped back with nothing said").toContain(ASKED);
    await mount("screener", (_method, path) => path === "/api/consent"
      ? consent({ dormancyChange: REFUSED })
      : undefined);
    expect(text()).toContain(REFUSED_TEXT);
  });

  it("an applied change says nothing over the dial's own row", async () => {
    await mount("screener", (_method, path) => path === "/api/consent"
      ? consent({ dormancyChange: { state: "applied", holder: null, refusal: null } })
      : undefined);
    expect(getByRole(host, "button", { name: "All time" })).toBeTruthy();
    expect(text()).not.toContain(S.applied);
    expect(text()).not.toContain(ASKED);
  });
});

describe("the signature editors on a reader", () => {
  it("each mailbox says its own change", async () => {
    const mailbox = (id: string, organizerRole: "reader" | "organizer"): MailboxDTO => ({
      id, address: [id, "example.invalid"].join("@"), provider: "imap", organizerRole,
      status: "connected", displayName: null, createdAt: ISO, lastSyncAt: ISO,
      initialImportCompletedAt: ISO, organizeConsentedAt: ISO,
    });
    const mailboxes = [mailbox("m-1", "reader"), mailbox("m-2", "organizer")];
    await mount("signatures", (_method, path) => {
      if (path === "/api/consent") return consent({ signatures: {}, signatureChanges: { "m-1": REFUSED } });
      if (path === "/api/mailboxes") return Response.json({ items: mailboxes });
      return undefined;
    });
    const sheets = mailboxes.map(({ address }) => {
      const sheet = getByRole(host, "heading", { name: address }).closest('[data-kind="plain"]');
      if (!sheet) throw new Error("the mailbox has no signature sheet");
      return sheet;
    });
    expect(sheets[0]!.textContent, "the refusal reached no surface").toContain(REFUSED_TEXT);
    expect(sheets[1]!.textContent).not.toContain("Not applied");
  });
});
