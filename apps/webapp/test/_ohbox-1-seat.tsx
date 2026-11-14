/**
 * THE OHBOX's OWN SEAT, over the mail ground, mounted as its own cases mount it (`packages/app/test/ohbox/seat.test.tsx`:
 * `fakeHost` with `mailPlaces()`, `MailGround` above and the host's reader over the ground's doors) and read back out
 * of the page by role and name: share ohbox-1's helper for the older tests that mounted today's Ohbox view through
 * `ohbox/_today.tsx` (the join folds it). What a case hands is an engine: a real `OhmailEngine`, or one over a
 * reader's rows (`engineOver`), whose senders a rule admits (the partition presents a decided sender's mail in the
 * Ohbox; today's harness handed the view its lists already cut, so it needed none).
 */
import type { EngineMessage } from "@ohmail/wire";
import { act, cleanup, render } from "@testing-library/react";
import type { EntityReader, OhmailEngine } from "@ohmail/client-engine";
import { EngineContext } from "@ohmail/app-logic/engine";
import { SYNC_SETTLED } from "@ohmail/app-logic/session/sync-scheduler";
import { Frame } from "../../../packages/app/src/frame/Frame.js";
import { NONE } from "../../../packages/app/src/host/index.js";
import { MailGround, mailPlaces, mailReader } from "../../../packages/app/src/mail/index.js";
import type { LetterProps } from "../../../packages/app/src/reader/index.js";
import { TextProvider, type Messages } from "../../../packages/app/src/text/index.js";
import doorsEn from "../../../packages/app/messages/doors.en.json" with { type: "json" };
import frameEn from "../../../packages/app/messages/frame.en.json" with { type: "json" };
import ohboxEn from "../../../packages/app/messages/ohbox.en.json" with { type: "json" };
import readerEn from "../../../packages/app/messages/reader.en.json" with { type: "json" };
import screenerEn from "../../../packages/app/messages/screener.en.json" with { type: "json" };
import searchEn from "../../../packages/app/messages/search.en.json" with { type: "json" };
import sharedEn from "../../../packages/app/messages/shared.en.json" with { type: "json" };
import tagsEn from "../../../packages/app/messages/tags.en.json" with { type: "json" };
import trashEn from "../../../packages/app/messages/trash.en.json" with { type: "json" };
import { fakeMail } from "../../../packages/app/test/reader/support/fake-mail.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import { FRAME_WORDS } from "../../../packages/app/test/support/frame-words.js";

/** The seat's words, as the reader's own cases compose them (`reader/support/mail.tsx`'s `WORDS.en`, with the tags). */
const MESSAGES = {
  ...FRAME_WORDS.en,
  ...sharedEn,
  ...ohboxEn,
  ...screenerEn,
  ...trashEn,
  ...doorsEn,
  ...searchEn,
  ...readerEn,
  ...tagsEn,
  cursor: frameEn.cursor,
} as Messages;

/** The letter's body, drawn as the reader's own cases draw it: its text and the end the read rule reads. */
function Body(props: LetterProps) {
  return (
    <div className="stub-body">
      <p>{props.text}</p>
      <span data-own-end="" />
    </div>
  );
}

/** A rule that admits a sender, keyed as the fake engine keeps rows (`rule:<id>`). */
export function admitting(addresses: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    [...new Set(addresses.map((a) => a.toLowerCase()))].map((address, i) => [
      `rule:admit-${i}`,
      {
        id: `admit-${i}`,
        kind: "sender",
        match: address,
        destination: "INBOX",
        priority: 0,
        provenance: "manual",
        enabled: true,
        stats: { hits: 0, lastHitAt: null, demotions: 0 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]),
  );
}

/** An engine over every row a reader holds (letters, their states, threads), each letter's sender admitted. */
export function engineOver(reader: EntityReader, types: readonly string[] = ["message_state", "thread", "rule", "tag"]) {
  const letters = reader.list<EngineMessage>("message");
  const more: Record<string, unknown> = admitting(letters.map((m) => m.from.address));
  for (const type of types)
    for (const e of reader.entries<unknown>(type)) more[`${type}:${e.id}`] = e.entity;
  return fakeMail(letters, [], {}, more);
}

/**
 * The Ohbox's seat over `engine`, at a desktop's width or a phone's; `first` is the address it opens at; `own` the
 * account's own addresses, as its mailboxes' facts answer them (the partition turns the account's own mail into a
 * stranger's while it knows none).
 */
export function mountSeat(
  engine: OhmailEngine,
  o: {
    room?: "desktop" | "phone";
    first?: string;
    own?: readonly string[];
    /**
     * The demo's world: an engine with no consent behind it (the demo's fixtures), whose mail is not partitioned,
     * bound above the frame as the demo's host binds it. Today's harness handed the view its lists uncut.
     */
    demo?: boolean;
  } = {},
) {
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => undefined;
  cleanup();
  const address = fakeAddress(o.first ?? "#/ohbox");
  const { host } = fakeHost({
    engine,
    service: "self",
    scope: "acct-1",
    places: mailPlaces(),
    above: MailGround,
    reader: mailReader({ body: Body, look: NONE }),
    window: fakeWindow(o.room ?? "desktop"),
    address,
    ...(o.own
      ? {
          mailboxes: async () =>
            o.own!.map((own, i) => ({
              id: `mb-own-${i}`,
              address: own,
              addressIsOwn: true,
              status: "active",
              organizerRole: "organizer",
            })),
        }
      : {}),
  });
  const frame = <Frame host={host} />;
  const drawn = render(
    <TextProvider locale="en" messages={MESSAGES} timeZone="UTC">
      {o.demo ? (
        <EngineContext.Provider value={{ engine, demo: true, serverDemo: true, sync: SYNC_SETTLED }}>{frame}</EngineContext.Provider>
      ) : (
        frame
      )}
    </TextProvider>,
  );
  return { container: drawn.container, address };
}

export interface SeatRow {
  id: string;
  ids: string[];
  /** The row is drawn unread (the kit's row says it: `data-unread`). */
  unread: boolean;
  /** The group it stands under: its listbox's name ("Resurfaced", "New", "Earlier"). */
  group: string;
}

/** Every row the seat draws, group by group, top to bottom. */
export function seatRows(root: ParentNode = document): SeatRow[] {
  const out: SeatRow[] = [];
  for (const listbox of [...root.querySelectorAll('[role="listbox"]')]) {
    const group = listbox.getAttribute("aria-label") ?? "";
    for (const row of [...listbox.querySelectorAll<HTMLElement>('[role="option"][data-id]')]) {
      out.push({
        id: row.dataset.id!,
        ids: row.dataset.ids?.split(" ") ?? [row.dataset.id!],
        unread: row.hasAttribute("data-unread"),
        group,
      });
    }
  }
  return out;
}

/** Take the seat down (each case's after: a seat left standing reads a document the environment has torn down). */
export const unmountSeat = (): void => cleanup();

/** A beat for the ground and the seat to settle after the engine moved. */
export const settleSeat = () => act(async () => new Promise((r) => setTimeout(r, 0)));
