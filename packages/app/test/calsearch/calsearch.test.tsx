/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SearchView } from "../../src/calsearch/index.js";
import { actLog, ev, rangeInput, Words, type ActLog } from "../support/range-world.js";

afterEach(cleanup);

/** The route's words, as the frame would hold them. */
function Held({
  log,
  first = "",
  lang = "en" as "en" | "de",
  input = rangeInput(),
}: {
  log: ActLog;
  first?: string;
  lang?: "en" | "de";
  input?: ReturnType<typeof rangeInput>;
}) {
  const [q, setQ] = useState(first);
  return (
    <Words lang={lang}>
      <SearchView
        input={input}
        acts={log.acts}
        query={q}
        onQuery={setQ}
        held={{ from: "2026-05-10", to: "2027-05-09" }}
      />
    </Words>
  );
}

describe("Search", () => {
  it("a slip is forgiven and said as what it was read as; upcoming first", () => {
    const { container } = render(<Held log={actLog()} first="tehc check" />);
    expect(screen.getByText("tech check")).toBeTruthy();
    expect(screen.getByText("2 events")).toBeTruthy();
    expect([...container.querySelectorAll("h2")].map((h) => h.textContent)).toEqual([
      "Fri 20 Nov",
      "Fri 2 Oct",
    ]);
    expect(container.querySelector(".oh-erow-time")!.textContent).toBe("16:00–16:15");
  });
  it("finds by place and people too, and says the span it searched", () => {
    render(<Held log={actLog()} first="petra" />);
    expect(screen.getByText("Tech check, main hall")).toBeTruthy();
    expect(document.body.textContent).toContain("Searched from 10 May to 9 May 2027");
  });
  it("typing searches; Enter takes the person to the hit the keys stand on", () => {
    const log = actLog();
    render(<Held log={log} />);
    const field = screen.getByRole("searchbox", { name: "Search" });
    fireEvent.change(field, { target: { value: "tech" } });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.keyDown(field, { key: "ArrowUp" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(log.said).toEqual(["reveal old", "reveal tech"]);
  });
  it("lists the events on a typed date and opens that day from the first row", () => {
    const log = actLog();
    render(<Held log={log} first="20 nov" />);
    expect(screen.getByText("2 events")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Makersfest/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Tech check/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Go to a date/ })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
    expect(log.said).toEqual(["view day 2026-11-20"]);
  });
  it("lists text matches below the weekday shortcut", () => {
    const input = rangeInput();
    const time = input.events[0]!.start;
    render(
      <Held
        log={actLog()}
        first="wed"
        input={{ ...input, events: [...input.events, ev("wedding", "Wedding", time, time)] }}
      />,
    );
    expect(screen.getByRole("button", { name: /Wed 18 Nov.*Go to a date/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Poster review/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Wedding/ })).toBeTruthy();
  });
  it("opens the current Sunday for a bare Sunday query", () => {
    const log = actLog();
    render(<Held log={log} first="sun" input={rangeInput({ today: "2026-11-22" })} />);
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
    expect(log.said).toEqual(["view day 2026-11-22"]);
  });
  it("a press on a hit takes the person there", () => {
    const log = actLog();
    render(<Held log={log} first="poster" />);
    fireEvent.click(screen.getByRole("button", { name: /Poster review/ }));
    expect(log.said).toEqual(["reveal poster"]);
  });
  it("nothing found says so; clear empties the field", () => {
    render(<Held log={actLog()} first="marzipan" lang="de" />);
    expect(document.body.textContent).toContain("Nichts gefunden");
    fireEvent.click(screen.getByRole("button", { name: "Leeren" }));
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("Nichts gefunden");
  });
  it("its server markup holds a field and no form: a typed value goes nowhere before the script runs", () => {
    const html = renderToString(<Held log={actLog()} first="tech" />);
    expect(html).toContain("<input");
    expect(html).not.toContain("<form");
  });
});
