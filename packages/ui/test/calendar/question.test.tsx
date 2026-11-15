/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QuestionBeforeAct } from "@ohmail/ui/calendar";

afterEach(cleanup);

const at = { x: 400, y: 300 };

describe("the question before an act", () => {
  it("asks in a dialog named with the act, and draws nothing while it is shut", () => {
    const { rerender } = render(
      <QuestionBeforeAct
        open={false}
        onClose={() => {}}
        anchor={at}
        question="Move to Wed 11 Nov, 18:30"
        cancel="Cancel"
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(
      <QuestionBeforeAct
        open
        onClose={() => {}}
        anchor={at}
        question="Move to Wed 11 Nov, 18:30"
        follows="Every week on Tuesday"
        cancel="Cancel"
      />,
    );
    expect(screen.getByRole("dialog", { name: "Move to Wed 11 Nov, 18:30" })).toBeTruthy();
    expect(screen.queryByText("Every week on Tuesday")).not.toBeNull();
  });

  it("a series offers which events, the first one holding the keys, each run by a press", () => {
    const one = vi.fn(),
      all = vi.fn();
    render(
      <QuestionBeforeAct
        open
        onClose={() => {}}
        anchor={at}
        question="Move to Wed 11 Nov, 18:30"
        scopes={[
          { id: "this", label: "This event", keyHint: "1", onPress: one },
          { id: "following", label: "This and following", keyHint: "2" },
          { id: "all", label: "All events", keyHint: "3", onPress: all },
        ]}
        cancel="Cancel"
      />,
    );
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["This event1", "This and following2", "All events3"]);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.click(items[0]!);
    fireEvent.click(items[2]!);
    expect([one, all].map((f) => f.mock.calls.length)).toEqual([1, 1]);
  });

  it("an act that writes to invitees takes a note and offers to tell or not; the first answer holds the keys", () => {
    const send = vi.fn(),
      quiet = vi.fn(),
      typed = vi.fn();
    render(
      <QuestionBeforeAct
        open
        onClose={() => {}}
        anchor={at}
        question="Tell Ben Arnold, Giulia Ferrari and 2 more"
        follows="now Fri 13 Nov, 16:00"
        note={{ label: "A note to the invitees", placeholder: "Add a note", value: "", onChange: typed }}
        answers={[
          { id: "send", label: "Send update", keyHint: "↵", onPress: send },
          { id: "quiet", label: "Don't send", keyHint: "⇧↵", onPress: quiet },
        ]}
        cancel="Cancel"
      />,
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Send update/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "A note to the invitees" }), {
      target: { value: "Sorry for the late change." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Send update/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Don't send/ }));
    expect(typed).toHaveBeenCalledWith("Sorry for the late change.");
    expect([send, quiet].map((f) => f.mock.calls.length)).toEqual([1, 1]);
  });

  it("Esc and the close mean nothing happened", () => {
    const onClose = vi.fn(),
      send = vi.fn();
    render(
      <QuestionBeforeAct
        open
        onClose={onClose}
        anchor={at}
        question="Tell Inês Carvalho"
        answers={[{ id: "send", label: "Send cancellation", onPress: send }]}
        cancel="Cancel"
      />,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });
});
