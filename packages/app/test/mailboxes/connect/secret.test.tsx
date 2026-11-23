/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectKept, ConnectTyped } from "@ohmail/app-logic/mailboxes/connect/types";
import { NONE, type ConnectWire } from "../../../src/host/index.js";
import { ConnectForm } from "../../../src/mailboxes/connect/index.js";
import { TextProvider } from "../../../src/text/index.js";
import {
  J,
  M,
  MARKER,
  P,
  REFUSED_PASSWORD,
  WINDOW_CLOSED,
  WORDS,
  draw,
  fakeDoor,
  id,
  no,
  noEncryption,
  refusal,
  type Call,
  MICROSOFT,
} from "./support.js";

/**
 * WHERE A TYPED PASSWORD IS, AND WHERE IT NEVER IS. A marker password is walked through success, every kind of
 * refusal, the second factor, a sign-in's leave, unmount and the kept holder. It may stand in the one password field
 * and in the `pass` of a body handed to the wire. Everything else a page can write to is watched, and must stay clean.
 */
const ADDRESS = "me@lichtgrat.example";
const A = "mail-a.home.arpa";
const CONNECTED = { ok: true as const, value: { mailboxId: id("mbx-new"), address: ADDRESS } };
const type = (label: string, value: string): void =>
  void fireEvent.change(screen.getByLabelText(label), { target: { value } });
const press = (name: string): void => void fireEvent.click(screen.getByRole("button", { name }));
const settle = (): Promise<void> => act(async () => {});

/** Everything written to a sink, as text. */
let written: string[] = [];
/** A call that must never happen: the form fetches nothing and navigates nowhere by itself. */
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
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(record("storage"));
  vi.spyOn(window.history, "pushState").mockImplementation(record("history"));
  vi.spyOn(window.history, "replaceState").mockImplementation(record("history"));
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const)
    vi.spyOn(console, method).mockImplementation(record(`console.${method}`));
  vi.stubGlobal("fetch", vi.fn(never("fetch")));
  vi.stubGlobal("XMLHttpRequest", vi.fn(never("XMLHttpRequest")));
  vi.stubGlobal("WebSocket", vi.fn(never("WebSocket")));
  vi.stubGlobal("EventSource", vi.fn(never("EventSource")));
  vi.stubGlobal("Image", vi.fn(never("Image")));
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: vi.fn(never("sendBeacon")) });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(record("clipboard")), readText: vi.fn(never("clipboard.readText")) },
  });
  vi.spyOn(window, "open").mockImplementation(never("window.open") as never);
  vi.spyOn(window, "postMessage").mockImplementation(record("postMessage"));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The page as markup, and every field's value: the marker may be the value of one password field, and nothing else. */
function onThePage(): { markup: boolean; fields: string[] } {
  const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")]
    .filter((field) => field.value.includes("MARKER"))
    .map((field) => field.getAttribute("type") ?? "text");
  return { markup: document.documentElement.outerHTML.includes("MARKER"), fields };
}
/** A recorded call with every `pass` taken out: what is left must not hold the marker. */
function besidesPass(call: Call): string {
  return JSON.stringify(call.sent, (key, value: unknown) => (key === "pass" ? undefined : value)) ?? "";
}
function clean(calls: readonly Call[]): void {
  expect(written.filter((line) => line.includes("MARKER"))).toEqual([]);
  // The form persists nothing of itself and writes no address: not a typed word, not a step, not a provider.
  expect(written.filter((line) => /^(storage|history|postMessage|clipboard):/.test(line))).toEqual([]);
  expect(reached).toEqual([]);
  for (const call of calls) {
    expect(besidesPass(call)).not.toContain("MARKER");
    expect(call.sealed).not.toContain("MARKER");
  }
}
function fill(): void {
  type(J.mailboxAddress, ADDRESS);
  press(P.otherLabel);
  type(J.imapHost, A);
  type(J.smtpHost, A);
  type(J.appPasswordLabel, MARKER);
}

describe("a typed password", () => {
  it("stands in the one field and in the bodies' `pass`, through a refusal, a consent, the factor and the connect; then it is gone", async () => {
    const helped: unknown[] = [];
    let held: ConnectTyped | null = null;
    const kept: ConnectKept = { read: () => held, write: (typed) => void (held = typed) };
    const { door, calls } = fakeDoor({
      connect: [REFUSED_PASSWORD, noEncryption("imap"), WINDOW_CLOSED, CONNECTED],
    });
    const view = draw(door, {
      purpose: { kind: "join" },
      kept,
      later: () => undefined,
      help: (facts) => void helped.push(facts),
    });
    fill();
    expect(onThePage()).toEqual({ markup: false, fields: ["password"] });

    press(J.manualConnect);
    await settle();
    expect(screen.getByText(M.probe_auth)).toBeTruthy();
    expect(onThePage()).toEqual({ markup: false, fields: ["password"] });
    press("Setup");
    fireEvent.click(screen.getByRole("menuitem", { name: J.mailboxWriteUs }));
    expect(helped).toEqual([{ provider: "imap", reason: "auth" }]);

    press(J.manualConnect);
    await settle();
    fireEvent.click(screen.getByRole("switch", { name: M.insecureConsentLabelBoth }));
    press(J.manualConnect);
    await settle();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(JSON.stringify(view.asks.map((ask) => ask.line))).not.toContain("MARKER");
    expect(onThePage()).toEqual({ markup: false, fields: ["password"] });

    press("verify");
    await settle();
    expect(view.done).toEqual([
      { kind: "connected", mailboxId: id("mbx-new"), address: ADDRESS, created: true },
    ]);
    expect(onThePage()).toEqual({ markup: false, fields: [] });
    expect(JSON.stringify([view.done, helped, held])).not.toContain("MARKER");
    expect(calls.filter((call) => call.verb === "connect")).toHaveLength(4);
    clean(calls);
  });

  it("is in no sentence: a server's words that repeat what was sent are not drawn", async () => {
    const echo = no(
      refusal("a_code_nobody_words", {}, 409, `The login me with password ${MARKER} was refused.`),
    );
    const { door, calls } = fakeDoor({ connect: [echo] });
    draw(door, { purpose: { kind: "join" } });
    fill();
    press(J.manualConnect);
    await settle();
    expect(screen.getByText(M.probe_unknown)).toBeTruthy();
    expect(onThePage()).toEqual({ markup: false, fields: ["password"] });
    clean(calls);
  });

  it("is not held once its field is no longer drawn: taking the provider's sign-in drops it, and the leave carries nothing typed", async () => {
    const { door, calls, of } = fakeDoor({
      ways: { microsoft: { redirect: true, device: false } },
      start: [{ ok: true, value: "leaving" }],
    });
    draw(door, { purpose: { kind: "join" } });
    await settle();
    type(J.mailboxAddress, ADDRESS);
    press(MICROSOFT);
    press(M.microsoftUseAppPassword);
    type(J.appPasswordLabel, MARKER);
    expect(onThePage()).toEqual({ markup: false, fields: ["password"] });
    press(MICROSOFT);
    expect(onThePage()).toEqual({ markup: false, fields: [] });
    press(M.oauthContinue);
    await settle();
    expect(of("start")).toHaveLength(1);
    press(M.microsoftUseAppPassword);
    expect((screen.getByLabelText(J.appPasswordLabel) as HTMLInputElement).value).toBe("");
    clean(calls);
  });

  it("the sign-in offered beside a refused password leaves with no password held: the field is empty before the shell is asked to leave", async () => {
    const { door, calls, of } = fakeDoor({
      ways: { microsoft: { redirect: true, device: false } },
      connect: [REFUSED_PASSWORD],
      start: [{ ok: true, value: "leaving" }],
    });
    if (door.signIn === NONE) throw new Error("this wire signs in");
    const signIn = door.signIn;
    /* What the page holds at the moment the shell is asked to leave for the provider. */
    const atTheLeave: ReturnType<typeof onThePage>[] = [];
    const leaving: ConnectWire = {
      ...door,
      signIn: { ...signIn, start: (ask) => (atTheLeave.push(onThePage()), signIn.start(ask)) },
    };
    draw(leaving, { purpose: { kind: "join" } });
    await settle();
    type(J.mailboxAddress, ADDRESS);
    press(MICROSOFT);
    press(M.microsoftUseAppPassword);
    type(J.appPasswordLabel, MARKER);
    press(J.connectMailbox);
    await settle();
    // The provider refused the password; its own sign-in stands beside the refusal, one press.
    press(M.oauthContinue);
    await settle();
    expect(of("start")).toHaveLength(1);
    const field = screen.queryByLabelText(J.appPasswordLabel) as HTMLInputElement | null;
    expect({ leaving: of("start").length, heldInField: (field?.value ?? "").includes("MARKER") }).toEqual({
      leaving: 1,
      heldInField: false,
    });
    expect(atTheLeave).toEqual([{ markup: false, fields: [] }]);
    clean(calls);
  });

  it("leaves with the form: unmounted, nothing of it was stored, said or handed on, and the kept words never held it", async () => {
    let held: ConnectTyped | null = null;
    const kept: ConnectKept = { read: () => held, write: (typed) => void (held = typed) };
    const { door, calls } = fakeDoor({ connect: [WINDOW_CLOSED] });
    const view = draw(door, { purpose: { kind: "join" }, kept });
    fill();
    press(J.manualConnect);
    await settle();
    view.unmount();
    expect(document.documentElement.outerHTML).not.toContain("MARKER");
    expect(JSON.stringify(held)).not.toContain("MARKER");
    expect(held).toMatchObject({ address: ADDRESS });
    // The factor of the form that left runs nothing.
    act(() => view.asks.at(-1)!.onVerified());
    await settle();
    expect(calls.filter((call) => call.verb === "connect")).toHaveLength(1);
    clean(calls);
  });

  it("on an edit, saved, it is gone from the field too", async () => {
    const subject = {
      id: id("mbx-7"),
      address: "old@lichtgrat.example",
      provider: "imap",
      signsIn: "password",
    } as const;
    const { door, calls } = fakeDoor({ edit: [REFUSED_PASSWORD, { ok: true, value: null }] });
    const view = draw(door, { purpose: { kind: "edit", mailbox: subject } });
    type(M.passwordLabel, MARKER);
    press(M.continue);
    await settle();
    expect(onThePage()).toEqual({ markup: false, fields: ["password"] });
    press(M.continue);
    await settle();
    expect(view.done).toEqual([{ kind: "saved", mailboxId: id("mbx-7") }]);
    expect(onThePage()).toEqual({ markup: false, fields: [] });
    clean(calls);
  });
});

describe("the form's markup", () => {
  it("names no field, so a press before the page's script sends nothing typed; the password field is a password field the browser does not fill", () => {
    const { door } = fakeDoor();
    const markup = renderToString(
      <TextProvider locale="en" messages={WORDS as never} timeZone="UTC">
        <ConnectForm
          ask={{
            purpose: {
              kind: "edit",
              mailbox: {
                id: id("mbx-7"),
                address: "old@lichtgrat.example",
                provider: "imap",
                signsIn: "password",
              },
            },
            onDone: () => undefined,
          }}
          door={door}
          factor={NONE}
        />
      </TextProvider>,
    );
    const page = new DOMParser().parseFromString(markup, "text/html");
    const fields = [...page.querySelectorAll("input")];
    expect(fields.length).toBeGreaterThan(1);
    expect(fields.filter((field) => field.hasAttribute("name"))).toEqual([]);
    const passwords = fields.filter((field) => field.getAttribute("type") === "password");
    expect(passwords).toHaveLength(1);
    expect(passwords[0]!.getAttribute("autocomplete")).toBe("off");
    expect(passwords[0]!.getAttribute("value") ?? "").toBe("");
    expect(page.querySelectorAll("form[action], form[method]")).toHaveLength(0);
  });

  it("the typed password is in no markup: not while it is typed, not after a refused press, not after the connect, and its field carries no value attribute", async () => {
    const { door } = fakeDoor({ connect: [REFUSED_PASSWORD, CONNECTED] });
    draw(door, { purpose: { kind: "join" } });
    const inMarkup = (): boolean => document.documentElement.outerHTML.includes("MARKER");
    const field = (): HTMLInputElement => screen.getByLabelText(J.appPasswordLabel) as HTMLInputElement;
    const before = inMarkup();
    fill();
    const typed = [inMarkup(), field().hasAttribute("value"), field().value === MARKER];
    press(J.manualConnect);
    await settle();
    const refused = [inMarkup(), field().hasAttribute("value"), field().value === MARKER];
    press(J.manualConnect);
    await settle();
    // What was typed is looked for and never printed: each reading is a yes or a no.
    expect({ before, typed, refused, connected: inMarkup() }).toEqual({
      before: false,
      typed: [false, false, true],
      refused: [false, false, true],
      connected: false,
    });
  });

  it("asks nothing of the network and of no other origin while it is drawn and typed in: no picture, no link, no frame", async () => {
    const { door } = fakeDoor({ discover: "none" });
    draw(door, { purpose: { kind: "add" } });
    await settle();
    type("Mailbox address", ADDRESS);
    press(P.otherLabel);
    type("Incoming server (IMAP)", "169.254.169.254");
    type("Outgoing server (SMTP)", "localhost:25");
    await settle();
    expect(reached).toEqual([]);
    expect(
      document.querySelectorAll("img, iframe, link, script, object, embed, a[href^='http']"),
    ).toHaveLength(0);
  });
});
