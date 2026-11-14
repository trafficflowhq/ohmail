/** @vitest-environment jsdom */
/**
 * THE FROM LINE's SENTENCE IS HEARD: where Write moves the sender to the
 * recipient's domain, or replaces a mailbox that is gone, the sentence at the line's end is a status a screen reader
 * hears, under an id the caller can name, and the chooser it is about can be described by it.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Slot } from "../../src/base/index.js";
import { Recipients } from "../../src/mail/index.js";

afterEach(cleanup);

const STATE = "Switched to match the recipient's domain";

describe("the From line's sentence", () => {
  it("is a status under the id the caller hands, which the chooser it is about names as its description", () => {
    render(
      <Recipients
        from={{
          label: "From",
          value: (
            <Slot label="Send from mila@lichtgrat.example" describedBy="from-state">
              mila@lichtgrat.example
            </Slot>
          ),
          state: STATE,
          stateId: "from-state",
        }}
        lines={[]}
      />,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toBe(STATE);
    expect(status.id).toBe("from-state");
    const chooser = screen.getByRole("button", { name: "Send from mila@lichtgrat.example" });
    expect(chooser.getAttribute("aria-describedby")).toBe("from-state");
  });

  it("stands as a status with an id of its own where the caller hands none", () => {
    render(<Recipients from={{ label: "From", value: "mila@lichtgrat.example", state: STATE }} lines={[]} />);
    expect(screen.getByRole("status").id).not.toBe("");
  });

  it("is not there where there is nothing to say, and a chooser handed no description has none", () => {
    render(
      <Recipients
        from={{
          label: "From",
          value: <Slot label="Send from mila@lichtgrat.example">mila@lichtgrat.example</Slot>,
        }}
        lines={[]}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button").hasAttribute("aria-describedby")).toBe(false);
  });
});
