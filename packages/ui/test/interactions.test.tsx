/** @vitest-environment jsdom */
/**
 * Interaction contracts: SplitButton's two segments, SegmentedControl
 * switching, Toast's fire-once action, StreamCard expand/collapse,
 * ThemeProvider's data-theme stamping.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  MessageRow,
  SegmentedControl,
  SplitButton,
  StreamCard,
  ThemeProvider,
  ToastHost,
  useTheme,
  useToast,
} from "@ohmail/ui";
import { reads } from "@ohmail/fixtures";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

describe("SplitButton", () => {
  it("fires distinct handlers per segment", () => {
    const onPress = vi.fn();
    const onCheckPress = vi.fn();
    const { getByText, getByLabelText } = render(
      <SplitButton
        label="Reads"
        onPress={onPress}
        check={{ onPress: onCheckPress, label: "Reads, mark read" }}
      />,
    );
    fireEvent.click(getByText("Reads"));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onCheckPress).not.toHaveBeenCalled();

    fireEvent.click(getByLabelText("Reads, mark read"));
    expect(onCheckPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("marks the AI-preselected destination", () => {
    const { container } = render(
      <SplitButton label="Ohbox" ai kbdHint="y" onPress={() => {}} check={{ onPress: () => {}, label: "Ohbox, mark read" }} />,
    );
    expect(container.querySelector(".dbtn.ai")).not.toBeNull();
    expect(container.querySelector("kbd")?.textContent).toBe("y");
  });

  it("renders NO ✓ half when `check` is omitted — a single-decision capsule", () => {
    // The demoting destinations (Screen out, Spam) file but carry no read verb, so they pass
    // no `check` and the ✓ button must not exist — not merely be hidden, which would leave a
    // focusable, screen-reader-announced control in the tree.
    const onPress = vi.fn();
    const { container } = render(<SplitButton label="Screen out" quiet onPress={onPress} />);
    expect(container.querySelector(".d-read")).toBeNull();
    expect(container.querySelectorAll(".dbtn button")).toHaveLength(1);
    fireEvent.click(container.querySelector(".d-main")!);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("SegmentedControl", () => {
  const options = [
    { id: "waiting", label: "Waiting", count: 3 },
    { id: "screened", label: "Screened out", count: 2 },
    { id: "spam", label: "Spam", count: 2 },
  ];

  it("switches segments and renders counts", () => {
    const onChange = vi.fn();
    const { getByRole, getAllByText } = render(
      <SegmentedControl
        ariaLabel="Screener sections"
        role="tablist"
        value="waiting"
        onChange={onChange}
        options={options}
      />,
    );
    const waitingTab = getByRole("tab", { selected: true });
    expect(waitingTab.textContent).toContain("Waiting");
    expect(waitingTab.textContent).toContain("3");
    expect(getAllByText("2")).toHaveLength(2);

    fireEvent.click(getByRole("tab", { name: /Spam/ }));
    expect(onChange).toHaveBeenCalledWith("spam");
  });
});

describe("Toast", () => {
  function Harness({ onAction }: { onAction: () => void }) {
    const toast = useToast();
    return (
      <button
        onClick={() => toast("Reads — filed.", { action: "Undo", onAction, duration: 6000 })}
      >
        decide
      </button>
    );
  }

  it("shows the message and fires the action exactly once", () => {
    const onAction = vi.fn();
    const { getByText, getAllByRole } = render(
      <ToastHost>
        <Harness onAction={onAction} />
      </ToastHost>,
    );
    fireEvent.click(getByText("decide"));
    // The first of the host's two live regions is the Undo slot (`toast-two-slots.test.tsx`).
    const status = getAllByRole("status")[0]!;
    expect(status.className).toContain("on");
    expect(status.textContent).toContain("Reads — filed.");

    const undo = getByText("Undo");
    fireEvent.click(undo);
    expect(onAction).toHaveBeenCalledTimes(1);
    // consumed: toast dismissed, action gone — it cannot fire again
    expect(status.className).not.toContain("on");
    expect(status.textContent).not.toContain("Undo");
  });

  it("a new toast replaces the current one", () => {
    const onAction = vi.fn();
    const { getByText, getAllByRole } = render(
      <ToastHost>
        <Harness onAction={onAction} />
      </ToastHost>,
    );
    fireEvent.click(getByText("decide"));
    fireEvent.click(getByText("decide"));
    expect(getAllByRole("status")[0]!.textContent).toContain("Reads — filed.");
    fireEvent.click(getByText("Undo"));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

describe("StreamCard", () => {
  it("expand/collapse toggles aria-expanded and the label", () => {
    const m = reads[0];
    const { getByRole } = render(
      <StreamCard expandLabel="Expand" collapseLabel="Collapse"
        id={m.id}
        from={m.from.name}
        time={m.time}
        subject={m.subject}
        body={m.body!}
        unread
      />,
    );
    const btn = getByRole("button", { name: /Expand/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(btn.textContent).toContain("Collapse");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.textContent).toContain("Expand");
  });

  /**
   * A SHORT CARD A CLICK OPENED STILL CLOSES. Its pill is hidden and opens nothing, but it is the
   * door the stream's controlled close presses (Back out of a reading named in the address), and
   * it refused, so the card stayed open under an address that no longer named it.
   */
  it("a short card opened by a click is closed by its pill", () => {
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(120);
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(40);
    try {
      const m = reads[2];
      const { container } = render(
        <StreamCard expandLabel="Expand" collapseLabel="Collapse" id={m.id} from={m.from.name} time={m.time} subject={m.subject} body="Paid, thank you." unread />,
      );
      const card = container.querySelector<HTMLElement>(".scast")!;
      expect(card.classList.contains("short"), "premise: a card with nothing more to show").toBe(true);
      const pill = container.querySelector<HTMLButtonElement>(".sc-x")!;
      // The pill is drawn only under keyboard focus now, and it OPENS: the stream's Enter presses
      // it, and a short card's verbs and files mount only on the open card (hand back H1).
      fireEvent.click(pill);
      expect(pill.getAttribute("aria-expanded"), "a short card's pill opens nothing").toBe("true");
      fireEvent.click(pill);
      expect(pill.getAttribute("aria-expanded"), "the opened card would not close").toBe("false");
      fireEvent.click(card);
      expect(pill.getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(pill);
      expect(pill.getAttribute("aria-expanded"), "the opened card would not close").toBe("false");
    } finally {
      height.mockRestore();
      scroll.mockRestore();
    }
  });

  it("stamps data-sid and data-unseen for the seen machinery", () => {
    const m = reads[1];
    const { container } = render(
      <StreamCard expandLabel="Expand" collapseLabel="Collapse" id={m.id} from={m.from.name} time={m.time} subject={m.subject} body={m.body!} unread />,
    );
    const card = container.querySelector(".scast")!;
    expect(card.getAttribute("data-sid")).toBe(m.id);
    expect(card.getAttribute("data-unseen")).toBe("1");
  });

  /**
   * B.1 GUARD (mutation-watch). A card opened BEFORE its body hydrated pins `max-height` to the
   * snippet height; when the `bodySlot` (the rendered viewer) then arrives, that stale inline pin
   * would beat `.scast.viewer.open .sc-clip{max-height:none}` and clip the whole message to two
   * lines. The layout effect must clear the pin when the slot mounts on an open card.
   *
   * jsdom has NO layout, so the pin's PX is meaningless here — but clearing an inline style is a
   * string operation, observable without layout, which is exactly what this asserts. Delete the
   * `clip.style.maxHeight = ""` line in `StreamCard`'s viewer branch and this goes red (watched).
   */
  it("clears the inline max-height pin when a bodySlot arrives on an OPEN card (B.1)", () => {
    const m = reads[0];
    const base = {
      id: m.id, from: m.from.name, time: m.time, subject: m.subject,
      body: m.body!, bodyState: "full" as const,
    };
    const { container, getByRole, rerender } = render(<StreamCard expandLabel="Expand" collapseLabel="Collapse" {...base} />);
    const clip = container.querySelector<HTMLElement>(".sc-clip")!;
    // Open it while still text-only, then stand in for the snippet-height pin real layout would
    // have written (jsdom's scrollHeight is 0, so we set the pin explicitly — its presence is the
    // point, not its value).
    fireEvent.click(getByRole("button", { name: /Expand/ }));
    clip.style.maxHeight = "50px";
    expect(clip.style.maxHeight).toBe("50px");
    // The body hydrates: the viewer node arrives on the still-open card. The pin must clear.
    rerender(<StreamCard expandLabel="Expand" collapseLabel="Collapse" {...base} bodySlot={<div className="probe">rendered</div>} />);
    expect(clip.style.maxHeight).toBe("");
    expect(container.querySelector(".sc-viewer .probe")).not.toBeNull();
  });

  it("an in-place node stands in the same article, which keeps its marks and its open state", () => {
    const m = reads[1];
    const onSelect = vi.fn();
    const base = { id: m.id, from: m.from.name, time: m.time, subject: m.subject, body: m.body!, unread: true, onSelect };
    const { container, getByRole, rerender } = render(<StreamCard expandLabel="Expand" collapseLabel="Collapse" {...base} />);
    const card = container.querySelector<HTMLElement>(".scast")!;
    fireEvent.click(getByRole("button", { name: /Expand/ }));
    rerender(<StreamCard expandLabel="Expand" collapseLabel="Collapse" {...base} inPlace={<div className="probe">answered</div>} />);
    expect(container.querySelector(".scast"), "the same element, not a new one").toBe(card);
    expect(card.classList.contains("in-place")).toBe(true);
    expect(card.getAttribute("data-sid")).toBe(m.id);
    expect(card.getAttribute("data-unseen")).toBe("1");
    expect(card.querySelector(".sc-head"), "the card's own head is not drawn beside it").toBeNull();
    fireEvent.click(card.querySelector(".probe")!);
    expect(onSelect).toHaveBeenCalledWith(m.id);
    rerender(<StreamCard expandLabel="Expand" collapseLabel="Collapse" {...base} />);
    expect(card.classList.contains("in-place")).toBe(false);
    expect(card.classList.contains("open"), "the card comes back as it stood").toBe(true);
    expect(getByRole("button", { name: /Collapse/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("a press on an in-place node selects the letter and opens no card", () => {
    const m = reads[1];
    const onToggle = vi.fn();
    const base = { id: m.id, from: m.from.name, time: m.time, subject: m.subject, body: m.body!, onToggle };
    const { container, getByRole, rerender } = render(
      <StreamCard expandLabel="Expand" collapseLabel="Collapse" {...base} inPlace={<div className="probe">answered</div>} />,
    );
    fireEvent.click(container.querySelector(".probe")!);
    expect(onToggle).not.toHaveBeenCalled();
    rerender(<StreamCard expandLabel="Expand" collapseLabel="Collapse" {...base} />);
    expect(getByRole("button", { name: /Expand/ }).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("ThemeProvider", () => {
  function Harness() {
    const { preference, resolved, cycle, setTheme } = useTheme();
    return (
      <div>
        <span data-testid="pref">{preference}</span>
        <span data-testid="resolved">{resolved}</span>
        <button onClick={cycle}>toggle</button>
        <button onClick={() => setTheme("system")}>system</button>
      </div>
    );
  }

  it("toggles data-theme on <html> and back to system", () => {
    const { getByText, getByTestId } = render(
      <ThemeProvider storageKey={null}>
        <Harness />
      </ThemeProvider>,
    );
    // system default: no explicit attribute
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(getByTestId("pref").textContent).toBe("system");

    fireEvent.click(getByText("toggle"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(getByTestId("resolved").textContent).toBe("dark");

    fireEvent.click(getByText("toggle"));
    expect(document.documentElement.dataset.theme).toBe("light");

    fireEvent.click(getByText("system"));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

/**
 * THREAD PARTICIPANT CIRCLES — the conversation's faces on the subject line, after its count.
 *
 * Two facts about one conversation, in the order they are read: `⤷ N` says how many messages
 * folded into the row, the circles say who is in them, and a conversation with more voices than
 * the stack shows is exactly the case where both are wanted.
 *
 * THE LEAD IS NOT THEIRS. A thread row is led by the latest sender's one full-size circle, the
 * same lead a plain row wears, because the lead is where a row's text column starts: a stack
 * standing there would put a conversation's sender line out of line with the singleton rows
 * above and below it, and would move that edge as rows fold and unfold while mail arrives.
 */
describe("MessageRow thread participant circles", () => {
  const parts = [
    { initials: "AA", hue: 10 },
    { initials: "BB", hue: 120 },
    { initials: "CC", hue: 250 },
  ];
  const base = {
    id: "m1",
    from: "A",
    subject: "Re: launch",
    threadCount: 7,
    avatarInitial: "A",
    avatarHue: 10,
  } as const;

  it("puts the circles in the subject line's badge strip, directly after the ⤷ N count", () => {
    const { container } = render(<MessageRow {...base} participants={parts} />);
    const row = container.querySelector(".row")!;
    const badges = row.querySelector(".badges")!;
    // The strip belongs to the subject LINE (`.row-mid`), as the subject's SIBLING — never
    // its child (2026-08-31). `.subj` is a nowrap/ellipsis span, so a strip inside it was
    // silently truncated by any long subject: the thread's count and tags vanished at
    // exactly the 320–400px list widths the product renders. The subject shrinks; the
    // strip always lands. This assertion used to demand `.subj` contain it — inverted
    // deliberately, with the truncation immunity as the new consumer.
    expect(badges.closest(".row-mid")).not.toBeNull();
    expect(badges.closest(".subj")).toBeNull();
    // Count first, faces immediately after it, nothing in between: how many, then who.
    expect(badges.children).toHaveLength(2);
    expect(badges.children[0]!.textContent).toBe("⤷ 7");
    const stack = badges.children[1]!;
    expect(stack.classList.contains("thread-circles")).toBe(true);
    // Three faces, each the SMALL avatar variant the 18px sizing is keyed on.
    expect(stack.querySelectorAll(".av.s")).toHaveLength(3);
    expect([...stack.querySelectorAll(".av")].map((e) => e.textContent)).toEqual([
      "AA",
      "BB",
      "CC",
    ]);
    // The circles are decorative; the row's own label already names sender and subject.
    expect(stack.getAttribute("aria-hidden")).toBe("true");
  });

  it("is led by the sender's one full-size circle, on a thread row exactly as on a plain one", () => {
    const thread = render(<MessageRow {...base} participants={parts} />);
    const plain = render(<MessageRow {...base} />);
    const leadOf = (c: HTMLElement): Element => c.querySelector(".row")!.firstElementChild!;
    const led = leadOf(thread.container);
    // One circle, full size: the small variant belongs to the strip and never to the lead.
    expect(led.classList.contains("av")).toBe(true);
    expect(led.classList.contains("s")).toBe(false);
    expect(led.querySelectorAll(".av")).toHaveLength(0);
    expect(led.textContent).toBe("A");
    // ALIGNMENT: byte-identical leads ⇒ both rows' text columns start in the same place, so a
    // list of thread and plain rows has one left edge and it does not move as rows fold.
    expect(led.outerHTML).toBe(leadOf(plain.container).outerHTML);
    expect(thread.container.querySelector(".row")!.classList.contains("srow")).toBe(true);
    expect(plain.container.querySelector(".row")!.classList.contains("srow")).toBe(true);
    // Every small circle in the row is in the strip; the lead slot holds none of them.
    const small = [...thread.container.querySelectorAll(".av.s")];
    expect(small).toHaveLength(3);
    for (const c of small) expect(c.closest(".thread-circles")).not.toBeNull();
    // Lead + three faces, and no lead stack anywhere.
    expect(thread.container.querySelectorAll(".av")).toHaveLength(4);
    expect(thread.container.querySelector(".av-stack")).toBeNull();
  });

  it("caps the strip at three circles however many participants it is handed", () => {
    const { container } = render(
      <MessageRow
        {...base}
        id="m2"
        participants={[...parts, { initials: "DD", hue: 300 }, { initials: "EE", hue: 40 }]}
      />,
    );
    expect(container.querySelectorAll(".thread-circles .av")).toHaveLength(3);
    expect(container.textContent).not.toContain("DD");
    expect(container.textContent).not.toContain("EE");
    // The overflow is the count that is already there — never a second number in a circle.
    expect(container.querySelector(".av.more")).toBeNull();
  });

  it("a single-sender thread is byte-identical to a row with no participants at all", () => {
    const one = render(<MessageRow {...base} id="m3" participants={[parts[0]!]} />);
    const none = render(<MessageRow {...base} id="m3" />);
    expect(one.container.querySelector(".thread-circles")).toBeNull();
    const av = one.container.querySelectorAll(".av");
    expect(av).toHaveLength(1);
    expect(av[0]!.classList.contains("s")).toBe(false);
    expect(one.container.textContent).toContain("⤷ 7");
    expect(one.container.innerHTML).toBe(none.container.innerHTML);
  });

  it("sizes the strip's circles at 18px overlapping 6px, below the singleton circle", () => {
    // Read from the SUITE ROOT, not from `import.meta.url`: this file runs under jsdom, where
    // the module URL is an http: one and `new URL(…, import.meta.url)` is not a path.
    const at = (p: string) => resolve(process.cwd(), "packages/ui/src", p);
    const avatarCss = readFileSync(at("primitives/avatar.css"), "utf8");
    const rowCss = readFileSync(at("composites/row.css"), "utf8");
    const single = Number(/\.av\{[^}]*width:\s*(\d+(?:\.\d+)?)px/.exec(avatarCss)![1]);
    expect(single).toBe(30);

    const decl = /\.thread-circles\s+\.av\.s\{([^}]*)\}/.exec(rowCss)?.[1];
    expect(decl).toBeDefined();
    const px = (prop: string): number =>
      Number(new RegExp(`${prop}:\\s*(-?\\d+(?:\\.\\d+)?)px`).exec(decl!)![1]);
    const w = px("width");
    expect(w).toBe(18);
    expect(px("height")).toBe(18);
    expect(w).toBeLessThan(single);
    // The overlap: each face steps 6px onto the one before it, and the first does not step.
    expect(px("margin-left")).toBe(-6);
    expect(rowCss).toContain(".row .thread-circles .av.s:first-child{margin-left:0}");
    // The ring is the ROW's colour, so a face reads as separate from the one behind it —
    // one shadow, and it follows the row through hover and selection. A row with a trailing
    // action slot wears its surface on the SLOT, so each of these is a selector list now and the
    // rule is found by the compound it contains: a hover on the reserved gutter is a hover on the
    // row, and rings left on the panel's colour there would ring against the wrong ground.
    expect(decl).toContain("box-shadow:0 0 0 1.5px var(--edge)");
    const bare = rowCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const edgeOf = (compound: string): string => {
      const rule = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1]!.includes(compound));
      expect(rule, `no rule in row.css styles \`${compound}\``).toBeDefined();
      return rule![2]!;
    };
    for (const on of [".row:hover", ".row-slot:hover"])
      expect(edgeOf(`${on} .thread-circles`)).toContain("--edge:var(--tint)");
    for (const on of [".row.sel", ".row-slot:has(.row.sel)"])
      expect(edgeOf(`${on} .thread-circles`)).toContain("--edge:var(--float)");
  });
});

/**
 * THE ROW'S STAMP — the exact instant on hover, and a press that flips the whole list.
 *
 * The component half of the list-row date stamp. `MessageRow` is handed a stamp (`time`), the
 * OTHER form of the same instant for the hover title (`timeTitle`), and — only where a surface
 * wires it — the flip itself (`onToggleTime`). It renders the text and routes the press; which
 * two forms those are, and what the flip changes, belong to the app.
 *
 * The press is routed by the ROW's own handler off a `data-stamp` hit test rather than by a
 * control of its own, and that is the one decision here worth stating: the row IS a `<button>`,
 * so a second interactive element inside it is not a styling preference but a broken tree. The
 * assertions below pin both halves — the flip works, and it does not cost a nested control.
 */
describe("MessageRow stamp", () => {
  const base = { id: "m1", from: "Ada Lund", subject: "Quote for the north elevation" };

  it("hovering the stamp names the exact instant, and the row keeps ONE control", () => {
    const { container } = render(
      <MessageRow {...base} time="Sat" timeTitle="Sat 1 Aug 2026, 09:12" onToggleTime={() => {}} />,
    );
    const row = container.querySelector<HTMLElement>("button.row")!;
    const stamp = row.querySelector<HTMLElement>(".t")!;
    expect(stamp.textContent, "the row lost its stamp").toBe("Sat");
    expect(stamp.getAttribute("title"), "hover does not name the exact instant").toBe(
      "Sat 1 Aug 2026, 09:12",
    );
    /**
     * THE NESTING INVARIANT, and it is measured rather than assumed. A `<button>` inside the row
     * button does not merely lint badly: the HTML parser closes the row at the inner start tag and
     * the stamp comes back a SIBLING of the row (checked against jsdom's parser — `<button
     * class="row">…<button class="stamp">` parses to two sibling buttons). This page is
     * server-rendered, so that is the tree the browser builds before React ever hydrates it.
     * Make the stamp a `<button>` (or give it a `tabindex`, which is interactive content too and
     * breaks the `role="option"` contract `picked` states) and this goes red.
     */
    expect(stamp.tagName, "the stamp became an element of its own kind").toBe("SPAN");
    expect(row.querySelector("button"), "a second interactive control was nested in the row").toBeNull();
  });

  it("pressing the stamp flips the list instead of opening the row", () => {
    const onClick = vi.fn();
    const onToggleTime = vi.fn();
    const { container } = render(
      <MessageRow {...base} time="Sat" timeTitle="Sat 1 Aug 2026, 09:12" onClick={onClick} onToggleTime={onToggleTime} />,
    );
    const row = container.querySelector<HTMLElement>("button.row")!;
    fireEvent.click(row.querySelector(".t")!);
    // THE GUARD. Drop the `data-stamp` hit test from the row's press and the click falls through
    // to `onClick` — the row opens the message and no date ever flips.
    expect(onToggleTime, "the stamp press did not reach the flip").toHaveBeenCalledTimes(1);
    expect(onClick, "the stamp press ALSO opened the message").not.toHaveBeenCalled();

    // …and a press anywhere else is still the ordinary row press, untouched.
    fireEvent.click(row.querySelector(".subj")!);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onToggleTime).toHaveBeenCalledTimes(1);
  });

  /**
   * THE INJECTED DEPENDENCY. `onToggleTime` absent means this surface has no flip behind it —
   * the desktop shell, a fixture list, any of the harnesses that mount a row directly — and the
   * stamp is then a plain span whose press does what a row press has always done. Never a control
   * that answers nothing, which is the one affordance this product removes wherever it finds it.
   */
  it("without the callback the stamp is inert — no hit target, and the press opens the row", () => {
    const onClick = vi.fn();
    const { container } = render(
      <MessageRow {...base} time="Sat" timeTitle="Sat 1 Aug 2026, 09:12" onClick={onClick} />,
    );
    const row = container.querySelector<HTMLElement>("button.row")!;
    const stamp = row.querySelector<HTMLElement>(".t")!;
    expect(stamp.tagName).toBe("SPAN");
    expect(stamp.hasAttribute("data-stamp"), "an unwired stamp still advertises itself as a hit target").toBe(false);
    expect(stamp.classList.contains("tog"), "an unwired stamp still wears the pressable styling").toBe(false);
    // The hover title is DATA, not the dependency: a surface with no flip still says the exact
    // instant on hover.
    expect(stamp.getAttribute("title")).toBe("Sat 1 Aug 2026, 09:12");
    fireEvent.click(stamp);
    expect(onClick, "an unwired stamp swallowed the row press").toHaveBeenCalledTimes(1);
  });

  it("a row with no stamp at all renders no stamp element, wired or not", () => {
    const { container } = render(<MessageRow {...base} onToggleTime={() => {}} />);
    expect(container.querySelector(".t"), "an undated row rendered an empty stamp").toBeNull();
  });
});
