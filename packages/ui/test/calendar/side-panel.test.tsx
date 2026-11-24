/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SidePanel } from "@ohmail/ui/calendar";

afterEach(cleanup);

describe("the panel beside a view", () => {
  it("is a named column of its own beside the view, with its head, what scrolls, and what stays at its foot", () => {
    render(
      <SidePanel label="Agenda" head={<h2>Agenda</h2>} foot={<button type="button">Join</button>}>
        <p>Today</p>
      </SidePanel>,
    );
    const panel = screen.getByRole("complementary", { name: "Agenda" });
    expect(panel.contains(screen.getByRole("heading", { name: "Agenda" }))).toBe(true);
    expect(panel.contains(screen.getByText("Today"))).toBe(true);
    expect(panel.contains(screen.getByRole("button", { name: "Join" }))).toBe(true);
  });

  it("hands the app what scrolls, so the app can bring a row into sight", () => {
    let scroller: HTMLDivElement | null = null;
    render(
      <SidePanel
        label="Invitations"
        head={<h2>Invitations</h2>}
        scrollRef={(el) => {
          scroller = el;
        }}
      >
        <p>To answer</p>
      </SidePanel>,
    );
    expect(scroller).not.toBeNull();
    expect(scroller!.contains(screen.getByText("To answer"))).toBe(true);
    expect(scroller!.contains(screen.getByRole("heading", { name: "Invitations" }))).toBe(false);
  });
});
