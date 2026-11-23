/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirstRunGround } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { Frame } from "../../src/frame/Frame.js";
import { NONE, type HostCapabilities } from "../../src/host/index.js";
import { firstRunStage, type FirstRunSlots } from "../../src/mailboxes/first-run/index.js";
import { TextProvider } from "../../src/text/index.js";
import frame from "../../messages/frame.en.json" with { type: "json" };
import screener from "../../messages/screener.en.json" with { type: "json" };
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, movable } from "../support/fake-window.js";
import {
  M,
  MARKER,
  O,
  P,
  REFUSED_PASSWORD,
  WORDS,
  factorButtons,
  fakeDoor,
  id,
  type Call,
} from "./connect/support.js";
import { A as ADDRESS, drawPane, fakePane, ok, row } from "./pane/support.js";

/**
 * WHERE A TYPED PASSWORD IS IN THE FORM'S TWO OTHER MOUNTS: an edit in an opened row of the Mailboxes pane, and the
 * first run's mailbox step. The form's own cases walk every state of it; these walk the mounts around it. A marker
 * password may stand in the one password field and in the `pass` of a body handed to the connect wire. The pane's own
 * wire, the first run's verbs, the run's address, both stores, the console and the page's markup never hold it.
 */
const settle = (): Promise<void> => act(async () => {});
const words = (text: string): RegExp => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const press = (name: string | RegExp): void => void fireEvent.click(screen.getByRole("button", { name }));
const type = (label: string, value: string): void =>
  void fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** Everything written to a sink, as text. */
let written: string[] = [];
let reached: string[] = [];
const record =
  (sink: string) =>
  (...args: unknown[]): void => {
    written.push(
      `${sink}: ${args.map((arg) => (typeof arg === "string" ? arg : (JSON.stringify(arg) ?? String(arg)))).join(" ")}`,
    );
  };
const never =
  (name: string) =>
  (..._args: unknown[]): never => {
    reached.push(name);
    throw new Error(`${name} was reached`);
  };

beforeEach(() => {
  written = [];
  reached = [];
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(record("storage"));
  vi.spyOn(window.history, "pushState").mockImplementation(record("history"));
  vi.spyOn(window.history, "replaceState").mockImplementation(record("history"));
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const)
    vi.spyOn(console, method).mockImplementation(record(`console.${method}`));
  vi.stubGlobal("fetch", vi.fn(never("fetch")));
  vi.stubGlobal("XMLHttpRequest", vi.fn(never("XMLHttpRequest")));
  vi.stubGlobal("WebSocket", vi.fn(never("WebSocket")));
  vi.stubGlobal("Image", vi.fn(never("Image")));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The fields that hold the marker, by their kind, and whether the page's markup does. */
function onThePage(): { markup: boolean; fields: string[] } {
  const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")]
    .filter((field) => field.value.includes("MARKER"))
    .map((field) => field.getAttribute("type") ?? "text");
  return { markup: document.documentElement.outerHTML.includes("MARKER"), fields };
}
/** A recorded call of the connect wire with every `pass` taken out. */
const besidesPass = (call: Call): string =>
  JSON.stringify(call.sent, (key, value: unknown) => (key === "pass" ? undefined : value)) ?? "";
/** The sinks are clean, the connect wire holds the marker in a `pass` alone, and what a mount itself called never does. */
function clean(calls: readonly Call[], mounts: unknown): void {
  expect(written.filter((line) => line.includes("MARKER"))).toEqual([]);
  expect(reached).toEqual([]);
  for (const call of calls) {
    expect(besidesPass(call)).not.toContain("MARKER");
    expect(call.sealed).not.toContain("MARKER");
  }
  expect(JSON.stringify(mounts) ?? "").not.toContain("MARKER");
}

describe("a password typed for an edit, in an opened row of the Mailboxes pane", () => {
  it("is in the one field and in the patch's `pass`, through a refusal and the save; the pane's own wire never holds it", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const door = fakeDoor({ edit: [REFUSED_PASSWORD, ok(null)] });
    const allowed = ok({ emailVerified: true, access: null });
    const pane = fakePane({
      list: [ok([row("mbx-a", ADDRESS)]), ok([row("mbx-a", ADDRESS)])],
      allowance: [allowed, allowed, allowed],
    });
    const view = drawPane(pane.wire, { connect: door.door, opened: "mbx-a" });
    await settle();
    press(M.edit);
    type(M.passwordLabel, MARKER);
    expect(onThePage()).toEqual({ markup: false, fields: ["password"] });

    press(M.continue);
    await settle();
    // Refused: the stored login stands, and what was typed stays in its field alone.
    expect(door.of("edit")).toHaveLength(1);
    expect(onThePage()).toEqual({ markup: false, fields: ["password"] });
    clean(door.calls, [pane.calls, view.drained, view.went]);

    press(M.continue);
    await settle();
    expect(door.of("edit")).toHaveLength(2);
    expect((door.of("edit")[1]!.sent as { patch: { imap: { pass: string } } }).patch.imap.pass).toBe(MARKER);
    // Saved: the form left its row, and the password went with its field.
    expect(onThePage()).toEqual({ markup: false, fields: [] });
    clean(door.calls, [pane.calls, view.drained, view.went]);
  });
});

describe("a password typed at the first run's mailbox step", () => {
  const MESSAGES = { ...WORDS, ...frame, ...screener } as never;
  const HOST_A = "mail-a.home.arpa";
  const HOST_B = "mail-b.home.arpa";

  it("is in the one field and in the bodies' `pass`, through a test, a refusal and the connect; the run's verbs and its address never hold it", async () => {
    const door = fakeDoor({
      probe: [{ ok: true, value: { host: HOST_A, user: ADDRESS, folders: 3 } }],
      connect: [REFUSED_PASSWORD, { ok: true, value: { mailboxId: id("mbx-2"), address: null } }],
    });
    const verbs = {
      ai: "unset" as const,
      probe: vi.fn(() => new Promise(() => {})),
      connect: vi.fn(() => new Promise(() => {})),
      organize: vi.fn(async () => "stored"),
      complete: vi.fn(async () => {}),
      setAiEnabled: vi.fn(async () => {}),
      probeMessage: () => null,
    };
    const ground: FirstRunGround = {
      rows: [],
      account: { onboardingCompletedAt: null },
      accountOrganizer: null,
      about: () => ({
        queuedSenders: 0,
        pull: { screened: 0, history: 0, pulled: 0, whole: false },
        sender: null,
        queueSettling: false,
        rereadQueue: async () => {},
      }),
      refresh: async () => {},
      drawn: () => {},
    };
    const facts = movable(ground);
    const seen = { asks: [] as Parameters<NonNullable<Exclude<FirstRunSlots["factor"], typeof NONE>>>[0][] };
    function useGround(): FirstRunGround {
      return useSyncExternalStore(facts.subscribe, facts.read);
    }
    const slots: FirstRunSlots = {
      factor: factorButtons(seen),
      pair: NONE,
      aiProvider: NONE,
      calendar: NONE,
      ground: useGround,
    };
    const made = fakeHost({
      engine: NO_ENGINE,
      service: "self",
      scope: "acct-1",
      stages: { firstRun: firstRunStage(slots) },
      address: fakeAddress("#/first-run/add"),
    });
    const capabilities: HostCapabilities = { ...made.host.capabilities, firstRunDoor: "cloud" };
    const host = {
      ...made.host,
      capabilities,
      wires: { ...made.host.wires, firstRun: verbs, connect: door.door },
    };
    render(
      <TextProvider locale="en" messages={MESSAGES} timeZone="UTC">
        <Frame host={host} />
      </TextProvider>,
    );
    await settle();
    type(O.address, ADDRESS);
    press(words(P.otherShort));
    type(O.imapHost, HOST_A);
    type(O.smtpHost, HOST_B);
    type(O.password, MARKER);
    expect(onThePage()).toEqual({ markup: false, fields: ["password"] });
    const mounts = (): unknown => [
      made.address.writes,
      verbs.organize.mock.calls,
      verbs.probe.mock.calls,
      verbs.connect.mock.calls,
      seen.asks.map((ask) => ask.line),
    ];

    press(words(O.test));
    await settle();
    expect(door.of("probe")).toHaveLength(1);
    expect(onThePage()).toEqual({ markup: false, fields: ["password"] });
    clean(door.calls, mounts());

    press(words(O.connect));
    await settle();
    // Refused: what was typed stays where it was typed.
    expect(door.of("connect")).toHaveLength(1);
    expect(onThePage()).toEqual({ markup: false, fields: ["password"] });
    clean(door.calls, mounts());

    press(words(O.connect));
    await settle();
    expect(door.of("connect").map((c) => (c.sent as { mode: string }).mode)).toEqual(["add", "add"]);
    expect((door.of("connect")[1]!.sent as { input: { imap: { pass: string } } }).input.imap.pass).toBe(
      MARKER,
    );
    // Connected: the run's address names the new row, the step waits for it, and the password is in no field.
    expect(made.address.writes).toEqual([{ next: "#/first-run/add?mailbox=mbx-2", how: "replace" }]);
    expect(onThePage()).toEqual({ markup: false, fields: [] });
    // The old first-run verbs were never the form's way out.
    expect(verbs.probe.mock.calls).toEqual([]);
    expect(verbs.connect.mock.calls).toEqual([]);
    clean(door.calls, mounts());
  });
});
