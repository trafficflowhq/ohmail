/** @vitest-environment jsdom */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { Row } from "@ohmail/ui/mail";
import { Tag } from "@ohmail/ui/base";
import { headStamp } from "@ohmail/app-logic/reader";
import { letter, letterOf, mountLetters } from "./_reader-1-letters.js";

/**
 * THE OPEN MESSAGE'S STAMP FLIPS TO THE EXACT DATE ON A PRESS, AND A LIST ROW'S TAG STANDS IN THE ROW.
 *
 *  · STAMP. The open letter's stamp shows its short form with the exact instant on hover; a press
 *    flips it to the exact form. It is a `<button>`, so the flip is keyboard-reachable, and a view
 *    switch leaves it at its short form again.
 *
 *  · LIST ROWS. A tag in a list is a scanning aid at row scale: the row draws it inline, never
 *    folded into a disclosure.
 *
 * ── RE-POINTED (share reader-1, the switch's older tests) ─────────────────────────────────────
 *
 * The stamp's cases mounted today's `MessagePane` under a `MessageChromeProvider`; they now mount the reading column
 * the new shell mounts (`_reader-1-letters.tsx`: the frame, the reader, a fake engine) and find the stamp by its role,
 * its name and its pressed state. Its two forms are the reader's own (`headStamp`, which the head is handed), as the
 * pane's were today's `displayTime` and `fullDateTime`. The view switch, which today's shell made by an effect keyed
 * on the view and this file read as source, is made here: the address goes to another place and back. The list row is
 * the kit's `Row`, which the Ohbox hands its tag as the kit's `Tag`. The cases of the letter's tags (the `(i)`
 * disclosure, the `+ Tag` chip under the title) left with today's view: the new reader stands a letter's tags whole
 * in its head and Tag is a verb of its panel (`packages/app/test/reader/letters.test.tsx`).
 */

/* The reader stamps in the platform's zone: the file pins it, so the assertions are not about the machine running it. */
const ZONE = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC";
});
afterAll(() => {
  process.env.TZ = ZONE;
});
afterEach(cleanup);

function msg(over: Parameters<typeof letter>[1] = {}) {
  return letter("m1", {
    subject: "Quote for the north elevation",
    from: { name: "Ada Lovelace", address: "ada@example.invalid" },
    to: [],
    unread: false,
    date: "2026-07-28T14:32:00.000Z",
    arrivedAt: "2026-07-28T14:32:00.000Z",
    ...over,
  });
}

/** The open letter's stamp: the head's button that presses its date between its two forms. */
const stampOf = (pressed: boolean) => within(letterOf("m1")!).getByRole("button", { pressed, name: /\d\d:\d\d/ });

/** The letter's two forms as the reader's head is handed them. */
const forms = (iso: string) =>
  headStamp(iso, new Date(), "UTC", "en", { yesterday: (time) => `Yesterday ${time}` });

describe("the viewer's tags fold into the disclosure, the list rows do not", () => {
  it("LIST ROWS ARE UNCHANGED — `MessageRow` still renders its tag chips inline", () => {
    const { container } = render(
      <Row who="Ada" people={[]} subject="Quote" when="Mon" tag={<Tag hue={130}>Work</Tag>} />,
    );
    // The row's tag is a plain inline chip inside the row — NOT wrapped in any disclosure.
    expect(container.textContent, "the list row dropped its tag chip").toContain("Work");
    expect(container.querySelector(".tag-note"), "a list row must not fold its tags").toBeNull();
    expect(container.querySelector("details"), "a list row must not render a disclosure").toBeNull();
  });
});

describe("the stamp shows relative, exact on hover, and flips ALL stamps on click", () => {
  it("by default shows the relative stamp with the absolute instant on hover", () => {
    const m = msg();
    const { when: rel, full: abs } = forms(m.date!);
    expect(rel, "test fixture must have a rel/abs that actually differ").not.toBe(abs);

    mountLetters({ letters: [m], open: "m1" });
    const stamp = stampOf(false).querySelector("time");
    expect(stamp, "no stamp in the open message header").not.toBeNull();
    expect(stamp!.textContent, "the resting stamp is not the relative form").toBe(rel);
    expect(stampOf(false).getAttribute("title"), "hover no longer shows the exact date").toBe(abs);
    expect(stamp!.getAttribute("datetime")).toBe(m.date);
  });

  it("clicking the stamp flips it to the absolute form (and the hover title to the relative one)", async () => {
    const m = msg();
    const { when: rel, full: abs } = forms(m.date!);

    mountLetters({ letters: [m], open: "m1" });
    const button = stampOf(false);
    expect(button.getAttribute("aria-pressed"), "the stamp does not report its toggle state").toBe("false");
    await act(async () => {
      fireEvent.click(button);
    });
    // THE GUARD. Revert (a bare `<time>` with no toggle) and this stays on the relative form.
    const pressed = stampOf(true);
    expect(pressed.querySelector("time")!.textContent, "the click did not flip the stamp to the exact date").toBe(abs);
    expect(pressed.getAttribute("title"), "the exact-mode hover no longer offers the relative form").toBe(rel);
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
  });

  it("a letter dated after it arrived is dated by its arrival in both forms", async () => {
    mountLetters({ letters: [msg({ date: "2026-08-04T09:00:00.000Z", arrivedAt: "2026-08-02T09:07:00.000Z" })], open: "m1" });
    const stamp = (): HTMLElement => within(letterOf("m1")!).getByRole("button", { name: /\d\d:\d\d/ });
    expect(stamp().querySelector("time")!.getAttribute("datetime")).toBe("2026-08-02T09:07:00.000Z");
    expect(stamp().getAttribute("title")).toBe("Sun 2 Aug 2026, 09:07");
    await act(async () => {
      fireEvent.click(stamp());
    });
    expect(stamp().querySelector("time")!.textContent).toBe("Sun 2 Aug 2026, 09:07");
  });

  it("the flip is reset on a view switch", async () => {
    const m = msg();
    const { when: rel } = forms(m.date!);
    const { address } = mountLetters({ letters: [m], open: "m1" });
    await act(async () => {
      fireEvent.click(stampOf(false));
    });
    expect(stampOf(true), "the press did not flip the stamp: this case proves nothing").toBeTruthy();
    await act(async () => {
      address.visit("#/write");
    });
    expect(letterOf("m1"), "the other place still shows the letter: no view switch was made").toBeNull();
    await act(async () => {
      address.visit("#/ohbox/m/m1");
    });
    // Leave the flag standing past the view and the letter comes back in its exact form.
    expect(stampOf(false).querySelector("time")!.textContent, "the absolute-time flag is no longer reset on a view switch").toBe(rel);
  });
});
