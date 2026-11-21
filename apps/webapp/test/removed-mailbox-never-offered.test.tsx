/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { SyncChange } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { NOW, S, act, consentTransport, engineOver, msg, setup, storeWith, teardown, waitFor } from "./_view-shell";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import { mailboxLabelResolver } from "@ohmail/app-logic/reader";
import { resetDecisionAskedForTests } from "@ohmail/app-logic/mailboxes/first-run/decision-asked";

/**
 * A REMOVED MAILBOX IS NEVER OFFERED. A removal leaves a `disabled` row that `GET /mailboxes` keeps
 * listing, one per remove of the address. The whole shell over such a roster: setup's chooser, the
 * run's subject, the connect form's holder and the per-mailbox folder switches count live mailboxes
 * only; the delivered-to chip and the rail's headings count addresses, so a removed mailbox of
 * another address keeps its name. Each sweep case has a control with two live ones.
 *
 * Setup, the reading head, the rail's All folders tree and Settings use the mounted frame and mail ground.
 */

const h = React.createElement;
const t = messages.onboarding;
const ISO = "2026-09-01T00:00:00.000Z";

const row = (id: string, address: string, o: Partial<MailboxFacts> = {}): MailboxFacts => ({
  id, address, status: "connected", errorCode: null, disabledReason: null, syncBlockedReason: null,
  syncBlockedSince: null, lastSyncAt: "2026-09-16T08:59:00.000Z", createdAt: ISO,
  organizerRole: "organizer", organizedBy: null, organizerState: null, organizeConsentedAt: ISO, ...o,
} as MailboxFacts);
/* A tombstone keeps its role, its consent and the holder it last named. */
const removed = (id: string, address: string): MailboxFacts => row(id, address, {
  status: "disabled", createdAt: "2026-08-01T00:00:00.000Z",
  organizedBy: { kind: "local", name: "Old laptop", since: ISO }, organizerState: "held",
});

const A = row("mb-a", "a@example.invalid");
const B = row("mb-b", "b@example.invalid");
const GONE_A = [removed("mb-a-1", A.address), removed("mb-a-2", A.address)];
const GONE_B = removed("mb-b-1", B.address);
const GONE_C = removed("mb-c", "c@example.invalid");

const host = (): FirstRunHost => ({
  door: "selfhost", ai: "off",
  probe: async () => ({ host: "h", user: "u", folders: 1 }),
  connect: async () => ({ id: "mb-new" }),
  organize: async () => "stored",
  complete: async () => { /* stamped */ },
  probeReason: () => null,
  probeMessage: () => null,
});

const folder = (id: string, mailboxId: string, address: string, seq: number, name = "Projects"): SyncChange => ({
  type: "folder", op: "create", id, seq, updatedAt: ISO,
  entity: { id, name, mailboxId, mailbox: address, updatedAt: ISO },
} as unknown as SyncChange);

const TWO_TREES = [folder("fd-a", A.id, A.address, 900), folder("fd-b", B.id, B.address, 901)];

async function launchOverTheNewShell(
  roster: MailboxFacts[], hash: string, withStage: boolean,
  trees: SyncChange[] = TWO_TREES, more: Parameters<typeof msg>[] = [],
): Promise<HTMLElement> {
  const { MailShell } = await import("./_mail-shell.js");
  const folders = hash === "#/settings/folders"
    ? (await import("../app/(product)/mailbox/pane-parts")).WEB_PANE_PARTS.folders
    : undefined;
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const s = await storeWith(
    [msg("m1", { mailboxId: A.id, subject: "Hello there" }), ...more.map((a) => msg(...a))],
    trees,
  );
  const engine = engineOver(s);
  S.store = s; S.engine = engine;
  window.location.hash = hash;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  S.roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { children: h(ToastHost, {
        children: h(MailShell as never, {
          demo: false, engine, consentTransport, mailboxFacts: async () => roster,
          folders,
          ...(withStage ? { firstRun: host() } : {}),
        } as never),
      }) }),
    }));
  });
  return container;
}

/** The stage: the frame's modal dialog. */
const STAGE = "[role=dialog][aria-modal=true]";
const heading = (): string => (document.querySelector(`${STAGE} h1`)?.textContent ?? "").trim();
const settle = async (n = 30): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};
const stageButtons = (): string[] =>
  [...document.querySelectorAll(`${STAGE} button`)].map((b) => (b.textContent ?? "").trim());
const letterHead = (el: HTMLElement, subject: string): HTMLElement | null =>
  within(el).queryByRole("heading", { name: subject, level: 2 })?.closest<HTMLElement>(".oh-readinghead") ?? null;
const deliveredTo = (el: HTMLElement, subject = "Hello there"): string[] =>
  [...(letterHead(el, subject)?.querySelectorAll(".oh-readinghead-mailbox") ?? [])]
    .map((word) => (word.textContent ?? "").trim());

async function openFolderTree(el: HTMLElement): Promise<HTMLElement> {
  const rail = within(el).getByRole("navigation", { name: messages.frame.landmark.places });
  const all = messages.folder.rail.all;
  const button = () => within(rail).queryByRole("button", { name: all });
  await waitFor(() => button() !== null, "the All folders control");
  await act(async () => { button()!.click(); });
  return within(rail).getByRole("tree", { name: all });
}
const folderHeadings = (tree: HTMLElement): (string | null)[] =>
  [...tree.querySelectorAll(".oh-folderfold-mailbox")].map((word) => word.textContent);
const nestedFolder = folder("fd-a-child", A.id, A.address, 902, "Projects/Backups");

beforeEach(() => {
  setup();
  resetDecisionAskedForTests();
});
afterEach(teardown);

describe("setup offers live mailboxes only", () => {
  it("the chooser lists each live mailbox once, and a press names the live row", async () => {
    await launchOverTheNewShell([...GONE_A, A, GONE_B, B], "#/first-run/again", true);
    await waitFor(() => heading() === t.chooseTitle, "the chooser");
    const offered = stageButtons().filter((x) => x.includes("@"));
    expect(offered, "a removed copy was offered beside the live one").toEqual([A.address, B.address]);
    const press = [...document.querySelectorAll<HTMLButtonElement>(`${STAGE} button`)].find((b) => (b.textContent ?? "").trim() === A.address)!;
    await act(async () => { press.click(); });
    await waitFor(() => window.location.hash.includes(`mailbox=${A.id}`), "the run on the live row");
  });

  it("one live mailbox beside its removed copies is no choice: the run is about it", async () => {
    await launchOverTheNewShell([...GONE_A, A], "#/first-run/again", true);
    await settle();
    expect(heading(), "removed copies made a chooser").not.toBe(t.chooseTitle);
    expect(stageButtons().filter((x) => x === A.address)).toEqual([]);
  });

  it("a run naming a removed copy is the vanished screen, not a run to a dead end", async () => {
    await launchOverTheNewShell([...GONE_A, A], `#/first-run/again?mailbox=${GONE_A[0]!.id}`, true);
    await settle(60);
    expect(heading()).toBe(t.vanishedTitle);
  });

  it("the connect form does not name a removed mailbox's holder", async () => {
    await launchOverTheNewShell([...GONE_A], "#/first-run/add", true);
    await waitFor(() => heading() !== "", "the connect form");
    expect(document.body.textContent).not.toContain(t.doorReader);
  });
});

describe("the shell counts live mailboxes only", () => {
  it("no delivered-to chip on a one-mailbox account with removed copies", async () => {
    const el = await launchOverTheNewShell([...GONE_A, A], `#/ohbox/m/m1`, false);
    await waitFor(() => letterHead(el, "Hello there") !== null, "the open message");
    await settle();
    expect(deliveredTo(el)).toEqual([]);
  });

  it("CONTROL — two live mailboxes do carry the chip", async () => {
    const el = await launchOverTheNewShell([A, B], `#/ohbox/m/m1`, false);
    await waitFor(() => deliveredTo(el).length > 0, "the delivered-to chip");
  });

  it("no mailbox headings in the rail over a live tree and its removed copy's tree", async () => {
    const trees = [folder("fd-a", A.id, A.address, 900), folder("fd-a1", GONE_A[0]!.id, A.address, 901), nestedFolder];
    const el = await launchOverTheNewShell([...GONE_A, A], "#/ohbox", false, trees);
    await waitFor(() => (el.textContent ?? "").includes("Projects"), "the folder tree");
    const tree = await openFolderTree(el);
    expect(within(tree).getAllByRole("button", { name: "Projects" })).toHaveLength(2);
    expect(folderHeadings(tree)).toEqual([]);
  });

  it("CONTROL — two live trees are headed", async () => {
    const el = await launchOverTheNewShell([A, B], "#/ohbox", false, [...TWO_TREES, nestedFolder]);
    const tree = await openFolderTree(el);
    await waitFor(() => folderHeadings(tree).length > 0, "the mailbox headings");
  });

  it("a removed mailbox of another address keeps its rail heading and its delivered-to chip", async () => {
    const trees = [folder("fd-a", A.id, A.address, 900), folder("fd-c", GONE_C.id, GONE_C.address, 901), nestedFolder];
    const el = await launchOverTheNewShell([A, GONE_C], "#/ohbox/m/m2", false, trees, [["m2", { mailboxId: GONE_C.id, subject: "Kept letter" }]]);
    await waitFor(() => letterHead(el, "Kept letter") !== null, "the kept message");
    const tree = await openFolderTree(el);
    await waitFor(() => folderHeadings(tree).length === 2, "the mailbox headings");
    expect(folderHeadings(tree)).toEqual([A.address, GONE_C.address]);
    await waitFor(() => deliveredTo(el, "Kept letter").includes(GONE_C.address), "the removed mailbox's chip");
  });
});

describe("the label counts addresses, not removed copies", () => {
  it("a removed copy does not make its own address's short form collide", () => {
    const other = row("mb-o", "a@other.invalid");
    const label = mailboxLabelResolver([...GONE_A, A, other]);
    expect([label(A.id, "short"), label(GONE_A[0]!.id, "short"), label(other.id, "short")])
      .toEqual(["example.invalid", "example.invalid", "other.invalid"]);
  });
});

describe("Settings → Folders lists live mailboxes only", () => {
  const perMailbox = (el: HTMLElement): string[] => {
    const head = within(el).queryByRole("heading", { name: messages.settings.folders.mailboxesTitle, level: 2 });
    const sheet = head?.closest<HTMLElement>(".oh-settingssheet");
    return sheet ? within(sheet).getAllByRole("switch").map((control) => control.getAttribute("aria-label") ?? "") : [];
  };

  it("one live mailbox beside its removed copies gets no per-mailbox switch", async () => {
    const el = await launchOverTheNewShell([...GONE_A, A], "#/settings/folders", false);
    await waitFor(
      () => within(el).queryByRole("switch", { name: messages.settings.folders.useTitle, checked: true }) !== null,
      "the folders pane with folders enabled",
    );
    await settle();
    expect(perMailbox(el)).toEqual([]);
  });

  it("CONTROL — two live mailboxes get one switch each", async () => {
    const el = await launchOverTheNewShell([GONE_B, A, B], "#/settings/folders", false);
    await waitFor(() => perMailbox(el).length > 0, "the per-mailbox switches");
    expect(perMailbox(el)).toEqual([A.address, B.address]);
  });
});
