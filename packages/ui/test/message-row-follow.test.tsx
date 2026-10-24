/** @vitest-environment jsdom */
/**
 * A ROW'S FOLLOWER — what stands under the open conversation's row (the Ohbox's strip of its
 * squares). The row is a `<button role="option">`; a control inside it would be hoisted out by the
 * parser and is not allowed under the role, so the follower stands BESIDE the button in the row's
 * slot, never in it. A row without one renders exactly as before.
 */
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MessageRow } from "@ohmail/ui";

afterEach(cleanup);

const base = { id: "m1", from: "Lena", subject: "Q3 plan", time: "09:12", preview: "the words", unread: true, windowIndex: 4 } as const;

describe("MessageRow follow", () => {
  it("stands beside the row's button in its slot, never inside it, and takes the window's index", () => {
    let pressed = 0;
    const { container } = render(
      <MessageRow {...base} onClick={() => { pressed += 1; }} follow={<button type="button" className="probe">square</button>} />,
    );
    const slot = container.firstElementChild as HTMLElement;
    expect(slot.className).toBe("row-slot");
    const probe = container.querySelector<HTMLElement>(".probe")!;
    expect(probe.closest(".row"), "the follower inside the row's button").toBeNull();
    expect(probe.parentElement?.className).toBe("row-follow");
    expect(probe.parentElement?.parentElement).toBe(slot);
    // the window measures the whole slot, the follower's height included
    expect(slot.getAttribute("data-index")).toBe("4");
    expect(container.querySelector(".row")?.hasAttribute("data-index")).toBe(false);
    fireEvent.click(probe);
    expect(pressed, "a press on the follower is not a press on the row").toBe(0);
  });

  it("beside actions too, after them", () => {
    const { container } = render(<MessageRow {...base} actions={<span className="act" />} follow={<i className="probe" />} />);
    const slot = container.firstElementChild as HTMLElement;
    expect([...slot.children].map((c) => c.className)).toEqual([expect.stringContaining("row"), "row-actions", "row-follow"]);
  });

  it("absent, the row is the bare button, as before", () => {
    const bare = renderToStaticMarkup(<MessageRow {...base} />);
    expect(bare.startsWith("<button"), "a slot appeared around a row with nothing beside it").toBe(true);
    expect(bare).not.toContain("row-follow");
    expect(bare).toContain('data-index="4"');
    expect(renderToStaticMarkup(<MessageRow {...base} follow={undefined} />)).toBe(bare);
    const withActions = renderToStaticMarkup(<MessageRow {...base} actions={<span />} />);
    expect(withActions).not.toContain("row-follow");
    expect(withActions).toMatch(/^<div class="row-slot" role="presentation"><button[^>]* data-index="4"/);
  });
});
