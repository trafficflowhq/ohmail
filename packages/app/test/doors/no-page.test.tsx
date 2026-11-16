/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoPagePage, NO_PAGE_STATES, type NoPageDoor } from "../../src/doors/no-page/index.js";
import doorsEn from "../../messages/doors.en.json" with { type: "json" };
import doorsDe from "../../messages/doors.de.json" with { type: "json" };

/**
 * THE NO-PAGE says what its server file hands it and nothing else: it reads no catalogue, so the HTML the server sends
 * carries every word. Each way on is the door's act. Its words are the doors' own (`gate`), the design's.
 */
const words = { en: doorsEn.gate, de: doorsDe.gate } as const;

function missing(locale: "en" | "de") {
  const home = vi.fn();
  const w = words[locale];
  const door: NoPageDoor = {
    at: "missing",
    words: { title: w.missingTitle, note: w.missingNote, home: w.missingHome },
    home,
  };
  return { door, home };
}

function noServer(locale: "en" | "de") {
  const acts = { demo: vi.fn(), signIn: vi.fn() };
  const w = words[locale];
  const door: NoPageDoor = {
    at: "noserver",
    words: { title: w.lede, body: w.body, note: w.note, demo: w.openDemo, signIn: w.signIn },
    ...acts,
  };
  return { door, acts };
}

const buttons = (): string[] => screen.queryAllByRole("button").map((b) => b.textContent ?? "");

afterEach(cleanup);

describe("the no-page", () => {
  it("missing: says there is no page here, why it may be, and takes the person back", () => {
    const { door, home } = missing("en");
    const view = render(<NoPagePage door={door} />);
    expect(view.container.textContent).toContain("This page doesn’t exist");
    expect(view.container.textContent).toContain(doorsEn.gate.missingNote);
    expect(buttons()).toEqual([doorsEn.gate.missingHome.replace(/\.$/, "")]);
    fireEvent.click(screen.getByRole("button"));
    expect(home).toHaveBeenCalledTimes(1);
  });

  it("no server: says so, what this build runs, where the person's own mailboxes are, and opens the demo first", () => {
    const { door, acts } = noServer("en");
    const view = render(<NoPagePage door={door} />);
    expect(view.container.textContent).toContain(doorsEn.gate.lede.replace(/\.$/, ""));
    expect(view.container.textContent).toContain(
      "It runs the whole interface on demo mail, with no network at all.",
    );
    expect(view.container.textContent).toContain("Your own mailboxes are at ohmail.app.");
    expect(buttons()).toEqual([doorsEn.gate.openDemo, doorsEn.gate.signIn]);
    fireEvent.click(screen.getByRole("button", { name: doorsEn.gate.openDemo }));
    fireEvent.click(screen.getByRole("button", { name: doorsEn.gate.signIn }));
    expect([acts.demo.mock.calls.length, acts.signIn.mock.calls.length]).toEqual([1, 1]);
  });

  it("draws its words with no reader above it", () => {
    for (const locale of ["en", "de"] as const) {
      const view = render(<NoPagePage door={missing(locale).door} />);
      expect(view.getByRole("main").textContent).toContain(words[locale].missingNote);
      cleanup();
    }
  });

  it("says the German words it is handed", () => {
    render(<NoPagePage door={noServer("de").door} />);
    expect(buttons()).toEqual([doorsDe.gate.openDemo, doorsDe.gate.signIn]);
    expect(document.body.textContent).toContain(doorsDe.gate.body);
    expect(document.body.textContent).toContain(doorsDe.gate.note);
  });

  it("names its two states by the reference's address", () => {
    expect([...NO_PAGE_STATES]).toEqual(["missing", "noserver"]);
  });
});
