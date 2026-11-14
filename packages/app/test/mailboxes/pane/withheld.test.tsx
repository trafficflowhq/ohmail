/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NONE } from "../../../src/host/index.js";
import { fakeDoor } from "../connect/support.js";
import { A, B, M, NOW, drawPane, fakePane, ok, row, type PaneScript } from "./support.js";

/**
 * WHAT A SHELL MAY CHANGE, AND THE CONTROLS IT IS SHOWN. A verb the capability or a wire withholds is not in the
 * tree at all: never a disabled control a press would find refused.
 */
const ROWS = [row("mbx-a", A), row("mbx-b", B, { authKind: "oauth", provider: "microsoft" })];
const settle = (): Promise<void> => act(async () => {});
const open = (address: string): void =>
  void fireEvent.click(screen.getByRole("button", { name: new RegExp(address.replace(".", "\\.")) }));
const named = (name: string) => screen.queryAllByRole("button", { name });
const VERBS_THAT_CHANGE = [M.edit, M.remove, M.connect, M.oauthReconnect, M.setupAgainAction, M.organizeHere];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function drawn(
  capability: "here" | "resyncAndOut" | "resyncOnly",
  none: NonNullable<PaneScript["none"]> = [],
) {
  const pane = fakePane({ list: [ok(ROWS)], allowance: [ok({ emailVerified: true, access: null })], none });
  const door = fakeDoor({ ways: { microsoft: { redirect: true, device: false } } });
  drawPane(pane.wire, { capability, connect: door.door });
  await settle();
  open(A);
  open(B);
  return pane;
}

describe("the capability decides what the pane offers", () => {
  it("here: re-sync, edit, remove, connect and run again stand", async () => {
    await drawn("here");
    expect(named(M.syncNow)).toHaveLength(2);
    expect(named(M.edit)).toHaveLength(1);
    expect(named(M.remove)).toHaveLength(2);
    expect(named(M.connect)).toHaveLength(1);
    expect(named(M.setupAgainAction)).toHaveLength(1);
  });

  it("resyncAndOut: no control named edit, remove or connect is in the tree; the re-sync and the way out are", async () => {
    const pane = await drawn("resyncAndOut");
    for (const name of VERBS_THAT_CHANGE) expect(named(name), name).toHaveLength(0);
    expect(named(M.syncNow)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: M.desktopOpenSetup }));
    expect(pane.outs).toHaveLength(1);
  });

  it("resyncOnly: the re-sync alone", async () => {
    await drawn("resyncOnly");
    for (const name of [...VERBS_THAT_CHANGE, M.desktopOpenSetup]) expect(named(name), name).toHaveLength(0);
    expect(named(M.syncNow)).toHaveLength(2);
  });

  it("a press on the re-sync under resyncOnly reaches the re-sync and nothing else", async () => {
    const pane = await drawn("resyncOnly");
    fireEvent.click(named(M.syncNow)[0]!);
    await settle();
    expect(pane.writes().map((c) => c.verb)).toEqual(["resync"]);
  });
});

describe("a wire member at none is not drawn", () => {
  it("no remove: no Remove on any row", async () => {
    await drawn("here", ["remove"]);
    expect(named(M.remove)).toHaveLength(0);
    expect(named(M.syncNow)).toHaveLength(2);
  });

  it("no connect wire: no connect, no edit and no reconnect, whatever the capability says", async () => {
    const pane = fakePane({ list: [ok(ROWS)], allowance: [ok({ emailVerified: true, access: null })] });
    drawPane(pane.wire, { capability: "here", connect: NONE });
    await settle();
    open(A);
    open(B);
    for (const name of [M.edit, M.connect, M.oauthReconnect]) expect(named(name), name).toHaveLength(0);
    expect(named(M.remove)).toHaveLength(2);
  });

  it("no wire at all: the pane draws nothing", async () => {
    const { container } = drawPane(NONE, { capability: "here" });
    await settle();
    expect(container.textContent).toBe("");
  });
});
