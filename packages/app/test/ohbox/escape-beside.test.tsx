/** @vitest-environment jsdom */
/**
 * ESCAPE CLOSES THE OPEN LETTER BESIDE A LIST (the switch's point 64, by RULING-JOIN J-1): at two columns, as over one,
 * Escape takes the open letter out of the address (replaced, so Back leaves the place) and the keys are the list's;
 * beside the list it comes LAST, as today's shell had it: a picked set is cleared first, and from the letter the keys
 * walk back to its row first. No close of its own is drawn on the column. Over the Ohbox's own seat, the real
 * registrations, reader and frame, on the fake host that hands the mail ground.
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

const escape = (): void => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
};

describe("Escape beside a list, at two columns", () => {
  it("closes the open letter last: from the letter the keys walk back to its row first, then the letter leaves the address in place", async () => {
    const { address } = seat({ room: "desktop", first: "#/ohbox/m/b" });
    await settle();
    /* The keys are in the letter, as a person reading it holds them. */
    const column = document.querySelector<HTMLElement>("section.fr-reading [tabindex]");
    if (column === null) throw new Error("the letter's column takes no keys");
    act(() => column.focus());
    escape();
    await settle();
    expect(address.read(), "the first press walks the keys back; the letter stays").toBe("#/ohbox/m/b");
    expect(
      screen.getByRole("listbox").contains(document.activeElement),
      "the keys are on the list's row",
    ).toBe(true);
    escape();
    await settle();
    expect(address.read()).toBe("#/ohbox");
    expect(address.writes.at(-1)?.how, "replaced, so Back leaves the place").toBe("replace");
    expect(screen.getByRole("listbox").contains(document.activeElement), "the keys stay the list's").toBe(
      true,
    );
  });

  it("comes after the list's own Escape: with rows picked, the first press clears them and the next closes the letter", async () => {
    const { address } = seat({ room: "desktop", first: "#/ohbox/m/b" });
    await settle();
    press("x");
    const picked = () => rows().filter((r) => r.hasAttribute("data-picked")).length;
    expect(picked()).toBeGreaterThan(0);
    escape();
    await settle();
    expect(picked(), "the picks were cleared first").toBe(0);
    expect(address.read(), "the letter stays for that press").toBe("#/ohbox/m/b");
    escape();
    await settle();
    expect(address.read()).toBe("#/ohbox");
  });

  it("draws no close of its own on the column", async () => {
    seat({ room: "desktop", first: "#/ohbox/m/b" });
    await settle();
    expect(screen.queryByRole("button", { name: /^(Close|✕)$/ })).toBeNull();
  });

  it("with no letter open Escape takes nothing out of the address", async () => {
    const { address } = seat({ room: "desktop", first: "#/ohbox" });
    await settle();
    const writes = address.writes.length;
    escape();
    await settle();
    expect(address.read()).toBe("#/ohbox");
    expect(address.writes.length).toBe(writes);
  });
});
