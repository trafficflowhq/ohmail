/** @vitest-environment jsdom */
/**
 * WHAT A MAIL ROW SAYS TO AN ASSISTIVE TECHNOLOGY.
 *
 * At the 0.16.0 candidate a row was ONE object carrying a joined string: no arrival stamp, no
 * read state, no description, and no selection anywhere in the window — enumerated across the
 * whole tree in a real browser after a press proven by the reading pane, not assumed. Four of
 * the five facts a mail list exists to convey were absent. This file is the row's half of the
 * fix; `apps/webapp/test/row-a11y-shell.test.tsx` drives the same rule through the shipped
 * Ohbox, where the press's effect is a real selection.
 *
 * The NAME is asked through `getAllByRole`, which computes it the way a screen reader does; the
 * DESCRIPTION is read off the attribute here, because the `dom-accessibility-api` this repo
 * resolves (0.5.x, through `@testing-library/dom`) predates `aria-description` and reports every
 * row as having none. Browsers do not: Chromium's own tree, read over the shipped shell through
 * CDP, computes `description` from it. Playwright's computation in WebKit is its own script, not the
 * engine's tree: over AT-SPI the Linux desktop (WebKitGTK) exposed no description at all, so the
 * words also ride an `aria-describedby` node.
 *
 * MUTATION-PROVEN AT AUTHORING TIME (each applied, watched red, restored, `cmp`-verified):
 *   · `chosen` → `false` — the selection cases go red, the naming cases stay green.
 *   · `chosen` → `picked !== undefined ? picked : false` (the cursor dropped) — the
 *     single-select case goes red and the multi-select one stays green.
 *   · the description `said.push(arrived)` arm removed — the stamp case alone goes red.
 *   · the read-state arm removed — the unread/read case alone goes red.
 *   · `tab` → `undefined` — the one-tab-stop case goes red.
 *   · `role="option"` dropped from the button — every case goes red, which is the point: with
 *     no role there is nothing for `aria-selected` to be defined on.
 */
import { afterEach, describe, expect, it } from "vitest";
import { memo, useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ListRows, MessageRow, type MessageRowSpoken } from "@ohmail/ui";

afterEach(cleanup);

const SPOKEN: MessageRowSpoken = { unread: "Unread", read: "Read", attachment: "Has an attachment" };

interface Row {
  id: string;
  from: string;
  subject: string;
  /** What the row SHOWS — relative, and unable to say which Saturday. */
  time: string;
  /** What the row SAYS — the absolute instant, as `rowStamp` mints it. */
  timeSpoken: string;
  unread: boolean;
  hasAttachment?: boolean;
  stateNote?: string;
  protectedLabel?: string;
}

/** Ten rows, spanning the states a list actually holds: read and unread, clips, capsules. */
const ROWS: Row[] = Array.from({ length: 10 }, (_, i) => ({
  id: `m${i}`,
  from: `Sender ${i}`,
  subject: `Subject ${i}`,
  time: i < 3 ? `0${9 + i}:12` : "Tue",
  timeSpoken: `${i < 3 ? "Saturday" : "Tuesday"} 6 September 2026 at 0${9 + (i % 3)}:12`,
  unread: i % 2 === 0,
  hasAttachment: i === 4,
  stateNote: i === 5 ? "Back Tue 09:00" : undefined,
  protectedLabel: i === 6 ? "protected" : undefined,
}));

/**
 * The list, with a cursor and a reading slot — the slot is what makes a press provable. The
 * accessibility tree cannot tell "nothing is selected" from "the selection is not published",
 * so the press below is never judged by the tree: it is judged by the slot naming the message.
 */
function List({ multi = false }: { multi?: boolean }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const open = ROWS.find((r) => r.id === cursor) ?? null;
  return (
    <>
      <ListRows ariaLabel="New" multiSelectable={multi || undefined}>
        {ROWS.map((r) => (
          <MessageRow
            key={r.id}
            id={r.id}
            from={r.from}
            subject={r.subject}
            time={r.time}
            timeSpoken={r.timeSpoken}
            unread={r.unread}
            seen={!r.unread}
            hasAttachment={r.hasAttachment}
            stateNote={r.stateNote}
            protectedLabel={r.protectedLabel}
            spoken={SPOKEN}
            selected={cursor === r.id}
            picked={multi ? picked.has(r.id) : undefined}
            onClick={() => {
              setCursor(r.id);
              if (multi) setPicked(new Set([r.id]));
            }}
          />
        ))}
      </ListRows>
      <p data-testid="reader">{open ? open.subject : ""}</p>
    </>
  );
}

/** The chips this fixture's rows wear after their read state, in the order the row speaks them. */
const describeTail = (r: Row): string =>
  [r.hasAttachment ? SPOKEN.attachment : null, r.protectedLabel ?? null, r.stateNote ?? null]
    .filter((x): x is string => x !== null)
    .map((x) => ` \u00b7 ${x}`)
    .join("");

/**
 * A SHALLOW COMPARATOR, because the row is about to be given one (the windowed list re-renders
 * every mounted row on every apply). The new props must survive it: `timeSpoken` is a string, and
 * `spoken` is ONE object the host memoizes — a `spoken={{…}}` literal at a call site would be a
 * fresh object per render and would defeat any comparator, on every row, for ever.
 */
const shallowEqual = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.is(a[k], b[k]));
};

const options = (c: HTMLElement): HTMLElement[] => [...c.querySelectorAll<HTMLElement>('[role="option"]')];

describe("a mail row states its name, its stamp, its read state and its selection", () => {
  it("gives all ten rows a name and a description carrying the stamp and the read state", () => {
    const { getAllByRole } = render(<List />);
    for (const r of ROWS) {
      const hits = getAllByRole("option", { name: `${r.from}: ${r.subject}` });
      // A count-refusing match: two candidates for one row is a list that cannot be driven.
      expect(hits, `${r.id} is not one object`).toHaveLength(1);
      expect(hits[0]!.getAttribute("aria-description")).toBe(
        `${r.timeSpoken} \u00b7 ${r.unread ? "Unread" : "Read"}${describeTail(r)}`,
      );
    }
  });

  it("names the clip, the capsule and the state note in words, because none of them is text", () => {
    const { getAllByRole } = render(<List />);
    const said = (name: string): string =>
      getAllByRole("option", { name })[0]!.getAttribute("aria-description") ?? "";
    expect(said("Sender 4: Subject 4")).toContain("Has an attachment");
    expect(said("Sender 5: Subject 5")).toContain("Back Tue 09:00");
    expect(said("Sender 6: Subject 6")).toContain("protected");
    // And the rows with none of them say none of them — a description that named a clip on every
    // row would pass the three cases above and mean nothing.
    expect(said("Sender 0: Subject 0")).not.toContain("Has an attachment");
    expect(said("Sender 0: Subject 0")).not.toContain("protected");
  });

  it("is inside a named listbox, which is what makes aria-selected mean anything", () => {
    const { getByRole } = render(<List />);
    const box = getByRole("listbox", { name: "New" });
    expect(box.querySelectorAll('[role="option"]')).toHaveLength(10);
    expect(box.getAttribute("aria-multiselectable")).toBeNull();
  });

  it("publishes the cursor as the selection, and the press is proven by the reading slot", () => {
    const { container, getAllByRole, getByTestId } = render(<List />);
    expect(options(container).filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(0);
    expect(getByTestId("reader").textContent).toBe("");

    const hits = getAllByRole("option", { name: "Sender 3: Subject 3" });
    expect(hits, "the press refuses on anything but exactly one candidate").toHaveLength(1);
    fireEvent.click(hits[0]!);

    // THE EFFECT ONLY A REAL SELECTION PRODUCES — the slot names that message.
    expect(getByTestId("reader").textContent).toBe("Subject 3");
    const chosen = options(container).filter((o) => o.getAttribute("aria-selected") === "true");
    expect(chosen).toHaveLength(1);
    expect(chosen[0]!.getAttribute("aria-label")).toBe("Sender 3: Subject 3");
  });

  it("carries exactly one tab stop, and it is the cursor's row", () => {
    const { container, getAllByRole } = render(<List />);
    const stops = () => options(container).filter((o) => o.getAttribute("tabindex") === "0");
    expect(stops()).toHaveLength(0);
    fireEvent.click(getAllByRole("option", { name: "Sender 7: Subject 7" })[0]!);
    expect(stops()).toHaveLength(1);
    expect(stops()[0]!.getAttribute("aria-label")).toBe("Sender 7: Subject 7");
    expect(options(container).filter((o) => o.getAttribute("tabindex") === "-1")).toHaveLength(9);
  });

  it("lets multi-select membership outrank the cursor, which is what a multiselectable listbox means", () => {
    const { container, getAllByRole, getByRole } = render(<List multi />);
    expect(getByRole("listbox", { name: "New" }).getAttribute("aria-multiselectable")).toBe("true");
    fireEvent.click(getAllByRole("option", { name: "Sender 2: Subject 2" })[0]!);
    const chosen = options(container).filter((o) => o.getAttribute("aria-selected") === "true");
    expect(chosen).toHaveLength(1);
    expect(chosen[0]!.getAttribute("aria-label")).toBe("Sender 2: Subject 2");
  });

  it("carries its description through aria-describedby too, which WebKitGTK's AT-SPI exposes and aria-description is not", () => {
    const { container, getAllByRole } = render(<List />);
    const row = container.querySelector<HTMLElement>('[role="option"][aria-label="Sender 0: Subject 0"]')!;
    // The referenced node's label is what the tree computes the description from.
    const said = document.getElementById(row.getAttribute("aria-describedby") ?? "")?.getAttribute("aria-label");
    expect(said).toBe(row.getAttribute("aria-description"));
    expect(said).toContain("Unread");
    // Hidden from sight and from the tree on its own; the row's name is unchanged.
    const node = document.getElementById(row.getAttribute("aria-describedby")!)!;
    expect(node.hidden).toBe(true);
    expect(node.textContent).toBe("");
    expect(getAllByRole("option", { name: "Sender 0: Subject 0" })).toEqual([row]);
    // Two rows, two references: a list never names one row's facts for another.
    const other = container.querySelector<HTMLElement>('[role="option"][aria-label="Sender 1: Subject 1"]')!;
    expect(other.getAttribute("aria-describedby")).not.toBe(row.getAttribute("aria-describedby"));
  });

  it("keeps every new prop comparable, so a shallow row memo still skips an unrelated render", () => {
    let renders = 0;
    function Counted(props: Parameters<typeof MessageRow>[0]) {
      renders += 1;
      return <MessageRow {...props} />;
    }
    const Memo = memo(Counted, (a, b) => shallowEqual(a, b));
    const props = {
      id: "m0", from: "Ada", subject: "Kiln", time: "09:12",
      timeSpoken: "Saturday 6 September 2026 at 09:12",
      unread: true, spoken: SPOKEN, selected: false,
    };
    function Host({ tick }: { tick: number }) {
      // `tick` is the unrelated publish: the list re-renders, the row's own facts do not move.
      return <ListRows ariaLabel={`New ${tick > 99 ? tick : ""}`.trim()}><Memo {...props} /></ListRows>;
    }
    const { rerender } = render(<Host tick={1} />);
    expect(renders).toBe(1);
    rerender(<Host tick={2} />);
    expect(renders, "the row re-rendered on a publish that touched none of its facts").toBe(1);

    // The negative control: the SAME words in a fresh object defeat the comparator every time.
    rerender(<Host tick={3} />);
    expect(renders).toBe(1);
    const fresh = { ...props, spoken: { ...SPOKEN } };
    rerender(<ListRows ariaLabel="New"><Memo {...fresh} /></ListRows>);
    expect(renders).toBe(2);
  });
});
