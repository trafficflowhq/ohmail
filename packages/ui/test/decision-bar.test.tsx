/** @vitest-environment jsdom */
/**
 * DecisionBar: the full keyboard map — y accepts the AI suggestion,
 * o/r/c/n/x file, ⇧+key files + marks read — plus segment clicks and
 * the scope toggle.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { DecisionBar } from "@ohmail/ui";
import { waiting } from "@ohmail/testing";
import { enDecisionCopy } from "./decision-copy.js";

afterEach(cleanup);

const lena = waiting[0];

function renderBar(onDecide = vi.fn(), onScopeChange = vi.fn()) {
  const utils = render(
    <div>
      <DecisionBar
        aiDest="ohbox"
        scope="sender"
        onScopeChange={onScopeChange}
        copy={enDecisionCopy(lena.from.address)}
        onDecide={onDecide}
        keyboard
      />
      <input aria-label="typing" />
    </div>,
  );
  return { onDecide, onScopeChange, ...utils };
}

describe("DecisionBar keyboard map", () => {
  it.each([
    ["o", "ohbox"],
    ["r", "reads"],
    ["c", "receipts"],
    ["n", "screened"],
    ["x", "spam"],
  ] as const)("'%s' files to %s", (key, dest) => {
    const { onDecide } = renderBar();
    fireEvent.keyDown(document.body, { key });
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith(dest, { markRead: false });
  });

  it("'y' accepts the AI-preselected destination", () => {
    const { onDecide } = renderBar();
    fireEvent.keyDown(document.body, { key: "y" });
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith("ohbox", { markRead: false });
  });

  it("⇧+key files AND marks read", () => {
    const { onDecide } = renderBar();
    fireEvent.keyDown(document.body, { key: "R", shiftKey: true });
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith("reads", { markRead: true });
    fireEvent.keyDown(document.body, { key: "Y", shiftKey: true });
    expect(onDecide).toHaveBeenCalledWith("ohbox", { markRead: true });
  });

  it("⇧+key does NOT mark read for a demoting destination — nothing to read when triaging out", () => {
    const { onDecide } = renderBar();
    fireEvent.keyDown(document.body, { key: "N", shiftKey: true }); // Screen out
    expect(onDecide).toHaveBeenLastCalledWith("screened", { markRead: false });
    fireEvent.keyDown(document.body, { key: "X", shiftKey: true }); // Spam
    expect(onDecide).toHaveBeenLastCalledWith("spam", { markRead: false });
  });

  it("ignores keys while typing in an input", () => {
    const { onDecide, getByLabelText } = renderBar();
    fireEvent.keyDown(getByLabelText("typing"), { key: "o" });
    expect(onDecide).not.toHaveBeenCalled();
  });
});

describe("DecisionBar segments", () => {
  it("main and ✓ segments decide with distinct markRead", () => {
    const { onDecide, getByTitle, getByLabelText, queryByLabelText } = renderBar();
    fireEvent.click(getByTitle("Reads (r)"));
    expect(onDecide).toHaveBeenLastCalledWith("reads", { markRead: false });
    fireEvent.click(getByLabelText("Reads, mark read"));
    expect(onDecide).toHaveBeenLastCalledWith("reads", { markRead: true });
    // The demoting destinations carry NO ✓ — you don't read what you triage out.
    expect(queryByLabelText("Screened out, mark read")).toBeNull();
    expect(queryByLabelText("Spam, mark read")).toBeNull();
  });

  it("renders all five destinations, with the ✓ on the three mail piles only", () => {
    const { container, getByText, queryByLabelText } = renderBar();
    expect(container.querySelectorAll(".dbtn")).toHaveLength(5);
    expect(container.querySelectorAll(".dbtn.ai")).toHaveLength(1);
    for (const label of ["Ohbox", "Reads", "Receipts", "Screen out", "Spam"])
      expect(getByText(label)).toBeTruthy();
    // The read verb exists for the admitting destinations and for no others.
    expect(container.querySelectorAll(".d-read")).toHaveLength(3);
    for (const l of ["Ohbox, mark read", "Reads, mark read", "Receipts, mark read"])
      expect(queryByLabelText(l)).toBeTruthy();
    for (const l of ["Screened out, mark read", "Spam, mark read"])
      expect(queryByLabelText(l)).toBeNull();
  });

  it("scope toggle flips sender ↔ domain and the note names the target", () => {
    const { onScopeChange, getByText } = renderBar();
    fireEvent.click(getByText("whole domain"));
    expect(onScopeChange).toHaveBeenCalledWith("domain");
    expect(getByText(/lena@atelier-eichspan\.example/).textContent).toContain("Becomes a rule");
  });
});

/**
 * ═══ THE KEY IS ON THE VERB, AND BOTH VERBS ARE NAMED ══════════════════════════
 *
 * A live walk found this bar illegible in three ways: four of the five keys existed only in
 * a `title` attribute, a strip at the far end spelled "⇧+key marks read" for keys that were
 * not on screen, and the note explained the ✓ half while saying nothing about the half
 * people press. An earlier change had already settled the rule for the message action bar — the key
 * goes on the verb it fires — and this is that rule reaching the surface it had missed.
 */
describe("the decision keys are ON the capsules", () => {
  /** The webapp's mode: the keyboard belongs to the registry, so `keyboard` is NOT passed. */
  function renderPlain() {
    return render(
      <DecisionBar
        aiDest="ohbox"
        scope="sender"
        onScopeChange={vi.fn()}
        copy={enDecisionCopy(lena.from.address)}
        onDecide={vi.fn()}
      />,
    );
  }

  it.each([
    ["Ohbox", "o"],
    ["Reads", "r"],
    ["Receipts", "c"],
  ])("%s carries its own key, and its ✓ half carries the shifted twin", (label, k) => {
    // THE GUARD. Drop `kbdHint={…}` or `check.kbdHint` in `DecisionBar` and this goes red
    // — which is the shipped state the report names: `title="Ohbox (o)"` and nothing visible.
    const { container } = renderPlain();
    const capsule = [...container.querySelectorAll<HTMLElement>(".dbtn")].find(
      (c) => c.querySelector(".d-main")?.firstChild?.textContent === label,
    );
    expect(capsule, `no capsule labelled ${label}`).toBeTruthy();
    expect(capsule!.querySelector(".d-main kbd")?.textContent).toBe(k);
    expect(capsule!.querySelector(".d-read kbd")?.textContent).toBe(`⇧${k.toUpperCase()}`);
  });

  it.each([
    ["Screen out", "n"],
    ["Spam", "x"],
  ])("%s carries its own key but NO ✓ half — nothing to mark read when triaging out", (label, k) => {
    const { container } = renderPlain();
    const capsule = [...container.querySelectorAll<HTMLElement>(".dbtn")].find(
      (c) => c.querySelector(".d-main")?.firstChild?.textContent === label,
    );
    expect(capsule, `no capsule labelled ${label}`).toBeTruthy();
    expect(capsule!.querySelector(".d-main kbd")?.textContent).toBe(k);
    expect(capsule!.querySelector(".d-read")).toBeNull();
  });

  it("the ✓ half is still named for a screen reader, not by its keycap", () => {
    // The cap is decoration on a button whose `aria-label` already wins; adding it must not
    // change what the control is called. Checked on a mail destination — the demoting ones no
    // longer have a ✓ to name.
    const { getByLabelText } = renderPlain();
    expect(getByLabelText("Reads, mark read")).toBeTruthy();
  });

  it("`y` is capped ONLY where `y` is bound — i.e. never in the webapp", () => {
    // Both of these were false in the shipped product. `y` is this component's own listener,
    // behind the `keyboard` prop, and the webapp deliberately stopped passing it when the
    // chords moved into the registry — so the bar advertised a key that did nothing.
    // Restore `kbdHint={ai ? "y" : undefined}` and the first expectation goes red.
    const plain = renderPlain();
    expect(plain.container.querySelector(".dbtn.ai .d-main kbd")?.textContent).toBe("o");
    expect(plain.container.textContent).not.toContain("accept");
    cleanup();

    const keyed = renderBar();
    expect(keyed.container.querySelector(".dbtn.ai .d-main kbd")?.textContent).toBe("y");
  });

  it("the detached legend is GONE — nothing outside the capsules states a key", () => {
    // `.d-keys` held "y accept · ⇧+key marks read": a second list of the same facts, at the
    // other end of the bar from the controls it described. Put it back and this goes red.
    const { container } = renderPlain();
    expect(container.querySelector(".d-keys")).toBeNull();
    expect(container.querySelector(".d-sub kbd")).toBeNull();
  });

  it("the note says what BOTH halves do, and still leads with the rule disclosure", () => {
    // The consent sentence has to be readable before the click, because screening
    // a sender out arms auto-unsubscribe — so it stays first. What follows it used to
    // explain the ✓ half only.
    const { container } = renderPlain();
    const note = container.querySelector(".d-note")!.textContent ?? "";
    expect(note.startsWith("Becomes a rule")).toBe(true);
    expect(note).toContain(lena.from.address);
    expect(note).toContain("files the mail waiting here");
    expect(note).toContain("marks it read");
  });

  /**
   * THE SPLIT, ASSERTED ON THE SIDE THAT COULD REGRESS SILENTLY.
   *
   * The half that explains the button moved behind an (i) so the bar stops spending a second
   * line on it. The half that is CONSENT did not move, and the assertion that matters is which
   * side of the fold each one landed on — a mistake here is invisible in a screenshot of an
   * opened note and is exactly the mistake that would matter.
   *
   * `open === false` is the whole claim about visibility. The detail text is in the DOM either
   * way (see `InfoNote`), so `textContent` above proves the sentence exists and says nothing
   * about whether anybody can see it; this is the assertion that does.
   */
  it("the rule disclosure is the visible lead; the button explanation starts collapsed", () => {
    const { container } = renderPlain();
    const note = container.querySelector<HTMLDetailsElement>("details.d-note")!;
    expect(note.open).toBe(false);
    const lead = note.querySelector(".infonote-lead")!.textContent ?? "";
    expect(lead.startsWith("Becomes a rule")).toBe(true);
    expect(lead).toContain(lena.from.address);
    // The consent line is complete without opening anything.
    expect(lead).toContain("files automatically");
    // …and the part behind the (i) is only the button explanation.
    const more = note.querySelector(".infonote-more")!.textContent ?? "";
    expect(more).toContain("files the mail waiting here");
    expect(more).toContain("marks it read");
    expect(more).not.toContain("Becomes a rule");
  });
});
