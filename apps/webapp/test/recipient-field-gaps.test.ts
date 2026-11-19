/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { AddressBookEntry } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { RecipientField, addressLabels, truncateAddress, ADDRESS_MAX } from "../app/shell/RecipientField";

/*
 * MOVED AS THEY STOOD (share write-1 of the older tests' sorting, 18 November): the cases of
 * `recipient-field.test.ts` that Write's people lines do not hold yet, each a GAP with its owner
 * (`tools/old-tests.tsv`): leaving the line finishes the typed entry; an IDN address shown decoded on its chip;
 * the chips announced as a listbox; the line reporting its focus to its form; a long address middle-truncated so
 * two recipients never read the same; the demo's drafted letter seeding its recipients as chips. Word for word
 * over today's `RecipientField` (and today's composer's source), so the file they came from runs over Write's
 * own lines alone. When one is built, its case is re-pointed over Write and its row turns KEPT.
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

describe("a field seeded from stored addresses is ALL chips — CMP-F3", () => {
  /** A file under `apps/webapp`, from the app dir or the repo root — the root run is what CI does. */
  const readSource = (rel: string): string => {
    try {
      return readFileSync(resolve(process.cwd(), `apps/webapp/${rel}`), "utf8");
    } catch {
      return readFileSync(resolve(process.cwd(), rel), "utf8");
    }
  };

  /*
   * Split word for word out of "every address-seeding surface goes through formatRecipientChips" (whose other
   * surfaces are read over Write's sources in `recipient-field.test.ts`): today's composer's drafted letter
   * (`ComposeView.takeDraft`, the demo's `draft-compose` row) has no surface in Write.
   */
  it("every address-seeding surface goes through formatRecipientChips: an accepted AI draft", () => {
    const view = readSource("app/views/ComposeView.tsx");
    expect(view, "an accepted AI draft seeds To without the chips form")
      .toMatch(/to: fields\.to \|\| formatRecipientChips\(draft\.to\)/);
  });
});

describe("chips: every settled recipient is one", () => {
  it("blur commits the tail — leaving the field finishes the entry", async () => {
    await render();
    await type("nadia@parc.invalid");
    // `focusout`, not a hand-built `blur`: React 18 delegates onBlur through focusout, so a
    // synthetic `blur` event never reaches the handler (the same note as the focus test).
    await act(async () => { input().dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(chipEntries()).toEqual(["nadia@parc.invalid"]);
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

describe("keyboard: chips are reachable, removable and movable without a mouse", () => {
  it("is announced: the chips ride a listbox, each one an option with its name", async () => {
    await render("a@x.invalid, ");
    const list = host.querySelector(".rcp-chips")!;
    expect(list.getAttribute("role")).toBe("listbox");
    const chip = chips()[0]!;
    expect(chip.getAttribute("role")).toBe("option");
    expect(chip.getAttribute("aria-label")).toContain("a@x.invalid");
  });
});

describe("the combobox", () => {
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
});
