/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { waterlineIdOf } from "@ohmail/client-engine";
import { MailGround, mailPlaces } from "../../../packages/app/src/mail/index.js";
import { mountReader } from "../../../packages/app/test/reader/support/mail.js";
import { issue } from "../../../packages/app/test/streams/registered-world.js";
import { fakeAddress } from "../../../packages/app/test/support/fake-window.js";
import en from "../messages/en.json";
import de from "../messages/de.json";

afterEach(cleanup);

function mount(unread: number, fresh?: number, lang: "en" | "de" = "en") {
  const top = Math.max(unread, fresh ?? 0);
  const letters = Array.from({ length: top }, (_, i) =>
    issue(`issue-${i}`, 20 - i, { unread: i < unread }));
  letters.push(issue("already-read", 10, { unread: false }));
  const line = fresh === undefined ? null : { newestSeenId: letters[fresh]!.id };
  const { mail } = mountReader({
    letters,
    open: null,
    lang,
    words: lang === "en" ? en : de,
    rows: line ? { [`view_meta:${waterlineIdOf("reads")}`]: line } : {},
    host: { above: MailGround, places: mailPlaces(), address: fakeAddress("#/reads") },
  });
  const banner = within(within(screen.getByRole("region", { name: "News" })).getByRole("banner"));
  const menuName = lang === "en" ? "List" : "Liste";
  const item = (name: string) => {
    fireEvent.click(banner.getByRole("button", { name: menuName }));
    return within(screen.getByRole("menu", { name: menuName })).getByRole("menuitem", { name });
  };
  return { item, mail, line };
}

// The list menu stays visible. The studio shows its Mark all read action disabled when both counts are zero.
describe("MarkAllRead — disabled when there is nothing to clear", () => {
  it("is disabled and sends nothing when there is no unread or fresh count", () => {
    const { item, mail } = mount(0);
    const markAll = item("Mark all read");
    expect(markAll).toHaveProperty("disabled", true);
    fireEvent.click(markAll);
    expect(mail.mutations).toEqual([]);
  });

  it("is disabled and sends nothing when both counts are explicitly zero", () => {
    const { item, mail } = mount(0, 0);
    const markAll = item("Mark all read");
    expect(markAll).toHaveProperty("disabled", true);
    fireEvent.click(markAll);
    expect(mail.mutations).toEqual([]);
  });

  it("renders a pressable button when unread > 0", async () => {
    const { item, mail, line } = mount(5, 2);
    const ids = ["issue-0", "issue-1", "issue-2", "issue-3", "issue-4"];
    const markAll = item("Mark all 5 unread messages read");
    await act(async () => { fireEvent.click(markAll); });
    expect(mail.mutations).toEqual([
      { kind: "mark_seen", messageIds: ids, unread: false },
      { kind: "feed_mark_seen", view: "reads", upToId: "issue-0", messageIds: [] },
    ]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(mail.mutations.slice(2)).toEqual([
      { kind: "mark_seen", messageIds: ids, unread: true },
      { kind: "feed_mark_seen", view: "reads", messageIds: [], line },
    ]);
  });

  it("renders for a standing FRESH count with zero unread — the streams' waterline count must be clearable", async () => {
    const { item, mail } = mount(0, 2);
    const markAll = item("Mark all 2 messages new since you were here as read");
    await act(async () => { fireEvent.click(markAll); });
    expect(mail.mutations).toEqual([
      { kind: "feed_mark_seen", view: "reads", upToId: "issue-0", messageIds: [] },
    ]);
  });

  it("with both counts, the aria speaks to the unread — the stronger statement", () => {
    const { item } = mount(3, 5);
    expect(item("Mark all 3 unread messages read")).toBeTruthy();
  });

  it("one unread or one new message is named in the singular, in English and German", () => {
    const names = [
      ["en", "Mark the 1 unread message read", "Mark the 1 message new since you were here as read"],
      ["de", "Die 1 ungelesene Nachricht als gelesen markieren", "Die 1 Nachricht, die seit deinem letzten Besuch neu ist, als gelesen markieren"],
    ] as const;
    for (const [lang, unread, fresh] of names) {
      expect(mount(1, undefined, lang).item(unread)).toBeTruthy();
      cleanup();
      expect(mount(0, 1, lang).item(fresh)).toBeTruthy();
      cleanup();
    }
  });
});
