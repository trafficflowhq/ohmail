/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { addressBook, type AddressBookEntry } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import {
  RecipientField,
  RECIPIENT_DRAG_TYPE,
  addressLabels,
  joinRecipients,
  moveRecipient,
  splitRecipients,
  truncateAddress,
  ADDRESS_MAX,
  type RecipientMove,
  type RecipientRow,
} from "../app/shell/RecipientField";
import { composePlan, parseRecipients } from "@ohmail/app-logic/writing/compose";
import { formatRecipientChips } from "../app/shell/compose-from";

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
 */
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOOK: AddressBookEntry[] = [
  { address: "lena@atelier.invalid", name: "Lena Eichspan", count: 9, lastAt: Date.now(), evidence: "we_wrote" },
  { address: "leon@example.invalid", name: "Leon Frei", count: 4, lastAt: Date.now(), evidence: "we_wrote" },
  { address: "mara@example.invalid", name: "", count: 2, lastAt: Date.now(), evidence: "they_wrote" },
];

let host: HTMLDivElement;
let root: Root | null = null;
let value = "";

async function render(initial = "", book: readonly AddressBookEntry[] = BOOK): Promise<void> {
  value = initial;
  const Harness = (): React.ReactElement => {
    const [v, setV] = React.useState(initial);
    value = v;
    return h(RecipientField, { id: "to", value: v, onChange: setV, book });
  };
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-04T12:00:00.000Z"),
        children: h(Harness),
      }),
    );
  });
}

const input = (): HTMLInputElement => host.querySelector<HTMLInputElement>("#to")!;
const options = (): string[] =>
  [...host.querySelectorAll(".rcp-opt")].map((li) => li.textContent ?? "");
const chips = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(".rcp-chip")];
const chipEntries = (): string[] => chips().map((c) => c.dataset.entry ?? "");

/** Type into the tail input — the input holds ONLY the entry being typed. */
async function type(text: string, el: HTMLInputElement = input()): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, text);
    el.setSelectionRange(text.length, text.length);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(key: string, opts: KeyboardEventInit = {}, el: HTMLElement = input()): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  host.remove();
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
    await render(formatRecipientChips([
      { name: null, address: "a@x.invalid" },
      { name: null, address: "b@y.invalid" },
    ]));
    expect(chipEntries()).toEqual(["a@x.invalid", "b@y.invalid"]);
    expect(input().value, "the last recipient is sitting in the input as text").toBe("");
  });

  /**
   * THE SEAMS, STRUCTURALLY — a helper that is right and unused leaves the defect exactly as
   * it was. Every surface that seeds a recipient field from stored ADDRESSES goes through it:
   * a reopened draft and the contact popover's Write (`shell-compose.ts`), an accepted AI draft
   * (`ComposeView.takeDraft`), and the reply head opening for edit (`InlineReply.expand`).
   */
  it("every address-seeding surface goes through formatRecipientChips", () => {
    const shell = readSource("app/shell/shell-compose.ts");
    expect(shell, "openDraft seeds To without the chips form — the last recipient un-chips")
      .toMatch(/to: formatRecipientChips\(d\.to\)/);
    expect(shell).toMatch(/cc: formatRecipientChips\(d\.cc\)/);
    expect(shell).toMatch(/bcc: formatRecipientChips\(d\.bcc\)/);

    const view = readSource("app/views/ComposeView.tsx");
    expect(view, "an accepted AI draft seeds To without the chips form")
      .toMatch(/to: fields\.to \|\| formatRecipientChips\(draft\.to\)/);

    const reply = readSource("app/shell/InlineReply.tsx");
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
  const reader = {
    get: () => undefined,
    list: (type: string): unknown[] =>
      type === "message"
        ? [
            {
              id: "m1", folder: "INBOX", date: at(3), to: [], cc: [],
              from: who("andi@bergerweb.invalid", "Andreas Ingold"),
            },
            {
              id: "m2", folder: "INBOX", date: at(1), cc: [],
              from: who("buero@bootsvermietung.invalid", "Bootsvermietung Enge"),
              // The company's client exporting ITS name for him into a To header.
              to: [who("andi@bergerweb.invalid", "Bootsvermietung Enge GmbH - Andreas Ingold")],
            },
          ]
        : [],
    entries: () => [],
  } as unknown as Parameters<typeof addressBook>[0];

  it("accepting a suggestion chips the sender's OWN name beside their address", async () => {
    const book = addressBook(reader);
    await render("", book);
    await type("andi");
    expect(options().join(" | ")).toContain("andi@bergerweb.invalid");
    await press("Enter");

    const chip = chips()[0];
    expect(chip?.querySelector("b")?.textContent,
      "the chip names somebody other than the person at this address")
      .toBe("Andreas Ingold");
    expect(chip?.querySelector(".rcp-chip-addr")?.textContent).toBe("andi@bergerweb.invalid");

    // …and the same name is what leaves the account: the chip is a rendering of the value, and
    // the value is what `composePlan` builds the To header from.
    const parsed = parseRecipients(value);
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
    await render("", [
      { address: "andi@bergerweb.invalid", name: "Ingold, Andreas", count: 4, lastAt: Date.now(), evidence: "we_wrote" },
    ]);
    await type("andi");
    await press("Enter");

    expect(chipEntries(), "the accepted suggestion tore into two chips")
      .toEqual(["andi@bergerweb.invalid"]);
    const parsed = parseRecipients(value);
    expect(parsed.invalid, "half a display name is being offered to SMTP as an address")
      .toEqual([]);
    expect(parsed.addresses).toEqual([{ name: null, address: "andi@bergerweb.invalid" }]);
    // The send is the thing that was broken: one invalid entry empties the whole envelope.
    const plan = composePlan(
      { to: value, cc: "", bcc: "", subject: "s", body: "b", html: "", fromMailboxId: null },
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
    expect(parseRecipients(value).addresses.map((a) => a.address)).toEqual(["nadia@parc.invalid"]);
  });

  it("a comma commits too, exactly as it always did", async () => {
    await render();
    await type("nadia@parc.invalid,");
    expect(chipEntries()).toEqual(["nadia@parc.invalid"]);
    expect(input().value).toBe("");
  });

  it("blur commits the tail — leaving the field finishes the entry", async () => {
    await render();
    await type("nadia@parc.invalid");
    // `focusout`, not a hand-built `blur`: React 18 delegates onBlur through focusout, so a
    // synthetic `blur` event never reaches the handler (the same note as the focus test).
    await act(async () => { input().dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(chipEntries()).toEqual(["nadia@parc.invalid"]);
  });

  it("the × removes exactly that chip, and the ENVELOPE loses it", async () => {
    await render("a@x.invalid, b@y.invalid, c@z.invalid, ");
    expect(chipEntries()).toHaveLength(3);
    const before = parseRecipients(value).addresses.map((a) => a.address);
    expect(before).toContain("b@y.invalid");

    const x = chips()[1]!.querySelector<HTMLElement>(".rcp-chip-x")!;
    await act(async () => { x.click(); });

    expect(chipEntries()).toEqual(["a@x.invalid", "c@z.invalid"]);
    // The removal reached the string the envelope is built from — remove must mutate the
    // wire, or the mail still goes to the person who was just deleted from the screen.
    expect(parseRecipients(value).addresses.map((a) => a.address))
      .toEqual(["a@x.invalid", "c@z.invalid"]);
  });

  it("Backspace on an EMPTY input removes the last chip", async () => {
    await render("a@x.invalid, b@y.invalid, ");
    await press("Backspace");
    expect(chipEntries()).toEqual(["a@x.invalid"]);
    expect(parseRecipients(value).addresses.map((a) => a.address)).toEqual(["a@x.invalid"]);
  });

  it("Backspace with text in the input edits the TEXT — chips are not collateral", async () => {
    await render("a@x.invalid, ma");
    await press("Backspace");
    // The browser owns the text edit; the guard is that no chip was taken.
    expect(chipEntries()).toEqual(["a@x.invalid"]);
  });

  it("pasting a list splits into chips — commas, semicolons and newlines all separate", async () => {
    await render();
    const el = input();
    await act(async () => {
      const e = new Event("paste", { bubbles: true, cancelable: true });
      Object.assign(e, {
        clipboardData: { getData: () => "a@x.invalid, Lena <l@y.invalid>; c@z.invalid\nd@w.invalid" },
      });
      el.dispatchEvent(e);
    });
    expect(chipEntries()).toEqual([
      "a@x.invalid", "Lena <l@y.invalid>", "c@z.invalid", "d@w.invalid",
    ]);
    const parsed = parseRecipients(value);
    expect(parsed.invalid).toEqual([]);
    expect(parsed.addresses).toHaveLength(4);
  });

  it("an entry that does not parse is a chip too — styled as the error idiom, kept verbatim", async () => {
    await render("nope, a@x.invalid, ");
    const [bad, good] = chips();
    expect(bad!.classList.contains("bad")).toBe(true);
    expect(bad!.dataset.entry).toBe("nope");
    expect(good!.classList.contains("bad")).toBe(false);
    // The bad entry still blocks the send — composePlan's rule is untouched by the rendering.
    const plan = composePlan(
      { to: value, cc: "", bcc: "", subject: "s", body: "b", html: "", fromMailboxId: null }, "mb-1",
    );
    expect(plan.invalid).toEqual(["nope"]);
    expect(plan.mutation.to).toEqual([]);
  });

  it("shows the DISPLAY-DECODED address on the chip face and keeps the wire form underneath", async () => {
    // The IDN rule: decode for SHOW, never for the value. `xn--bcher-kva.example` reads
    // `bücher.example`; the entry — what travels on drag, into the string, onto the wire — stays
    // the stored A-label byte-for-byte.
    await render("nora@xn--bcher-kva.example, ");
    const chip = chips()[0]!;
    expect(chip.textContent).toContain("nora@bücher.example");
    expect(chip.dataset.entry).toBe("nora@xn--bcher-kva.example");
    expect(value).toContain("xn--bcher-kva.example");
    expect(value).not.toContain("bücher");
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

  it("Alt+arrows hand the chip to onMove — the keyboard drag", async () => {
    const moves: RecipientMove[] = [];
    await act(async () => {
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-04T12:00:00.000Z"),
          children: h(RecipientField, {
            id: "to", value: "a@x.invalid, b@y.invalid, ", onChange: () => {}, book: BOOK,
            row: "to" as RecipientRow, onMove: (m: RecipientMove) => moves.push(m),
          }),
        }),
      );
    });
    const chip = host.querySelectorAll<HTMLElement>(".rcp-chip")[0]!;
    await press("ArrowRight", { altKey: true }, chip);
    expect(moves.pop()).toEqual({ entry: "a@x.invalid", from: "to", to: "to", before: 2 });
    await press("ArrowDown", { altKey: true }, chip);
    expect(moves.pop()).toEqual({ entry: "a@x.invalid", from: "to", to: "cc", before: null });
    // The first row has no row above it — Alt+↑ on To moves nothing rather than wrapping.
    await press("ArrowUp", { altKey: true }, chip);
    expect(moves).toHaveLength(0);
  });

  it("is announced: the chips ride a listbox, each one an option with its name", async () => {
    await render("a@x.invalid, ");
    const list = host.querySelector(".rcp-chips")!;
    expect(list.getAttribute("role")).toBe("listbox");
    const chip = chips()[0]!;
    expect(chip.getAttribute("role")).toBe("option");
    expect(chip.getAttribute("aria-label")).toContain("a@x.invalid");
  });
});

/* ══ drag and drop between rows ═════════════════════════════════════════════════════════ */

describe("drag: a chip carries its wire entry between rows", () => {
  /** Two rows sharing one state object, moves applied whole — `ComposeView.moveChip`'s shape. */
  let rows = { to: "", cc: "", bcc: "" };
  async function renderRows(initial: { to: string; cc: string; bcc: string }): Promise<void> {
    rows = initial;
    const Harness = (): React.ReactElement => {
      const [v, setV] = React.useState(initial);
      rows = v;
      const onMove = (m: RecipientMove): void => {
        const next = moveRecipient(v, m);
        if (next) setV(next);
      };
      return h(
        "div",
        null,
        h(RecipientField, {
          id: "to", value: v.to, onChange: (to: string) => setV({ ...v, to }), book: [],
          row: "to" as RecipientRow, onMove,
        }),
        h(RecipientField, {
          id: "cc", value: v.cc, onChange: (cc: string) => setV({ ...v, cc }), book: [],
          row: "cc" as RecipientRow, onMove,
        }),
      );
    };
    await act(async () => {
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-04T12:00:00.000Z"),
          children: h(Harness),
        }),
      );
    });
  }

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

  it("dragstart writes the entry and source row; drop on the other row moves it on the WIRE", async () => {
    await renderRows({ to: "a@x.invalid, b@y.invalid, ", cc: "", bcc: "" });
    const dt = fakeDataTransfer();
    const chip = host.querySelectorAll<HTMLElement>("#to")[0]!
      .closest(".rcp-box")!.querySelectorAll<HTMLElement>(".rcp-chip")[1]!;

    await act(async () => { chip.dispatchEvent(drag("dragstart", dt)); });
    expect(JSON.parse(dt.getData(RECIPIENT_DRAG_TYPE))).toEqual({
      entry: "b@y.invalid", row: "to",
    });

    const ccBox = host.querySelector("#cc")!.closest(".rcp-box")!;
    await act(async () => { ccBox.dispatchEvent(drag("dragover", dt)); });
    await act(async () => { ccBox.dispatchEvent(drag("drop", dt)); });

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
    await renderRows({ to: "a@x.invalid, b@y.invalid, c@z.invalid, ", cc: "", bcc: "" });
    const dt = fakeDataTransfer();
    const toChips = (): HTMLElement[] =>
      [...host.querySelector("#to")!.closest(".rcp-box")!.querySelectorAll<HTMLElement>(".rcp-chip")];

    await act(async () => { toChips()[2]!.dispatchEvent(drag("dragstart", dt)); });
    await act(async () => { toChips()[0]!.dispatchEvent(drag("dragover", dt)); });
    await act(async () => { toChips()[0]!.dispatchEvent(drag("drop", dt)); });

    expect(splitRecipients(rows.to).chips).toEqual(["c@z.invalid", "a@x.invalid", "b@y.invalid"]);
  });

  it("a drop that is not ours moves nothing — the MIME type is the gate", async () => {
    await renderRows({ to: "a@x.invalid, ", cc: "", bcc: "" });
    const dt = fakeDataTransfer();
    dt.setData("text/plain", "stray");
    const ccBox = host.querySelector("#cc")!.closest(".rcp-box")!;
    await act(async () => { ccBox.dispatchEvent(drag("drop", dt)); });
    expect(rows).toEqual({ to: "a@x.invalid, ", cc: "", bcc: "" });
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
      { address: "nora@atelier.invalid", name: "Nora Lindt", count: 2, lastAt: Date.now(), evidence: "we_wrote" },
      { address: "nora@elsewhere.invalid", name: "Nora Lindt", count: 9, lastAt: Date.now(), evidence: "they_wrote" },
    ]);
    await type("nora");
    expect(options()).toHaveLength(2);
    expect(options()[0]).not.toContain("wrote to you");
    expect(options()[1]).toContain("wrote to you");
  });

  it("arrows move the highlight, and it wraps", async () => {
    await render();
    await type("le");
    const sel = () => [...host.querySelectorAll(".rcp-opt")].findIndex((li) => li.classList.contains("sel"));
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
    expect(value).toBe("Lena Eichspan <lena@atelier.invalid>, ");
    expect(chipEntries()).toEqual(["Lena Eichspan <lena@atelier.invalid>"]);
    expect(input().value).toBe("");
  });

  it("Tab accepts too, and does not move focus off a half-filled field", async () => {
    await render();
    await type("mar");
    await press("Tab");
    expect(value).toBe("mara@example.invalid, ");
  });

  it("⌘↵ is NOT accept — Send belongs to the keymap registry", async () => {
    // The send chord is `mod+Enter` with `inInput: true`. If this field swallowed it to
    // accept a suggestion, the one shortcut the compose screen exists for would stop working
    // exactly when a suggestion happened to be showing.
    await render();
    await type("le");
    await press("Enter", { metaKey: true });
    expect(value).toBe("le");
  });

  it("Escape dismisses the list and leaves the text alone", async () => {
    await render();
    await type("le");
    expect(options()).toHaveLength(2);
    await press("Escape");
    expect(options()).toEqual([]);
    expect(value).toBe("le");
  });

  it("a comma commits what was typed and gets out of the way", async () => {
    await render();
    await type("le");
    await press(",");
    expect(options()).toEqual([]);
  });

  it("THE ROUND TRIP: what accepting writes is what parseRecipients reads back", async () => {
    // The failure this prevents is the worst kind — a field that looks correct and produces a
    // recipient the send path cannot parse, so the mail silently goes nowhere.
    await render();
    await type("le");
    await press("Enter");
    const parsed = parseRecipients(value);
    expect(parsed.invalid).toEqual([]);
    expect(parsed.addresses.map((a) => a.address)).toEqual(["lena@atelier.invalid"]);
  });

  it("a second recipient can be typed straight after the first", async () => {
    await render();
    await type("le");
    await press("Enter");
    await type("mar");
    await press("Enter");
    const parsed = parseRecipients(value);
    expect(parsed.invalid).toEqual([]);
    expect(parsed.addresses.map((a) => a.address))
      .toEqual(["lena@atelier.invalid", "mara@example.invalid"]);
    expect(chipEntries()).toHaveLength(2);
  });

  it("reports focus, so the form can hold back the error for a half-typed entry", async () => {
    // The live symptom: typing "no" showed a red "Not an address" bar WHILE the suggestion
    // popover for that same prefix was open above it — the field calling the user wrong and
    // offering them four ways to be right, about the same two letters, at once.
    // `ComposeView` owns the gate; this is the signal it needs.
    const seen: boolean[] = [];
    await act(async () => {
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-04T12:00:00.000Z"),
          children: h(RecipientField, {
            id: "to", value: "", onChange: () => {}, book: BOOK,
            onFocusChange: (f: boolean) => seen.push(f),
          }),
        }),
      );
    });
    // `.focus()` and not a synthetic FocusEvent: React listens for `focusin` via delegation,
    // so a hand-built `focus` event never reaches the handler.
    await act(async () => { input().focus(); });
    expect(seen).toEqual([true]);
  });

  it("renders the address with its domain in a span that CSS can protect", async () => {
    await render();
    await type("le");
    // The domain rides in its own node so it can be refused shrink-space; the local part is the
    // one that gives way. Both together still read back as the whole address.
    const first = host.querySelector(".rcp-opt")!;
    expect(first.querySelector(".rcp-domain")?.textContent).toBe("@atelier.invalid");
    expect(first.querySelector(".rcp-addr")?.textContent).toBe("lena@atelier.invalid");
  });
});

describe("the address is shown so recipients can be told apart", () => {
  it("leaves a short address alone", () => {
    expect(truncateAddress("lena@atelier.invalid")).toBe("lena@atelier.invalid");
  });

  it("middle-truncates the local part and keeps the whole domain", () => {
    const label = truncateAddress("verylonglocalpartthatexceeds@company.example.com");
    // The domain is the part that tells a work address from a personal one — it is never dropped.
    expect(label.endsWith("@company.example.com")).toBe(true);
    // …and the cut is in the MIDDLE of the local part, not at the end where the browser would put it.
    expect(label).toContain("…");
    expect(label.startsWith("very")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(ADDRESS_MAX + 1);
  });

  it("never shows two different addresses as the same string", () => {
    // Same domain, same local head and tail, differing only in a middle that a lone truncation
    // would drop — so on their own they collapse to one string. In a mail client that is a
    // wrong-recipient risk, so the list must widen them until they are distinct.
    const a = "abcdefghijXXXXXklmnopqrst@example.com";
    const b = "abcdefghijYYYYYklmnopqrst@example.com";
    expect(truncateAddress(a), "the premise: alone, these collide")
      .toBe(truncateAddress(b));

    const labels = addressLabels([a, b]);
    expect(new Set(labels).size, "two recipients rendered as one string").toBe(2);
    expect(labels).toContain(a);
    expect(labels).toContain(b);
  });

  it("keeps addresses on different domains distinct, domains intact", () => {
    const labels = addressLabels([
      "jordan.the.very.long.name@work.example.org",
      "jordan.the.very.long.name@home.example.org",
    ]);
    expect(new Set(labels).size).toBe(2);
    expect(labels[0]!.endsWith("@work.example.org")).toBe(true);
    expect(labels[1]!.endsWith("@home.example.org")).toBe(true);
  });

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
