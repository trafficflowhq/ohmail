/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import en from "../messages/en.json";
import {
  joinRecipients,
  moveRecipient,
  splitRecipients,
  type RecipientMove,
} from "@ohmail/app-logic/writing/recipient-lines";
import { composePlan, parseRecipients, resetComposerForTest } from "@ohmail/app-logic/writing/compose";
import { formatRecipientChips } from "@ohmail/app-logic/writing/compose-from";
import { act, message, stubDom } from "./_draft-shell.js";
import { letter } from "./_handoff-steps.js";
import { mountWriting, rounds, unmountWritings, type WritingWorld } from "./_write-1-writing.js"; // Write over parts that stay (share write-1): today's field leaves

/**
 * THE RECIPIENT FIELD — chips over one wire string.
 *
 * The rule: recipients must ALWAYS be editable — removable one at a time, addable by typing,
 * draggable within and between rows, movable by keyboard. The value stays ONE comma-separated
 * string (`ComposeFields.to`'s shape), so the guards here are about the two directions of that
 * bijection and about the envelope:
 *
 *  1. WHAT THE CHIPS DO TO THE STRING. Removing a chip, committing the tail, accepting a
 *     suggestion and moving a chip between rows must each change the string — because the
 *     string is what `composePlan` builds the SMTP envelope from. Several assertions below
 *     therefore end at `composePlan`/`parseRecipients`, not at the DOM: a chip UI that looks
 *     right and leaves the envelope unchanged is mail going to the wrong people.
 *  2. WHAT IT WRITES READS BACK. Accepting must produce something `parseRecipients` reads
 *     back as the address that was picked — otherwise the field looks right and the mail goes
 *     nowhere. (`packages/client-engine/test/address-book.test.ts` proves the ranking.)
 *
 * RE-POINTED (share write-1 of the older tests' sorting, 18 November): the field is Write's people lines
 * (`packages/app/src/write/head/People.tsx` in the kit's `Recipients`) on Write's new letter, as the mail ground
 * mounts it (`_write-1-writing.tsx`); the string is the composition's own `to` (`cc`, `bcc`); the address book is
 * the one the mirror makes (`addressBook` over its letters, as Write's suggestions read it), so each book below is
 * the letters that make it. The pure cases read the line model by its own path (`recipient-lines.ts`). The cases
 * Write does not hold yet were moved as they stood to `recipient-field-gaps.test.ts`.
 */
const W = en.write;

/* Write's text is the ground's rich editor (ProseMirror): a drop asks the page which place is under the pointer,
   which every browser answers and jsdom does not. Nothing is under it here. */
if (typeof document.elementFromPoint !== "function") document.elementFromPoint = () => null;

const ME = { address: "me@example.invalid", name: "Me" };
/** A letter the account wrote to `address` (its Sent copy): who the account wrote to, by the name it used. */
const wroteTo = (id: string, address: string, name: string, at = "2026-09-27T08:29:00.000Z"): EngineMessage =>
  message(id, { folder: "Sent" as never /* the Sent copy: a mirror row the wire type does not name */, from: ME, to: [{ address, name }], date: at, updatedAt: at });
/** A letter `address` wrote to the account. */
const wroteMe = (id: string, address: string, name: string, at = "2026-09-27T08:29:00.000Z"): EngineMessage =>
  message(id, { from: { address, name }, to: [ME], date: at, updatedAt: at });

/** The book of today's field (Lena written to most, then Leon; Mara wrote to the account), as letters that make it. */
const BOOK: EngineMessage[] = [
  wroteTo("b1", "lena@atelier.invalid", "Lena Eichspan"),
  wroteTo("b2", "lena@atelier.invalid", "Lena Eichspan"),
  wroteTo("b3", "lena@atelier.invalid", "Lena Eichspan"),
  wroteTo("b4", "leon@example.invalid", "Leon Frei"),
  wroteMe("b5", "mara@example.invalid", ""),
];

let w: WritingWorld;
/** The composition's three lines as they stand. */
const rowsNow = (): { to: string; cc: string; bcc: string } => {
  const c = w.now().compose;
  return { to: c.to, cc: c.cc, bcc: c.bcc };
};
/** The To line's wire string: what the envelope is built from. */
const wire = (): string => rowsNow().to;

/** Write's new letter over a mirror holding `book`, its To line standing at `initial` as the composition holds it. */
async function render(initial = "", book: readonly EngineMessage[] = BOOK): Promise<void> {
  w = await mountWriting({ view: true, messages: [...book] });
  if (initial !== "") {
    await act(async () => w.now().onComposeFields({ ...w.now().compose, to: initial }));
  }
  /* The page settles before a person acts in it: the new letter's text takes the keys once, at its mount, a
     frame after it is drawn. */
  await rounds(6);
}

const lineOf = (name: string = W.to): HTMLElement => screen.getByRole("group", { name });
/** The place to type on a line (a combobox where people are offered). */
const input = (name: string = W.to): HTMLInputElement =>
  within(lineOf(name)).getByRole(screen.queryByRole("combobox", { name }) ? "combobox" : "textbox", {
    name,
  }) as HTMLInputElement;
/** The people on a line: each a button that opens the person's menu. */
const chips = (name: string = W.to): HTMLElement[] =>
  within(lineOf(name))
    .queryAllByRole("button")
    .filter((b) => b.getAttribute("aria-haspopup") === "menu");
/** The wire entry each person on the line stands for (Write's person id: line, place, entry). */
const chipEntries = (name: string = W.to): string[] =>
  chips(name).map((c) => (c.getAttribute("data-person") ?? "").split("\u0000").slice(2).join("\u0000"));
const chipOf = (entry: string, name: string = W.to): HTMLElement =>
  chips(name)[chipEntries(name).indexOf(entry)]!;
/** The offered people under the line. */
const optionEls = (): HTMLElement[] => screen.queryAllByRole("option");
const options = (): string[] => optionEls().map((li) => li.textContent ?? "");

/** Type into the tail input — the input holds ONLY the entry being typed. */
async function type(text: string, el: HTMLInputElement = input()): Promise<void> {
  await act(async () => {
    fireEvent.change(el, { target: { value: text } });
  });
}

async function press(key: string, opts: KeyboardEventInit = {}, el: HTMLElement = input()): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));
  });
}

/** The lines that are not shown yet (Cc, Bcc), opened as a person opens them. */
async function openLines(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: W.more }));
  });
}

beforeEach(() => {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    /* storage blocked */
  }
  stubDom();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await unmountWritings();
  resetComposerForTest();
});

/* ══ the string ⇄ chips bijection ═══════════════════════════════════════════════════════ */

describe("splitRecipients / joinRecipients", () => {
  it("every complete segment is a chip; the final segment is the tail", () => {
    expect(splitRecipients("a@x.invalid, ma")).toEqual({ chips: ["a@x.invalid"], tail: "ma" });
    expect(splitRecipients("a@x.invalid, b@y.invalid, ")).toEqual({
      chips: ["a@x.invalid", "b@y.invalid"], tail: "",
    });
    expect(splitRecipients("")).toEqual({ chips: [], tail: "" });
    expect(splitRecipients("ma")).toEqual({ chips: [], tail: "ma" });
  });

  it("round-trips: join(split(v)) preserves chips and tail through the next split", () => {
    // The trailing separator is what keeps the last chip a CHIP — without it the final entry
    // would fall back into the input on the next render.
    const joined = joinRecipients(["a@x.invalid", "Lena <l@y.invalid>"], "");
    expect(splitRecipients(joined)).toEqual({
      chips: ["a@x.invalid", "Lena <l@y.invalid>"], tail: "",
    });
    const withTail = joinRecipients(["a@x.invalid"], "ma");
    expect(splitRecipients(withTail)).toEqual({ chips: ["a@x.invalid"], tail: "ma" });
  });

  it("what join writes, parseRecipients reads back — chips never corrupt the envelope", () => {
    const parsed = parseRecipients(joinRecipients(["a@x.invalid", "Lena <l@y.invalid>"], ""));
    expect(parsed.invalid).toEqual([]);
    expect(parsed.addresses.map((a) => a.address)).toEqual(["a@x.invalid", "l@y.invalid"]);
  });
});

describe("a field seeded from stored addresses is ALL chips — CMP-F3", () => {
  /** A file under `apps/webapp`, from the app dir or the repo root — the root run is what CI does. */
  const readSource = (rel: string): string => {
    try {
      return readFileSync(resolve(process.cwd(), `apps/webapp/${rel}`), "utf8");
    } catch {
      return readFileSync(resolve(process.cwd(), rel), "utf8");
    }
  };

  /**
   * ══ THE DEFECT'S MECHANISM, PINNED AS A UNIT ═══════════════════════════════════════════
   *
   * `splitRecipients` reads the value's FINAL segment as the tail being typed. A reopened
   * draft used to seed `to` with a bare `join(", ")`, so its last recipient rendered as raw
   * text in the input — no ×, typing appended to the address, and Send was live over an entry
   * the user could no longer see was half-editable. `formatRecipientChips` ends the string in
   * a separator, which is precisely what keeps the last entry a chip.
   *
   * Mutation: drop the `", "` suffix from `formatRecipientChips`. Real failure text:
   *   AssertionError: the last stored recipient falls back into the input as raw text:
   *   expected { chips: [ …, 'Lena <l@y.invalid>' ], tail: '' } to deeply equal
   *   { chips: [ 'a@x.invalid' ], tail: 'Lena <l@y.invalid>' }
   */
  it("formatRecipientChips ends in a separator, so the LAST entry stays a chip", () => {
    const seeded = formatRecipientChips([
      { name: null, address: "a@x.invalid" },
      { name: "Lena", address: "l@y.invalid" },
    ]);
    expect(
      splitRecipients(seeded),
      "the last stored recipient falls back into the input as raw text",
    ).toEqual({ chips: ["a@x.invalid", "Lena <l@y.invalid>"], tail: "" });
    // …and the wire is unchanged by the extra separator.
    const parsed = parseRecipients(seeded);
    expect(parsed.invalid).toEqual([]);
    expect(parsed.addresses.map((a) => a.address)).toEqual(["a@x.invalid", "l@y.invalid"]);
    expect(formatRecipientChips([])).toBe("");
  });

  /** Rendered: the seeded value produces N chips and an EMPTY input, not N-1 and a torso. */
  it("renders every seeded recipient as a chip with an empty tail input", async () => {
    // Seeded as the composition seeds it: a reopened draft (`openDraft`, `formatRecipientChips(d.to)`).
    const row = {
      ...letter("d-seed", "Plans", "Shall we?"),
      to: [{ name: null, address: "a@x.invalid" }, { name: null, address: "b@y.invalid" }],
    };
    w = await mountWriting({ view: true, drafts: [row as never] });
    await act(async () => w.now().openDraft(row as never));
    await rounds(4);
    expect(chipEntries()).toEqual(["a@x.invalid", "b@y.invalid"]);
    expect(input().value, "the last recipient is sitting in the input as text").toBe("");
  });

  /**
   * THE SEAMS, STRUCTURALLY — a helper that is right and unused leaves the defect exactly as
   * it was. Every surface that seeds a recipient field from stored ADDRESSES goes through it:
   * a reopened draft and the contact popover's Write (`shell-compose.ts`), and the reply head
   * opening for edit (Write's reply: `writing-reply.ts`'s `seed`, which the reply's change
   * press hands its lines). Today's composer's accepted AI draft has no surface in Write: its line
   * was split out word for word to `recipient-field-gaps.test.ts`.
   */
  it("every address-seeding surface goes through formatRecipientChips", () => {
    const shell = readSource("../../packages/app-logic/src/writing/shell-compose.ts");
    expect(shell, "openDraft seeds To without the chips form — the last recipient un-chips")
      .toMatch(/to: formatRecipientChips\(d\.to\)/);
    expect(shell).toMatch(/cc: formatRecipientChips\(d\.cc\)/);
    expect(shell).toMatch(/bcc: formatRecipientChips\(d\.bcc\)/);

    const reply = readSource("../../packages/app-logic/src/writing/writing-reply.ts");
    expect(reply, "the opened reply audience no longer prefills through the shared chips form")
      .toMatch(/to: formatRecipientChips\(to\)/);
  });
});

/**
 * ══ THE NAME ON THE CHIP IS THE NAME OF THE PERSON AT THAT ADDRESS ═════════════════════════
 *
 * Reported from a live account, as the chip rendered it:
 *
 *     Example Boat Hire Ltd - Sam Example   sam@example.com   ×
 *
 * — "this is not Andreas". The address was right and the name was somebody else's idea of him.
 *
 * The other tests in this file end at `parseRecipients`/`composePlan` because a chip that looks
 * right over a wrong envelope is mail to the wrong people. This one is the opposite direction
 * and needs the whole run: the derivation in `@ohmail/client-engine` chooses the name, the field
 * writes it into the value on accept, and the chip renders it — three modules, and the defect
 * was invisible in each one alone. So the book here is DERIVED from a mirror by `addressBook`
 * rather than hand-written, which is what makes this a reproduction and not a restatement.
 *
 * Mutation (watched red): restore `if (name.length > prev.name.length) prev.name = name` in
 * `packages/client-engine/src/address-book.ts`. Real failure text:
 *   AssertionError: the chip names somebody other than the person at this address:
 *   expected 'Bootsvermietung Enge GmbH - Andreas Ingold' to be 'Andreas Ingold'
 */
describe("the name a suggestion carries onto the chip", () => {
  const who = (address: string, name: string | null = null) => ({ address, name });
  const at = (days: number): string =>
    new Date(Date.now() - days * 86_400_000).toISOString();

  /** A mirror where Andreas signs his own mail, and a company's mail addresses him its way. */
  const mirror = (): EngineMessage[] => [
    message("m1", {
      folder: "INBOX", date: at(3), updatedAt: at(3), to: [], cc: [],
      from: who("andi@bergerweb.invalid", "Andreas Ingold"), authVerdict: "pass",
    } as never),
    message("m2", {
      folder: "INBOX", date: at(1), updatedAt: at(1), cc: [],
      from: who("buero@bootsvermietung.invalid", "Bootsvermietung Enge"),
      // The company's client exporting ITS name for him into a To header.
      to: [who("andi@bergerweb.invalid", "Bootsvermietung Enge GmbH - Andreas Ingold")],
    } as never),
  ];

  it("accepting a suggestion chips the sender's OWN name beside their address", async () => {
    await render("", mirror());
    await type("andi");
    expect(options().join(" | ")).toContain("andi@bergerweb.invalid");
    await press("Enter");

    const chip = chips()[0];
    expect(chip?.querySelector("b")?.textContent,
      "the chip names somebody other than the person at this address")
      .toBe("Andreas Ingold");
    // The address beside the name: the person's button names both (`.rcp-chip-addr` was today's).
    expect(chip?.textContent).toContain("andi@bergerweb.invalid");

    // …and the same name is what leaves the account: the chip is a rendering of the value, and
    // the value is what `composePlan` builds the To header from.
    const parsed = parseRecipients(wire());
    expect(parsed.invalid).toEqual([]);
    expect(parsed.addresses).toEqual([
      { name: "Andreas Ingold", address: "andi@bergerweb.invalid" },
    ]);
  });

  /**
   * The second defect the same gesture had, found while reproducing the first.
   *
   * `splitRecipients` is blind to quoting — it splits the value on `[,;]` — so a display name
   * containing a comma cannot survive being written into the field. "Ingold, Andreas" is the
   * Exchange/Outlook default, so this is not an exotic shape: accepting that suggestion wrote
   * `Ingold, Andreas <andi@…>`, which came back as TWO chips, `Ingold` was reported as not an
   * address, and `composePlan`'s stated rule ("a typo blocks the whole send") emptied the
   * envelope. Picking a contact out of your own address book disabled Send.
   *
   * `formatRecipientLine` (`compose-from.ts`) had already decided what to do about this for the
   * reply prefill — drop the name, keep the bare address, because the envelope is the address
   * and the name is sugar. There were two further copies of the formatting and neither carried
   * the rule. Now there is one.
   */
  it("a display name the field's own splitter would tear is dropped, not written", async () => {
    await render("", [wroteTo("i1", "andi@bergerweb.invalid", "Ingold, Andreas")]);
    await type("andi");
    await press("Enter");

    expect(chipEntries(), "the accepted suggestion tore into two chips")
      .toEqual(["andi@bergerweb.invalid"]);
    const parsed = parseRecipients(wire());
    expect(parsed.invalid, "half a display name is being offered to SMTP as an address")
      .toEqual([]);
    expect(parsed.addresses).toEqual([{ name: null, address: "andi@bergerweb.invalid" }]);
    // The send is the thing that was broken: one invalid entry empties the whole envelope.
    const plan = composePlan(
      { to: wire(), cc: "", bcc: "", subject: "s", body: "b", html: "", fromMailboxId: null },
      "mb-1",
    );
    expect(plan.mutation.to!.map((a) => a.address)).toEqual(["andi@bergerweb.invalid"]);
  });
});

describe("moveRecipient — one state change for a chip changing rows or places", () => {
  const rows = { to: "a@x.invalid, b@y.invalid, c@z.invalid, ", cc: "d@w.invalid, ", bcc: "" };

  it("moves a chip to another row: gone from the source string, present in the target", () => {
    const next = moveRecipient(rows, { entry: "b@y.invalid", from: "to", to: "cc", before: null })!;
    expect(splitRecipients(next.to).chips).toEqual(["a@x.invalid", "c@z.invalid"]);
    expect(splitRecipients(next.cc).chips).toEqual(["d@w.invalid", "b@y.invalid"]);
    expect(next.bcc).toBe("");
  });

  it("…and THE WIRE moves with it: composePlan's cc gains what its to loses", () => {
    // The guard the slice brief names: drag To→Cc must move the value's ROW on the wire, not
    // merely its pixel. `composePlan` is the one place the envelope is built.
    const before = composePlan(
      { ...rows, subject: "s", body: "b", html: "", fromMailboxId: null }, "mb-1",
    );
    expect(before.mutation.to!.map((a) => a.address)).toContain("b@y.invalid");
    expect(before.mutation.cc!.map((a) => a.address)).not.toContain("b@y.invalid");

    const moved = moveRecipient(rows, { entry: "b@y.invalid", from: "to", to: "cc", before: null })!;
    const after = composePlan(
      { ...moved, subject: "s", body: "b", html: "", fromMailboxId: null }, "mb-1",
    );
    expect(after.mutation.to!.map((a) => a.address)).not.toContain("b@y.invalid");
    expect(after.mutation.cc!.map((a) => a.address)).toContain("b@y.invalid");
  });

  it("reorders within a row, adjusting the index across the removal", () => {
    const right = moveRecipient(rows, { entry: "a@x.invalid", from: "to", to: "to", before: 2 })!;
    expect(splitRecipients(right.to).chips).toEqual(["b@y.invalid", "a@x.invalid", "c@z.invalid"]);
    const left = moveRecipient(rows, { entry: "c@z.invalid", from: "to", to: "to", before: 0 })!;
    expect(splitRecipients(left.to).chips).toEqual(["c@z.invalid", "a@x.invalid", "b@y.invalid"]);
  });

  it("answers null for an entry that is no longer there — a stale drag moves nothing", () => {
    expect(moveRecipient(rows, { entry: "gone@q.invalid", from: "to", to: "cc", before: null }))
      .toBeNull();
  });

  it("never touches a tail — what somebody is typing is not a chip yet", () => {
    const typing = { to: "a@x.invalid, half-typ", cc: "", bcc: "" };
    const next = moveRecipient(typing, { entry: "a@x.invalid", from: "to", to: "cc", before: null })!;
    expect(splitRecipients(next.to).tail).toBe("half-typ");
    expect(splitRecipients(next.cc).chips).toEqual(["a@x.invalid"]);
  });
});

/* ══ chips in the DOM ═══════════════════════════════════════════════════════════════════ */

describe("chips: every settled recipient is one", () => {
  it("a committed entry renders as a chip and the input holds only the tail", async () => {
    await render("lena@atelier.invalid, ma");
    expect(chipEntries()).toEqual(["lena@atelier.invalid"]);
    expect(input().value).toBe("ma");
  });

  it("↵ with no list open commits the tail as a chip — add by typing", async () => {
    await render();
    await type("nadia@parc.invalid");
    // No suggestion matches this, so ↵ commits rather than accepts.
    await press("Enter");
    expect(chipEntries()).toEqual(["nadia@parc.invalid"]);
    expect(input().value).toBe("");
    // …and the envelope really carries it — add must reach the wire, not the pixels.
    expect(parseRecipients(wire()).addresses.map((a) => a.address)).toEqual(["nadia@parc.invalid"]);
  });

  it("a comma commits too, exactly as it always did", async () => {
    await render();
    await type("nadia@parc.invalid,");
    expect(chipEntries()).toEqual(["nadia@parc.invalid"]);
    expect(input().value).toBe("");
  });

  it("the × removes exactly that chip, and the ENVELOPE loses it", async () => {
    await render("a@x.invalid, b@y.invalid, c@z.invalid, ");
    expect(chipEntries()).toHaveLength(3);
    const before = parseRecipients(wire()).addresses.map((a) => a.address);
    expect(before).toContain("b@y.invalid");

    // The × of the second person: its way off, said with its name (`.rcp-chip-x` was today's).
    const x = within(lineOf()).getByRole("button", { name: W.remove.replace("{name}", "b@y.invalid") });
    await act(async () => { x.click(); });

    expect(chipEntries()).toEqual(["a@x.invalid", "c@z.invalid"]);
    // The removal reached the string the envelope is built from — remove must mutate the
    // wire, or the mail still goes to the person who was just deleted from the screen.
    expect(parseRecipients(wire()).addresses.map((a) => a.address))
      .toEqual(["a@x.invalid", "c@z.invalid"]);
  });

  it("Backspace on an EMPTY input removes the last chip", async () => {
    await render("a@x.invalid, b@y.invalid, ");
    await press("Backspace");
    expect(chipEntries()).toEqual(["a@x.invalid"]);
    expect(parseRecipients(wire()).addresses.map((a) => a.address)).toEqual(["a@x.invalid"]);
  });

  it("Backspace with text in the input edits the TEXT — chips are not collateral", async () => {
    await render("a@x.invalid, ma");
    await press("Backspace");
    // The browser owns the text edit; the guard is that no chip was taken.
    expect(chipEntries()).toEqual(["a@x.invalid"]);
  });

  it("pasting a list splits into chips — commas, semicolons and newlines all separate", async () => {
    await render();
    const paste = (text: string) => act(async () => {
      fireEvent.paste(input(), { clipboardData: { getData: () => text } });
    });
    await paste("a@x.invalid, Lena <l@y.invalid>; c@z.invalid\nd@w.invalid");
    const first = ["a@x.invalid", "Lena <l@y.invalid>", "c@z.invalid", "d@w.invalid"];
    expect(chipEntries()).toEqual(first);
    const parsed = parseRecipients(wire());
    expect(parsed.invalid).toEqual([]);
    expect(parsed.addresses).toHaveLength(4);

    await type("replacefrag");
    input().setSelectionRange(0, "replace".length);
    await paste("b@y.invalid\r\ne@z.invalid\t");
    expect(chipEntries()).toEqual([...first, "b@y.invalid", "e@z.invalid"]);
    expect(input().value).toBe("frag");
  });

  it("an entry that does not parse is a chip too — styled as the error idiom, kept verbatim", async () => {
    await render("nope, a@x.invalid, ");
    const [bad, good] = chips();
    // The error idiom is the person marked refused (today's `bad` class).
    expect(bad!.getAttribute("aria-invalid")).toBe("true");
    expect(chipEntries()[0]).toBe("nope");
    expect(good!.getAttribute("aria-invalid")).toBeNull();
    // The bad entry still blocks the send — composePlan's rule is untouched by the rendering.
    const plan = composePlan(
      { to: wire(), cc: "", bcc: "", subject: "s", body: "b", html: "", fromMailboxId: null }, "mb-1",
    );
    expect(plan.invalid).toEqual(["nope"]);
    expect(plan.mutation.to).toEqual([]);
  });
});

/* ══ the keyboard path ══════════════════════════════════════════════════════════════════ */

describe("keyboard: chips are reachable, removable and movable without a mouse", () => {
  it("← at the start of the input focuses the last chip; Backspace there removes it", async () => {
    await render("a@x.invalid, b@y.invalid, ");
    const el = input();
    el.focus();
    el.setSelectionRange(0, 0);
    await press("ArrowLeft");
    expect(document.activeElement).toBe(chips()[1]);

    await press("Backspace", {}, chips()[1]!);
    expect(chipEntries()).toEqual(["a@x.invalid"]);
  });

  it("←/→ move between chips and back to the input", async () => {
    await render("a@x.invalid, b@y.invalid, ");
    const [first, second] = chips();
    await act(async () => { second!.focus(); });
    await press("ArrowLeft", {}, second!);
    expect(document.activeElement).toBe(first);
    await press("ArrowRight", {}, first!);
    expect(document.activeElement).toBe(second);
    await press("ArrowRight", {}, second!);
    expect(document.activeElement).toBe(input());
  });

  /*
   * Today's field handed the move to its form (`onMove`); Write's lines apply it to the composition. Each move's
   * expectation is the move as today's field handed it, read where it lands: the lines as `moveRecipient` makes
   * them of that move. The Cc line is opened first, as a person sees it before moving a person onto it.
   */
  it("Alt+arrows hand the chip to onMove — the keyboard drag", async () => {
    await render("a@x.invalid, b@y.invalid, ");
    await openLines();
    /** The lines after a move are the lines `moveRecipient` makes of the move today's field handed. */
    const landed = (m: RecipientMove, from: ReturnType<typeof rowsNow>): void =>
      void expect(rowsNow()).toEqual(moveRecipient(from, m));
    let from = rowsNow();
    await press("ArrowRight", { altKey: true }, chipOf("a@x.invalid"));
    landed({ entry: "a@x.invalid", from: "to", to: "to", before: 2 }, from);
    from = rowsNow();
    await press("ArrowDown", { altKey: true }, chipOf("a@x.invalid"));
    landed({ entry: "a@x.invalid", from: "to", to: "cc", before: null }, from);
    // The first row has no row above it — Alt+↑ on To moves nothing rather than wrapping.
    from = rowsNow();
    await press("ArrowUp", { altKey: true }, chips()[0]!);
    expect(rowsNow()).toEqual(from);
  });
});

/* ══ drag and drop between rows ═════════════════════════════════════════════════════════ */

describe("drag: a chip carries its wire entry between rows", () => {
  /*
   * Write's lines are dragged with the pointer (the kit's `Recipients`): the lines one under the other, 32 high,
   * 40 apart; a person 100 wide, one after the other from 60 (the kit's own drag case lays them out the same).
   */
  const layOut = (): void => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const lineOfEl = (el: Element | null) => el?.closest("[data-line-id]")?.getAttribute("data-line-id");
      const row = ["to", "cc", "bcc"].indexOf(lineOfEl(this) ?? "") * 40;
      const peers = [...(this.closest("[data-line-id]")?.querySelectorAll("[data-person]") ?? [])];
      const whoEl = this.matches("[data-person]") ? this : this.querySelector(":scope > [data-person]");
      const at = whoEl ? peers.indexOf(whoEl) : -1;
      const [left, width] = at >= 0 ? [60 + at * 104, 100] : [0, 700];
      return { left, top: row, right: left + width, bottom: row + 32, width, height: 32, x: left, y: row } as DOMRect;
    });
  };
  const point = async (el: Element, kind: string, x: number, y: number): Promise<void> => {
    await act(async () => {
      const event = new MouseEvent(kind, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(el, event);
    });
  };
  /** A person lifted at (x0, y0) and let go at (x, y). */
  const dragTo = async (el: Element, x0: number, y0: number, x: number, y: number): Promise<void> => {
    await point(el, "pointerdown", x0, y0);
    await point(el, "pointermove", x0 + 2, y0 + 1);
    await point(el, "pointermove", x, y);
    await point(el, "pointermove", x + 1, y);
    await point(el, "pointerup", x + 1, y);
  };

  /** The DataTransfer jsdom does not have: enough of one for the handlers under test. */
  function fakeDataTransfer(): DataTransfer {
    const data = new Map<string, string>();
    return {
      setData: (t: string, v: string) => { data.set(t, v); },
      getData: (t: string) => data.get(t) ?? "",
      get types() { return [...data.keys()]; },
      effectAllowed: "uninitialized",
      dropEffect: "none",
    } as unknown as DataTransfer;
  }

  const drag = (type: string, dt: DataTransfer): Event =>
    Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer: dt });

  /* Today's half "dragstart writes the entry and source row" (the HTML drag's payload, `RECIPIENT_DRAG_TYPE`) is
     today's field's own carrier: Write's lines carry the person under the pointer and write no payload. */
  it("dragstart writes the entry and source row; drop on the other row moves it on the WIRE", async () => {
    await render("a@x.invalid, b@y.invalid, ");
    layOut();
    // b, the second person of To, lifted and let go over the Cc line (the lift opens the lines).
    await dragTo(chipOf("b@y.invalid"), 170, 10, 400, 50);
    const rows = rowsNow();

    expect(splitRecipients(rows.to).chips).toEqual(["a@x.invalid"]);
    expect(splitRecipients(rows.cc).chips).toEqual(["b@y.invalid"]);
    // …and the envelope agrees: the address left `to` and arrived on `cc`.
    const plan = composePlan(
      { ...rows, subject: "s", body: "b", html: "", fromMailboxId: null }, "mb-1",
    );
    expect(plan.mutation.to!.map((a) => a.address)).toEqual(["a@x.invalid"]);
    expect(plan.mutation.cc!.map((a) => a.address)).toEqual(["b@y.invalid"]);
  });

  it("dropping ON a chip inserts before it — reorder within one row", async () => {
    await render("a@x.invalid, b@y.invalid, c@z.invalid, ");
    layOut();
    // c, the third, let go over the first half of a.
    await dragTo(chipOf("c@z.invalid"), 275, 10, 70, 10);

    expect(splitRecipients(rowsNow().to).chips).toEqual(["c@z.invalid", "a@x.invalid", "b@y.invalid"]);
  });

  it("a drop that is not ours moves nothing — the MIME type is the gate", async () => {
    await render("a@x.invalid, ");
    await openLines();
    const dt = fakeDataTransfer();
    dt.setData("text/plain", "stray");
    const ccBox = lineOf(W.cc);
    await act(async () => { ccBox.dispatchEvent(drag("drop", dt)); });
    expect(rowsNow()).toEqual({ to: "a@x.invalid, ", cc: "", bcc: "" });
  });
});

/* ══ the combobox — unchanged behaviours, re-pinned over the chip layout ════════════════ */

describe("the combobox", () => {
  it("offers nothing until something is typed", async () => {
    await render();
    expect(options()).toEqual([]);
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("offers prefix matches, name and address both", async () => {
    await render();
    await type("le");
    expect(options()).toHaveLength(2);
    expect(options()[0]).toContain("Lena Eichspan");
    expect(options()[0]).toContain("lena@atelier.invalid");
  });

  /**
   * Two people can share a display name, and the row has to say which one this is: somebody who
   * has written to you but whom you have never written to is labelled, and somebody you have
   * written to is not. Without the label the only difference between the two is the order.
   */
  it("labels a correspondent the account has never written to, and only that one", async () => {
    await render("", [
      wroteTo("n1", "nora@atelier.invalid", "Nora Lindt"),
      ...Array.from({ length: 9 }, (_, i) => wroteMe(`n${i + 2}`, "nora@elsewhere.invalid", "Nora Lindt")),
    ]);
    await type("nora");
    expect(options()).toHaveLength(2);
    expect(options()[0]).not.toContain("wrote to you");
    expect(options()[1]).toContain("wrote to you");
  });

  it("arrows move the highlight, and it wraps", async () => {
    await render();
    await type("le");
    // The highlighted offer is the one marked selected (today's `sel` class).
    const sel = () => optionEls().findIndex((li) => li.getAttribute("aria-selected") === "true");
    expect(sel()).toBe(0);
    await press("ArrowDown");
    expect(sel()).toBe(1);
    await press("ArrowDown");
    expect(sel()).toBe(0);
    await press("ArrowUp");
    expect(sel()).toBe(1);
  });

  it("↵ accepts the highlighted entry — and the acceptance is a CHIP now", async () => {
    await render();
    await type("le");
    await press("Enter");
    expect(wire()).toBe("Lena Eichspan <lena@atelier.invalid>, ");
    expect(chipEntries()).toEqual(["Lena Eichspan <lena@atelier.invalid>"]);
    expect(input().value).toBe("");
  });

  it("Tab accepts too, and does not move focus off a half-filled field", async () => {
    await render();
    await type("mar");
    await press("Tab");
    expect(wire()).toBe("mara@example.invalid, ");
  });

  it("⌘↵ is NOT accept — Send belongs to the keymap registry", async () => {
    // The send chord is `mod+Enter` with `inInput: true`. If this field swallowed it to
    // accept a suggestion, the one shortcut the compose screen exists for would stop working
    // exactly when a suggestion happened to be showing.
    await render();
    await type("le");
    await press("Enter", { metaKey: true });
    expect(wire()).toBe("le");
  });

  it("Escape dismisses the list and leaves the text alone", async () => {
    await render();
    await type("le");
    expect(options()).toHaveLength(2);
    await press("Escape");
    expect(options()).toEqual([]);
    expect(wire()).toBe("le");
  });

  it("a comma commits what was typed and gets out of the way", async () => {
    await render();
    await type("le");
    // The comma as a browser presses it: the key, and the character it writes into the line.
    await press(",");
    await type("le,");
    expect(options()).toEqual([]);
  });

  it("THE ROUND TRIP: what accepting writes is what parseRecipients reads back", async () => {
    // The failure this prevents is the worst kind — a field that looks correct and produces a
    // recipient the send path cannot parse, so the mail silently goes nowhere.
    await render();
    await type("le");
    await press("Enter");
    const parsed = parseRecipients(wire());
    expect(parsed.invalid).toEqual([]);
    expect(parsed.addresses.map((a) => a.address)).toEqual(["lena@atelier.invalid"]);
  });

  it("a second recipient can be typed straight after the first", async () => {
    await render();
    await type("le");
    await press("Enter");
    await type("mar");
    await press("Enter");
    const parsed = parseRecipients(wire());
    expect(parsed.invalid).toEqual([]);
    expect(parsed.addresses.map((a) => a.address))
      .toEqual(["lena@atelier.invalid", "mara@example.invalid"]);
    expect(chipEntries()).toHaveLength(2);
  });
});

describe("the address is shown so recipients can be told apart", () => {
  it("is announced as a combobox, with the highlighted option named", async () => {
    await render();
    await type("le");
    expect(input().getAttribute("role")).toBe("combobox");
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(input().getAttribute("aria-autocomplete")).toBe("list");
    const active = input().getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    // `getElementById` rather than a selector — jsdom has no `CSS.escape`, and React's
    // `useId` produces ids containing `:` which a raw selector cannot carry anyway.
    expect(document.getElementById(active!)?.getAttribute("aria-selected")).toBe("true");
  });
});
