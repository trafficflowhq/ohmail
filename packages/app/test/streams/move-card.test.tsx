/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { issue, mountStreamFrame, receipt } from "./registered-world.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  Element.prototype.scrollIntoView ??= () => undefined;
  HTMLElement.prototype.scrollTo ??= () => undefined;
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});

const mailbox = (id: string, role: "organizer" | "reader") => ({
  id,
  address: `${id}@example.invalid`,
  addressIsOwn: true,
  organizerRole: role,
  status: "connected",
  createdAt: "2026-11-01T00:00:00.000Z",
  lastSyncAt: "2026-11-02T00:00:00.000Z",
  ...(role === "reader"
    ? {
        organizeConsentedAt: "2026-11-01T00:00:00.000Z",
        organizedBy: { kind: "local", name: "Organizer", since: "2026-11-01T00:00:00.000Z" },
      }
    : {}),
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  ["reads", "organizer"],
  ["receipts", "organizer"],
  ["reads", "reader"],
  ["receipts", "reader"],
] as const)(
  "moving my own %s card leaves its correspondent in the other %s mailbox",
  async (place, otherRole) => {
    const [make, other] = place === "reads" ? [issue, receipt] : [receipt, issue];
    const own = mailbox("first", "organizer");
    const opened = make("opened", 10, {
      mailboxId: own.id,
      threadId: "together",
      from: { name: "Me", address: own.address },
    });
    const companion = other("correspondent", 9, { mailboxId: "second", threadId: "together" });
    const { mail } = mountStreamFrame({
      at: `#/${place}/m/opened`,
      letters: [opened, companion],
      mailboxes: async () => [own, mailbox("second", otherRole)],
    });
    await act(async () => vi.advanceTimersByTimeAsync(30));
    expect(document.querySelector('.pl-list [data-id="opened"]')).toBeTruthy();
    expect(document.querySelector('.pl-list [data-id="correspondent"]')).toBeNull();
    fireEvent.keyDown(document.body, { key: "m" });
    fireEvent.click(
      within(screen.getByRole("menu", { name: "Move" })).getByRole("menuitem", { name: "Ohbox" }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(mail.mutations.filter((m) => m.kind === "move")).toEqual([
      { kind: "move", messageId: opened.id, folder: "INBOX" },
    ]);
    expect(mail.mutations.filter((m) => m.kind.startsWith("rule_") || m.kind === "screener_decide")).toEqual(
      [],
    );
  },
);

it.each(["reads", "receipts"] as const)(
  "moving a %s card leaves the sender's waiting letter at its gate",
  async (place) => {
    const make = place === "reads" ? issue : receipt;
    const opened = make("opened", 10, { mailboxId: "first" });
    const held = make("held", 9, { mailboxId: "second", folder: "ohmail/Screener" });
    const { mail } = mountStreamFrame({
      at: `#/${place}/m/opened`,
      letters: [opened, held],
      mailboxes: async () => [mailbox("first", "organizer"), mailbox("second", "reader")],
    });
    const writes = () =>
      mail.mutations.filter(
        (m) => m.kind === "move" || m.kind === "screener_decide" || m.kind.startsWith("rule_"),
      );
    await act(async () => vi.advanceTimersByTimeAsync(30));
    expect(document.querySelector('.pl-list [data-id="opened"]')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "m" });
    const ohbox = within(screen.getByRole("menu", { name: "Move" })).getByRole("menuitem", { name: "Ohbox" });
    expect(writes()).toEqual([]);
    fireEvent.click(ohbox);
    const move = { kind: "move", messageId: opened.id, folder: "INBOX", pressRule: true };
    expect(writes()).toEqual([move]);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(writes()).toEqual([
      move,
      expect.objectContaining({
        kind: "rule_update",
        ruleId: place === "reads" ? "r-news" : "r-receipts",
        destination: "INBOX",
        applyRetro: false,
      }),
    ]);
  },
);
