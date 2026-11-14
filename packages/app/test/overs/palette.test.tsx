/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useKeyBindings } from "@ohmail/app-logic/keys";
import { usePaletteOffers } from "../../src/frame/commands.js";
import type { PaletteOffer } from "../../src/frame/contract.js";
import { mountOvers, press } from "./over-world.js";

/**
 * THE PALETTE, mounted alone over the fake host: `mod+k` opens it, it lists every product's offers (the one on screen
 * first), narrows them word by word, prints a row's keys only while the registry holds its chord, and runs the one
 * chosen once. A disabled row neither runs nor closes it.
 */
const ran: string[] = [];
const offer = (id: string, label: string, more: Partial<PaletteOffer> = {}): PaletteOffer => ({
  id,
  label,
  icon: "search",
  run: () => ran.push(id),
  ...more,
});

function Mail() {
  usePaletteOffers(
    "mail",
    [
      offer("mail.compose", "New message", { chord: "c" }),
      offer("mail.search", "Search everything", { chord: "/" }),
      offer("mail.layout", "Switch layout", { disabled: true }),
    ],
    true,
  );
  /* `c` is declared; nobody holds `/`. */
  useKeyBindings([{ chord: "c", group: "message", label: "Write", run: () => undefined }]);
  return null;
}
function Calendar() {
  usePaletteOffers("calendar", [offer("calendar.today", "Go to today")], false);
  return null;
}

const open = () => act(() => press("k", { ctrlKey: true }));
const rows = () => within(screen.getByRole("listbox")).getAllByRole("option");
const line = () => screen.getByRole("combobox");

beforeEach(() => {
  ran.length = 0;
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => cleanup());

describe("the palette", () => {
  it("opens on its own key, the product on screen first", () => {
    mountOvers(() => (
      <>
        <Calendar />
        <Mail />
      </>
    ));
    expect(screen.queryByRole("listbox")).toBeNull();
    open();
    expect(rows().map((r) => r.textContent?.replace(/[^A-Za-z ]/g, "").trim())).toEqual([
      "New messagec",
      "Search everything",
      "Switch layout",
      "Go to today",
    ]);
  });

  it("prints a row's keys only while the registry holds its chord", () => {
    mountOvers(() => <Mail />);
    open();
    const [compose, search] = rows();
    expect(within(compose!).queryByText("c")).not.toBeNull();
    expect(within(search!).queryByText("/")).toBeNull();
  });

  it("narrows word by word, and the line is empty at every open", () => {
    mountOvers(() => (
      <>
        <Mail />
        <Calendar />
      </>
    ));
    open();
    fireEvent.change(line(), { target: { value: "everything search" } });
    expect(rows()).toHaveLength(1);
    act(() => press("Escape", {}, line()));
    expect(screen.queryByRole("listbox")).toBeNull();
    open();
    expect((line() as HTMLInputElement).value).toBe("");
  });

  it("runs the chosen offer once and closes; a disabled one neither runs nor closes", () => {
    mountOvers(() => <Mail />);
    open();
    fireEvent.click(rows()[2]!);
    expect(ran).toEqual([]);
    expect(screen.queryByRole("listbox")).not.toBeNull();
    fireEvent.change(line(), { target: { value: "new" } });
    act(() => press("Enter", {}, line()));
    expect(ran).toEqual(["mail.compose"]);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("lists an id once when two parts hand it", () => {
    function Writer() {
      usePaletteOffers("mail", [offer("mail.compose", "Write a letter")], true);
      return null;
    }
    mountOvers(() => (
      <>
        <Mail />
        <Writer />
      </>
    ));
    open();
    expect(rows().filter((r) => /New message|Write a letter/.test(r.textContent ?? ""))).toHaveLength(1);
  });

  it("an offer disabled by the press neither runs nor closes", () => {
    let busy = false;
    function Sender() {
      usePaletteOffers(
        "mail",
        [
          {
            id: "mail.send",
            label: "Send",
            icon: "search",
            get disabled() {
              return busy;
            },
            run: () => ran.push("mail.send"),
          },
        ],
        true,
      );
      return null;
    }
    mountOvers(() => <Sender />);
    open();
    busy = true;
    act(() => press("Enter", {}, line()));
    expect(ran).toEqual([]);
    expect(screen.queryByRole("listbox")).not.toBeNull();
  });

  it("closes on its own key pressed inside it", () => {
    mountOvers(() => <Mail />);
    open();
    act(() => press("k", { ctrlKey: true }, line()));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(ran).toEqual([]);
  });
});
