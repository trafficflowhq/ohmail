/** @vitest-environment jsdom */
/**
 * THE PHONE'S CONNECT WIRE, and where a mailbox's password is on the door's page. The wire is driven alone over a
 * door double, then under the one connect form over the page's real bridge and a native double that reads every
 * message through the door's own guard. A marker password is walked through a refusal that repeats it and through
 * the connect: it may stand in the one password field and in the body of `open`, once a press, and nowhere else a
 * page can write to. The same watch stands over a typed pairing code and a pasted link, as far as the page's bridge
 * carries them, and over the ways in drawn on the page's real door: the one place where the page meets the bridge.
 * There, too, no press leads to a page the door does not draw.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement as h, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectForm, type ConnectResult } from "@ohmail/app/mailboxes/connect";
import { NONE } from "@ohmail/app/host";
import { TextProvider } from "@ohmail/app/text";
import { providerById } from "@ohmail/app-logic/mailboxes/connect/providers";
import { NO_DETAILS } from "@ohmail/app-logic/mailboxes/connect/refusal";
import { secretOf } from "@ohmail/app-logic/mailboxes/connect/secret";
import { senderNameOf } from "@ohmail/app-logic/mailboxes/connect/sender-name";
import type { ConnectInput } from "@ohmail/app-logic/mailboxes/connect/types";
import account from "../../../packages/app/messages/account.en.json";
import doors from "../../../packages/app/messages/doors.en.json";
import mailboxes from "../../../packages/app/messages/mailboxes.en.json";
import phone from "../../../packages/app/messages/phone.en.json";
import { readDoorRequest, type DoorConfig, type DoorRequest, type DoorRequests } from "../src/shell/door-kinds";
import { Joiner } from "../src/shell/framing";
import { senderNameOf as senderNameOfOldPath } from "../src/ui/standalone-form";
import { BridgeRefused } from "../web/src/channel";
import { createDoorBridge } from "../web/src/door/bridge";
import { OPEN_DEADLINE_MS, OPEN_PORTS, phoneConnectWire, type OpensMailbox } from "../web/src/door/connect-wire";
import { doorHandle, type DoorHandle } from "../web/src/door/handle";
import { PAIR_DEADLINE_MS, pages } from "../web/src/door/pages";
import type { PagePort } from "../web/src/port";

type Open = DoorRequests["open"];
/** A value no sentence holds, with what a hostile password holds: a quote, markup, an apostrophe. */
const MARKER = "zq-MARKER-pass-7Kd!\"<b>'";
const TYPED = "zq-MARKER-code-4Lr8nWb3";
const LINK = "https://192.168.1.20:8443/pair#k1.KKKK.zq-MARKER-link-9Tk5vQd1";
const ADDRESS = "ada@lichtgrat.example";
const F = phone.phoneDoor.form;
const WAYS = phone.phoneDoor;
const R: Record<string, string> = phone.phoneRefusal;
const P = mailboxes.providerPicker;
const WORDS = { ...account, ...doors, ...mailboxes, ...phone };

const input = (over: Partial<ConnectInput> = {}): ConnectInput => ({
  address: ADDRESS,
  provider: "imap",
  imap: { host: "mail.lichtgrat.example", port: 1993, user: ADDRESS, pass: secretOf(MARKER) },
  smtp: { host: "smtp.lichtgrat.example", port: 2587, user: ADDRESS, pass: secretOf(MARKER) },
  ...over,
});

/** A door that answers `open` as the case says and keeps what it was asked. */
function doorOf(answers: (Open["answer"] | Error)[]) {
  const asked: { kind: string; ask: Open["ask"]; opts: unknown }[] = [];
  const door: OpensMailbox = {
    ask: async (kind, ask, opts) => {
      asked.push({ kind, ask, opts });
      const next = answers.shift();
      if (next === undefined) return new Promise<never>(() => {});
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { door, asked };
}

describe("the phone's connect wire", () => {
  it("builds the one body of `open` from the form's: the address, the password opened, the name, each server and its port, and nothing else", async () => {
    const { door, asked } = doorOf([{ ok: true, mailboxId: "engine-account" }]);
    const body = input({
      displayName: "Ada Lovelace",
      imap: { host: "mail.lichtgrat.example", port: 1993, secure: true, user: "another-login", pass: secretOf(MARKER), allowInsecure: true },
    });
    expect(await phoneConnectWire(door).connect(body, "seed")).toEqual({
      ok: true,
      value: { mailboxId: "engine-account", address: null },
    });
    expect(asked).toEqual([
      {
        kind: "open",
        ask: {
          input: {
            address: ADDRESS,
            pass: MARKER,
            name: "Ada Lovelace",
            imap: { host: "mail.lichtgrat.example", port: 1993 },
            smtp: { host: "smtp.lichtgrat.example", port: 2587 },
          },
        },
        opts: { deadlineMs: OPEN_DEADLINE_MS },
      },
    ]);
    // What native's own guard reads as an `open`, field for field.
    expect(readDoorRequest({ id: 1, epoch: "e1", kind: "open", ask: asked[0]!.ask })).toMatchObject({ kind: "open" });
    expect(OPEN_DEADLINE_MS).toBeGreaterThan(60_000);
  });

  it("names no name where none was typed, no outgoing server where the body has none, and the usual port where a server was named without one", async () => {
    const { door, asked } = doorOf([{ ok: true, mailboxId: "engine-account" }, { ok: true, mailboxId: "engine-account" }]);
    const wire = phoneConnectWire(door);
    const { smtp: _none, ...incomingOnly } = input();
    await wire.connect({ ...incomingOnly, imap: { host: "mail.lichtgrat.example", pass: secretOf(MARKER) } }, "seed");
    await wire.connect({ ...input(), smtp: { host: "smtp.lichtgrat.example", pass: secretOf(MARKER) } }, "seed");
    expect(asked.map((a) => a.ask.input)).toEqual([
      { address: ADDRESS, pass: MARKER, name: null, imap: { host: "mail.lichtgrat.example", port: 993 }, smtp: null },
      { address: ADDRESS, pass: MARKER, name: null, imap: { host: "mail.lichtgrat.example", port: 1993 }, smtp: { host: "smtp.lichtgrat.example", port: 587 } },
    ]);
    // The two numbers are the provider table's own, for a server it does not know.
    const generic = providerById("imap");
    expect(OPEN_PORTS).toEqual({ imap: generic.imap.port, smtp: generic.smtp.port });
  });

  it("answers a refusal as its code and the field it is about, and takes no word that crossed with it", async () => {
    const { door } = doorOf([
      { ok: false, code: "standaloneNoPort", field: "imapPort", args: [`the server said ${MARKER}`, { code: "verbatimDetail", args: [MARKER] }] },
      { ok: false, code: MARKER, field: MARKER as never, args: [] },
      { ok: false, code: "__proto__", field: null, args: [] },
      // A plain key every object carries: the code's shape takes it, the guard behind it does not.
      { ok: false, code: "constructor", field: null, args: [] },
    ]);
    const wire = phoneConnectWire(door);
    const first = await wire.connect(input(), "seed");
    expect(first).toEqual({
      ok: false,
      refusal: { status: 0, code: "standaloneNoPort", message: "", details: { ...NO_DETAILS, field: "imapPort" } },
    });
    expect(JSON.stringify(first)).not.toContain("MARKER");
    const nothing = { ok: false, refusal: { status: 0, code: null, message: "", details: NO_DETAILS } };
    expect(await wire.connect(input(), "seed")).toEqual(nothing);
    expect(await wire.connect(input(), "seed")).toEqual(nothing);
    expect(await wire.connect(input(), "seed")).toEqual(nothing);
  });

  it("never throws and never reads a refused open as an accepted one: a bridge that refuses, a deadline, an answer that names no mailbox, a body with no sealed password", async () => {
    const nothing = { ok: false, refusal: { status: 0, code: null, message: "", details: NO_DETAILS } };
    const { door, asked } = doorOf([
      new BridgeRefused("malformed"),
      new BridgeRefused("deadline"),
      new Error(`a throw that repeats ${MARKER}`),
      { ok: true, mailboxId: "../not-an-id" },
      { ok: true } as never,
      { mailboxId: "engine-account" } as never,
      null as never,
    ]);
    const wire = phoneConnectWire(door);
    for (let i = 0; i < 7; i++) expect(await wire.connect(input(), "seed"), String(i)).toEqual(nothing);
    expect(asked).toHaveLength(7);
    // A body whose password is not the form's seal asks nothing.
    const lookalike = { toString: () => "", toJSON: () => "" } as never;
    expect(await wire.connect(input({ imap: { host: "mail.lichtgrat.example", pass: lookalike } }), "seed")).toEqual(nothing);
    expect(asked).toHaveLength(7);
  });

  it("has no test, no edit, no lookup and no provider's sign-in", () => {
    const wire = phoneConnectWire(doorOf([]).door);
    expect([wire.probe, wire.edit, wire.discover, wire.signIn, wire.localServerWait]).toEqual([NONE, NONE, NONE, NONE, false]);
  });

  it("the name's rule is one function, whichever path names it", () => {
    expect(senderNameOfOldPath).toBe(senderNameOf);
  });
});

/* ── WHERE A SECRET IS ON THE DOOR'S PAGE ──────────────────────────────────────────────────────────────────────── */

const EPOCH = "e-door-1";
const CONFIG: DoorConfig = {
  app: "ohmail", os: "android", pad: false, language: "en", build: { version: "2.0.0", commit: null },
  at: "welcome", organizes: "offered", canPin: true,
  facts: { posture: { folds: [], hasFold: false }, insets: { top: 0, right: 0, bottom: 0, left: 0 }, keyboard: { height: 0 }, online: true },
  state: { session: "none", migrating: null, said: null, openId: null, syncing: false, syncSaid: null, syncStopped: null, pinned: false, total: null, paired: [], after: null },
};

/** Native, as the door's page meets it: every text the page posts is kept as it crossed and read through the door's own guard. */
function native(answer: (request: DoorRequest) => object) {
  const posted: string[] = [];
  const requests: DoorRequest[] = [];
  const refused: string[] = [];
  let take: (text: string) => void = () => undefined;
  const joiner = new Joiner(EPOCH);
  const reply = (message: object): void => void Promise.resolve().then(() => take(JSON.stringify(message)));
  const port: PagePort = {
    post(text) {
      posted.push(text);
      let m = JSON.parse(text) as Record<string, unknown>;
      if (m.kind === "piece" || m.kind === "joined") {
        const whole = joiner.take(m);
        if (whole === null) return;
        m = JSON.parse(whole) as Record<string, unknown>;
      }
      const request = readDoorRequest(m);
      if ("refused" in request) {
        refused.push(request.refused);
        return reply({ id: m.id, epoch: EPOCH, ok: false, refused: request.refused });
      }
      requests.push(request);
      reply({ id: request.id, epoch: EPOCH, ok: true, answer: answer(request) });
    },
    listen(heard) {
      take = heard;
      return () => {
        take = () => undefined;
      };
    },
  };
  return { port, posted, requests, refused, tell: (event: object) => take(JSON.stringify({ ...event, epoch: EPOCH })) };
}

/** Everything written to a sink, as text; and every call that must never happen. */
let written: string[] = [];
let reached: string[] = [];
const record =
  (sink: string) =>
  (...args: unknown[]): void => {
    written.push(`${sink}: ${args.map((arg) => (typeof arg === "string" ? arg : (JSON.stringify(arg) ?? String(arg)))).join(" ")}`);
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
  vi.spyOn(Document.prototype, "cookie", "set").mockImplementation(record("cookie"));
  vi.spyOn(window.history, "pushState").mockImplementation(record("history"));
  vi.spyOn(window.history, "replaceState").mockImplementation(record("history"));
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const)
    vi.spyOn(console, method).mockImplementation(record(`console.${method}`));
  vi.stubGlobal("indexedDB", { open: vi.fn(never("indexedDB.open")), deleteDatabase: vi.fn(never("indexedDB.deleteDatabase")) });
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

/** The page as markup, and every field's value: a marker may be the value of one password field, and nothing else. */
function onThePage(): { markup: boolean; fields: string[] } {
  const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")]
    .filter((field) => field.value.includes("MARKER"))
    .map((field) => field.getAttribute("type") ?? "text");
  return { markup: document.documentElement.outerHTML.includes("MARKER"), fields };
}
/** No sink holds a marker; nothing was stored, no address written, nothing fetched; the address is as it was. */
function clean(href: string): void {
  expect(written.filter((line) => line.includes("MARKER"))).toEqual([]);
  expect(written.filter((line) => /^(storage|cookie|history|postMessage|clipboard):/.test(line))).toEqual([]);
  expect(reached).toEqual([]);
  expect(window.location.href).toBe(href);
  expect(window.location.href).not.toContain("MARKER");
}
/**
 * The messages that hold a marker: `count` of them, each a request of `kind` whose one field holds it. `split`
 * answers that field and the rest of what was asked: the rest must hold none.
 */
function onlyIn<K extends "open" | "hand">(
  n: { readonly posted: readonly string[]; readonly requests: readonly DoorRequest[] },
  kind: K,
  split: (ask: DoorRequests[K]["ask"]) => { readonly field: string; readonly rest: unknown },
  count: number,
): void {
  expect(n.posted.filter((text) => text.includes("MARKER"))).toHaveLength(count);
  const carrying = n.requests.filter((request) => JSON.stringify(request).includes("MARKER"));
  expect(carrying.map((request) => request.kind)).toEqual(Array.from({ length: count }, () => kind));
  for (const request of carrying) {
    const { field, rest } = split(request.ask as DoorRequests[K]["ask"]);
    expect(field).toContain("MARKER");
    expect(JSON.stringify(rest)).not.toContain("MARKER");
  }
}
const type = (label: string, value: string): void => void fireEvent.change(screen.getByLabelText(label), { target: { value } });
const press = (name: string): void => void fireEvent.click(screen.getByRole("button", { name }));
/** A press on the ways in: a button that carries its key's hint ("↵") is named by its words. */
const pressWay = (name: string): void =>
  void fireEvent.click(screen.getByRole("button", { name: (n) => n.replace(/\s*↵$/, "") === name }));
const settle = (): Promise<void> => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe("a mailbox's password on the door's page", () => {
  it("stands in the one field and in the body of `open`, through a refusal that repeats it and the connect; then it is gone", async () => {
    const answers: Open["answer"][] = [
      // Native's own words, repeating what was sent: plain, and as a string escapes it.
      { ok: false, code: "standaloneRefused", field: null, args: [`the server said ${MARKER}`, JSON.stringify(MARKER)] },
      // A code and a field that are the password itself.
      { ok: false, code: MARKER, field: MARKER as never, args: [{ code: MARKER, args: [MARKER] }] },
      { ok: true, mailboxId: "engine-account" },
    ];
    const n = native((request) => (request.kind === "open" ? answers.shift()! : {}));
    const door = doorHandle(createDoorBridge(n.port, EPOCH), CONFIG);
    const href = window.location.href;
    const done: ConnectResult[] = [];
    render(
      h(TextProvider, {
        locale: "en",
        messages: WORDS as never,
        timeZone: "UTC",
        children: h(ConnectForm, {
          ask: { purpose: { kind: "standalone" }, onDone: (result) => void done.push(result) },
          door: phoneConnectWire(door),
          factor: NONE,
        }),
      }),
    );
    type(F.addressLabel, ADDRESS);
    press(P.otherLabel);
    type(F.imapHost, "mail.lichtgrat.example");
    type(F.smtpHost, "smtp.lichtgrat.example:465");
    type(F.passwordLabel, MARKER);
    type(F.nameLabel, "Ada Lovelace");
    expect(onThePage()).toEqual({ markup: false, fields: ["password"] });

    press(F.connect);
    await settle();
    expect(screen.getByRole("alert").textContent).toContain(R.standaloneRefused!.replace("{0}", "").trim());
    expect(onThePage()).toEqual({ markup: false, fields: ["password"] });

    press(F.connect);
    await settle();
    expect(screen.getByRole("alert").textContent).toContain(R.unknown);
    expect(onThePage()).toEqual({ markup: false, fields: ["password"] });

    press(F.connect);
    await settle();
    expect(done).toEqual([{ kind: "connected", mailboxId: "engine-account", address: null, created: true }]);
    expect(onThePage()).toEqual({ markup: false, fields: [] });
    expect(JSON.stringify(done)).not.toContain("MARKER");

    // Three presses, three bodies, each read by native's guard as an `open`; the password is in each one's `pass` alone.
    expect(n.refused).toEqual([]);
    expect(n.requests.map((request) => request.kind)).toEqual(["open", "open", "open"]);
    expect((n.requests[0] as DoorRequest<"open">).ask.input).toEqual({
      address: ADDRESS,
      pass: MARKER,
      name: "Ada Lovelace",
      imap: { host: "mail.lichtgrat.example", port: 993 },
      smtp: { host: "smtp.lichtgrat.example", port: 465 },
    });
    onlyIn(n, "open", ({ input: { pass, ...rest } }) => ({ field: pass, rest }), 3);
    expect(JSON.stringify([door.state.read(), door.route.read(), door.config])).not.toContain("MARKER");
    clean(href);
  });
});

describe("a typed pairing code and a pasted link on the door's page", () => {
  it("each crosses once, in the body of `hand`, and the page's bridge keeps and writes neither", async () => {
    const n = native((request) =>
      request.kind === "hand"
        ? // Native's refusal repeating what was typed: what a page draws is the page's; the bridge hands it on and keeps nothing.
          { k: "refused", said: { code: "pairCodeRejected", args: [] } }
        : {},
    );
    const door = doorHandle(createDoorBridge(n.port, EPOCH), CONFIG);
    const href = window.location.href;
    const heard: unknown[] = [];
    door.onScan((scan) => void heard.push(scan));

    expect(await door.ask("hand", { address: null, token: TYPED })).toEqual({ k: "refused", said: { code: "pairCodeRejected", args: [] } });
    expect(await door.ask("hand", { address: "https://mail.lichtgrat.example", token: LINK })).toEqual({ k: "refused", said: { code: "pairCodeRejected", args: [] } });
    // What native tells afterwards is drawn from what it says, never from what the page sent.
    n.tell({ type: "state", state: { ...CONFIG.state, session: "refused", said: { code: "pairCodeRejected", args: [] } } });
    n.tell({ type: "scan", scan: { k: "notACode" } });
    await door.ask("dismiss", { ticket: "0".repeat(32) });
    await door.ask("leave", {});

    expect(n.refused).toEqual([]);
    expect(n.requests.map((request) => request.kind)).toEqual(["hand", "hand", "dismiss", "leave"]);
    onlyIn(n, "hand", ({ token, ...rest }) => ({ field: token, rest }), 2);
    expect(heard).toEqual([{ k: "notACode" }]);
    expect(door.state.read().session).toBe("refused");
    expect(JSON.stringify([door.state.read(), door.route.read(), door.config, heard])).not.toContain("MARKER");
    clean(href);
  });

  it("through the ways in drawn on the page's real door: the pasted link crosses once, in `hand`, and the press of a pairing waits past the channel's sixty seconds", async () => {
    // A ticket in the door's own shape, so that native's guard takes the press and answers it.
    const offered = { k: "offers", ticket: "e".repeat(32), facts: { what: "server", address: "https://oh.lichtgrat.example", key: null } };
    const n = native((request) =>
      request.kind === "scan.start" ? { camera: "off" } : request.kind === "hand" ? offered : request.kind === "pair" ? { ok: true } : {},
    );
    const door = doorHandle(createDoorBridge(n.port, EPOCH), CONFIG);
    const asked = vi.spyOn(door, "ask");
    const href = window.location.href;
    const welcome = pages.welcome;
    if (welcome === NONE) throw new Error("the door draws no ways in");
    render(h(TextProvider, { locale: "en", messages: WORDS as never, timeZone: "UTC", children: h(welcome, { door }) }));

    pressWay(WAYS.welcome.scan);
    await settle();
    pressWay(WAYS.scan.byHand);
    await settle();
    type(WAYS.scan.linkLabel, LINK);
    pressWay(WAYS.scan.pair);
    await settle();
    pressWay(WAYS.confirm.pair);
    await settle();

    expect(n.refused).toEqual([]);
    expect(n.requests.map((request) => request.kind)).toEqual(["scan.start", "scan.stop", "hand", "pair"]);
    onlyIn(n, "hand", ({ token, ...rest }) => ({ field: token, rest }), 1);
    expect(onThePage()).toEqual({ markup: false, fields: [] });
    clean(href);
    expect(asked.mock.calls.find(([kind]) => kind === "pair")?.[2]).toEqual({ deadlineMs: PAIR_DEADLINE_MS });
    expect(PAIR_DEADLINE_MS).toBeGreaterThan(60_000);
  });
});

/** The door's stage as its page draws it (`main.tsx`): the page its route names, or nothing where none is built. */
function Stage({ door }: { readonly door: DoorHandle }) {
  const route = useSyncExternalStore(door.route.subscribe, door.route.read);
  const Page = pages[route];
  return Page === NONE ? null : h(Page, { door });
}

describe("the ways in on the door's page", () => {
  it("lead to no page the door does not draw: a press on Servers at the first screen leaves a page on the stage", async () => {
    const n = native(() => ({}));
    const door = doorHandle(createDoorBridge(n.port, EPOCH), CONFIG);
    const { container } = render(h(TextProvider, { locale: "en", messages: WORDS as never, timeZone: "UTC", children: h(Stage, { door }) }));
    pressWay(WAYS.welcome.servers);
    await settle();
    expect(pages[door.route.read()]).not.toBe(NONE);
    expect(container.textContent).not.toBe("");
    expect(n.requests).toEqual([]);
  });
});
