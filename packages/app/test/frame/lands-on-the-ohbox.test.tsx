/** @vitest-environment jsdom */
/**
 * AN ADDRESS THAT NAMES A PLACE THIS HOST DOES NOT HAND. Nothing of that place exists here: no entry in the rail, no
 * page in its stead. The address (a stored link, a notice's link, a typed one) is replaced by the Ohbox's, so the
 * person stands somewhere and Back does not lead to the dead address again. A host that hands no Ohbox either is
 * left as it is.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import type { FramePlaces, PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

function List({ route }: PaneProps) {
  return <p>the list of {route.place}</p>;
}
function Reading({ route }: PaneProps) {
  return <p>reading {route.open ?? "nothing"}</p>;
}
const columns = (id: PlaceEntry["id"]): PlaceEntry => ({
  id,
  body: id,
  rail: null,
  panes: { kind: "columns", List, Reading },
});

function mount(at: string, places: Partial<FramePlaces>) {
  const made = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    window: fakeWindow("desktop"),
    address: fakeAddress(at),
    places,
  });
  render(
    <TextProvider locale="en" messages={FRAME_WORDS.en} timeZone="Europe/Zurich">
      <Frame host={made.host} />
    </TextProvider>,
  );
  return made;
}

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

const MAIL = { ohbox: columns("ohbox"), news: columns("news") };

describe("an address that names a place the host does not hand", () => {
  it("is replaced by the Ohbox's at the first paint, and the Ohbox stands", () => {
    const { address } = mount("#/history", MAIL);
    expect(address.read()).toBe("#/ohbox");
    expect(address.writes).toEqual([{ next: "#/ohbox", how: "replace" }]);
    expect(screen.getByText("the list of ohbox")).toBeTruthy();
  });

  it("is replaced when a person arrives there later, and the letter the link named is dropped with it", () => {
    const { address } = mount("#/reads", MAIL);
    expect(address.writes).toEqual([]);
    act(() => address.visit("#/trash/m/x1"));
    expect(address.read()).toBe("#/ohbox");
    expect(address.writes).toEqual([{ next: "#/ohbox", how: "replace" }]);
    expect(screen.getByText("the list of ohbox")).toBeTruthy();
    expect(screen.getByText("reading nothing")).toBeTruthy();
    act(() => address.visit("#/settings/mailboxes"));
    expect(address.read()).toBe("#/ohbox");
  });

  it("leaves a place the host hands where it is", () => {
    const { address } = mount("#/reads/m/n1", MAIL);
    expect(address.writes).toEqual([]);
    expect(screen.getByText("the list of news")).toBeTruthy();
    expect(screen.getByText("reading n1")).toBeTruthy();
  });

  it("on a host that hands no Ohbox the address stays, and nothing is drawn in its place", () => {
    const { address } = mount("#/history", { news: columns("news") });
    expect(address.read()).toBe("#/history");
    expect(address.writes).toEqual([]);
    expect(screen.queryByText(/the list of/)).toBeNull();
  });
});

describe("the address says what the frame shows", () => {
  it.each(["#/bogus", "#/tag/"])("replaces %s with the Ohbox when it opens", (at) => {
    const { address } = mount(at, MAIL);
    expect(screen.getByText("the list of ohbox")).toBeTruthy();
    expect(address.read()).toBe("#/ohbox");
    expect(address.writes).toEqual([{ next: "#/ohbox", how: "replace" }]);
  });

  it("trims an irrelevant query while keeping the letter opened by the link", () => {
    const { address } = mount("#/ohbox", MAIL);
    act(() => address.visit("#/reads/m/n1?mailbox=mb-2"));
    expect(screen.getByText("reading n1")).toBeTruthy();
    expect(address.read()).toBe("#/reads/m/n1");
    expect(address.writes).toEqual([{ next: "#/reads/m/n1", how: "replace" }]);
  });

  it.each(["", "#"])("leaves an empty address %j alone", (at) => {
    const { address } = mount(at, MAIL);
    expect(screen.getByText("the list of ohbox")).toBeTruthy();
    expect(address.writes).toEqual([]);
  });
});
