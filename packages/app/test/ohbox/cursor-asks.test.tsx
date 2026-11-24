/** @vitest-environment jsdom */
/**
 * THE CURSOR ROW's TWO KEYS THAT ASK, where one column stands and no letter is over the list (the switch's point 62,
 * by RULING-JOIN J-1: today's shell bound them there): `m` asks where to and moves the row's letter to the place
 * chosen; `d` asks first, and only the ask's own Delete deletes, holding the delete for the Undo window as `⌫` does.
 * Over the real registrations, reader and frame, on the fake host that hands the mail ground; what a press writes,
 * the frame's one seam sent.
 */
import type { EngineMessage } from "@ohmail/wire";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import { resetUiVitalsForTest, takeUiVitals } from "@ohmail/app-logic/session/ui-vitals";
import { Frame } from "../../src/frame/Frame.js";
import { NONE } from "../../src/host/index.js";
import { MailGround, mailPlaces, mailReader } from "../../src/mail/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import frameEn from "../../messages/frame.en.json" with { type: "json" };
import searchEn from "../../messages/search.en.json" with { type: "json" };
import tagsEn from "../../messages/tags.en.json" with { type: "json" };
import { bodyDouble, fakeMail, letter, WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";

/** The letters' sender, admitted by a rule: the partition presents a decided sender's mail in the Ohbox. */
const ADMITTED = {
  "rule:r1": {
    id: "r1",
    kind: "sender",
    match: "ben@kiln.example",
    destination: "INBOX",
    priority: 0,
    provenance: "manual",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};
/** The host's reader over the ground, made once as a host makes it: its doors are the ground's. */
const READER = mailReader({ body: bodyDouble().body, look: NONE });
const MESSAGES = { ...WORDS.en, ...tagsEn, cursor: frameEn.cursor } as Messages;
/** A letter's day in November 2026, at nine in the morning by the world's clock. */
const at = (day: number, over: Partial<EngineMessage> = {}): Partial<EngineMessage> => {
  const instant = new Date(Date.UTC(2026, 10, day, 9)).toISOString();
  return { date: instant, arrivedAt: instant, ...over };
};
/** Three letters of one admitted sender, newest first as the list draws them: c, b, a. */
const THREE = [
  letter("a", at(10, { subject: "Kiln schedule" })),
  letter("b", at(11, { subject: "Glaze order" })),
  letter("c", at(12, { subject: "Studio keys" })),
];

function seat(o: { letters?: readonly EngineMessage[]; room?: "desktop" | "phone"; first?: string } = {}) {
  const mail = fakeMail(o.letters ?? THREE, [], {}, ADMITTED);
  const address = fakeAddress(o.first ?? "#/ohbox");
  const { host } = fakeHost({
    engine: mail.engine,
    service: "self",
    scope: "acct-1",
    places: mailPlaces(),
    above: MailGround,
    reader: READER,
    window: fakeWindow(o.room ?? "desktop"),
    address,
  });
  render(
    <TextProvider locale="en" messages={MESSAGES} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>,
  );
  return { mail, address };
}
const rows = (): HTMLElement[] => screen.getAllByRole("option");
const press = (key: string, more: KeyboardEventInit = {}): void => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...more });
};

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** What the seam sent, by kind and letter, in order. */
const sent = (mail: ReturnType<typeof seat>["mail"]): string[] =>
  mail.mutations.map((m) => {
    const r = m as {
      kind: string;
      messageId?: string;
      messageIds?: string[];
      state?: string;
      folder?: string;
      unread?: boolean;
    };
    const ids = r.messageId ?? r.messageIds?.join(",") ?? "";
    const how = r.state ?? r.folder ?? (r.unread === undefined ? "" : r.unread ? "unread" : "read");
    return [r.kind, ids, how].filter(Boolean).join(" ");
  });
const cursorRow = (): string | null => rows().find((r) => r.hasAttribute("data-open"))?.dataset.id ?? null;
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
/** The sentence the frame's one report slot says now. */
const said = (): string => screen.getByRole("status").querySelector("span")?.textContent ?? "";

/** A question standing over the page, by its name: the kit draws an ask as a dialog and a list of places as a menu. */
const findAsk = (name: string): HTMLElement | null =>
  screen.queryByRole("dialog", { name }) ?? screen.queryByRole("menu", { name });
const ask = (name: string): HTMLElement => {
  const found = findAsk(name);
  if (found === null) throw new Error(`no question "${name}" stands`);
  return found;
};
const noAsk = (name: string): boolean => findAsk(name) === null;

describe("the cursor row's keys that ask, at a phone's width", () => {
  it("m asks where to; the place chosen moves the cursor row's letter through the seam, once", async () => {
    const { mail } = seat({ room: "phone" });
    press("j");
    expect(cursorRow()).toBe("c");
    press("m");
    const where = ask("Move");
    expect(mail.mutations).toEqual([]);
    fireEvent.click(within(where).getAllByRole("menuitem")[1]!);
    await settle();
    expect(noAsk("Move")).toBe(true);
    expect(mail.mutations.length).toBe(1);
    expect(sent(mail)[0]).toContain(" c");
  });

  it("d asks first: nothing leaves at the press, Cancel keeps the letter, and the ask's Move holds its delete for the Undo window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { mail } = seat({ room: "phone" });
    press("j");
    press("d");
    const first = ask("Move to Trash.");
    expect(within(first).queryByText(/ohmail never erases mail/)).toBeNull();
    expect(
      within(first)
        .getAllByRole("menuitem")
        .map((answer) => answer.textContent),
    ).toEqual(["Move", "Cancel"]);
    fireEvent.click(within(first).getByRole("menuitem", { name: "Cancel" }));
    expect(noAsk("Move to Trash.")).toBe(true);
    expect(rows().map((r) => r.dataset.id)).toEqual(["c", "b", "a"]);
    press("d");
    fireEvent.click(within(ask("Move to Trash.")).getByRole("menuitem", { name: /^Move/ }));
    expect(rows().map((r) => r.dataset.id)).toEqual(["b", "a"]);
    expect(mail.mutations, "nothing leaves before the Undo window ends").toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(UNDO_MS + 2000);
    });
    expect(sent(mail)).toEqual(["message_delete c"]);
  });

  it("a held d asks nothing more than one press does, and a press in no letter's row asks nothing", () => {
    seat({ room: "phone" });
    press("d");
    expect(noAsk("Move to Trash."), "the first press places the cursor").toBe(true);
    press("d", { repeat: true });
    expect(noAsk("Move to Trash.")).toBe(true);
  });

  it("two columns bind neither on the list: the reader's own d and m are the letter's", () => {
    const { mail } = seat({ room: "desktop" });
    press("m");
    press("d");
    expect(noAsk("Move")).toBe(true);
    expect(noAsk("Move to Trash.")).toBe(true);
    expect(mail.mutations).toEqual([]);
  });
});
