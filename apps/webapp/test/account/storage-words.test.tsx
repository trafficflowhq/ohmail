/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { ThemeProvider } from "@ohmail/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactorSlot } from "@ohmail/app/account";
import { StoragePane, useStorage } from "../../../../packages/app/src/account/storage/index.js";
import { storageFactsOf } from "../../app/shell/storage-state";
import { published, serve, Words, type Server } from "./storage-harness";
import { BLOCKS, open, ROSTER } from "./storage-fixtures";

/**
 * THE SAME WORDS AS THE SHIPPED SHARED PANE (`app/shell/StoragePane.tsx`) on every form of the storage block: what the
 * new pane says over the web's filling is what the shipped pane said over the same block, word for word and figure
 * for figure, in English and in German, where the build links out and where it may not. Three things the shipped
 * pane draws are not compared here, each for its reason: the section's name (the column's head says it now), the bar
 * (a picture, hidden from the reader in the shipped pane, waiting for the kit's part), and the table's shape (held
 * row by row below, each figure named by its column).
 */

let roster: unknown[] | null = ROSTER;
vi.mock("@ohmail/app-logic/mail-state/mail-state-binding", () => ({ useMailboxFacts: () => roster }));

let server: Server;
let access: Record<string, unknown> = {};
beforeEach(() => {
  roster = ROSTER;
  server = serve(() => access);
});
afterEach(() => {
  cleanup();
  server.restore();
});

const still = () => {};
const NO_FACTOR: FactorSlot = () => null;
/** The words of what is drawn, figures and all; what separates them (emphasis, a line break) moves no word. */
const wordsOf = (nodes: readonly string[]) =>
  nodes
    .join(" ")
    .split(/[^\p{L}\p{N}%]+/u)
    .filter(Boolean);
function textNodes(root: Node, skip: (el: Element) => boolean): string[] {
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) out.push(node.textContent ?? "");
    if (node.nodeType === Node.ELEMENT_NODE && skip(node as Element)) return;
    node.childNodes.forEach(walk);
  };
  walk(root);
  return out;
}
const counted = (words: readonly string[]) => {
  const seen = new Map<string, number>();
  for (const word of words) seen.set(word, (seen.get(word) ?? 0) + 1);
  return seen;
};

/** The shipped shared pane over the block, as the browser (links out) or a store's build (may not) drew it. */
async function shipped(raw: Record<string, unknown>, linksOut: boolean, lang: "en" | "de") {
  const { StoragePane: Shipped } = await import("../../app/shell/StoragePane");
  const facts = storageFactsOf(raw)!;
  const { container } = render(
    <Words lang={lang}>
      <ThemeProvider>
        <Shipped
          facts={facts}
          linksOut={linksOut}
          change={linksOut ? { press: still, busy: false, note: null } : null}
          mail={{ on: facts.mail, busy: false, failed: false, onChange: still }}
        />
      </ThemeProvider>
    </Words>,
  );
  const hidden = (el: Element) => el.getAttribute("aria-hidden") === "true";
  const title = container.querySelector("h2");
  const table = container.querySelector("table");
  const said = {
    outside: wordsOf(textNodes(container, (el) => hidden(el) || el === title || el === table)),
    all: wordsOf(textNodes(container, (el) => hidden(el) || el === title)),
    heads: [...container.querySelectorAll("thead th")].map((th) => th.textContent ?? ""),
    rows: [...container.querySelectorAll("tbody tr, tfoot tr")].map((tr) =>
      [...tr.querySelectorAll("td")].map((td) => td.textContent ?? ""),
    ),
  };
  cleanup();
  return said;
}

/** The new pane over the web's real filling, the block published to the tab's feed as the shell's read would. */
async function anew(raw: Record<string, unknown>, body: "pane" | "facts", lang: "en" | "de") {
  const { useStorageDoor } = await import("../../app/(product)/mailbox/storage-door");
  function Body() {
    return <StoragePane model={useStorage(useStorageDoor(null))} body={body} factor={NO_FACTOR} />;
  }
  access = open(raw);
  await published();
  const { container } = render(
    <Words lang={lang}>
      <Body />
    </Words>,
  );
  const said = {
    words: wordsOf(textNodes(container, () => false)),
    lines: screen.queryAllByRole("group").map((g) => g.textContent ?? ""),
  };
  cleanup();
  return said;
}

describe("the new pane says what the shipped shared pane said", () => {
  for (const [name, raw] of Object.entries(BLOCKS)) {
    for (const lang of ["en", "de"] as const) {
      for (const linksOut of [true, false]) {
        it(`${name}, ${lang}, ${linksOut ? "where the build links out" : "where it may not"}`, async () => {
          const old = await shipped(raw, linksOut, lang);
          const now = await anew(raw, linksOut ? "pane" : "facts", lang);
          // Every word the shipped pane said outside its picture and its table, as often as it said it.
          const have = counted(now.words);
          expect([...counted(old.outside)].filter(([word, n]) => (have.get(word) ?? 0) < n)).toEqual([]);
          // No word of its own: whatever the new pane says, the shipped pane said somewhere.
          const known = new Set(old.all);
          expect([...new Set(now.words)].filter((word) => !known.has(word))).toEqual([]);
          // The table, row by row: the mailbox (or the total), then each of its figures named by its column.
          const columns = old.heads.slice(1);
          for (const [first, ...figures] of old.rows) {
            const at = now.lines.indexOf(first!);
            expect(at, `${first} has its line`).toBeGreaterThanOrEqual(0);
            expect(now.lines.slice(at + 1, at + 1 + figures.length)).toEqual(
              figures.map((figure, i) => `${columns[i]}${figure}`),
            );
          }
        });
      }
    }
  }

  it("holds the comparison to something: the fixtures draw a table, the plans and the change", async () => {
    const old = await shipped(BLOCKS.near!, true, "en");
    expect(old.rows.length).toBe(3);
    expect(old.outside.length).toBeGreaterThan(100);
  });
});
