/** @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createTranslator } from "use-intl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactorSlot, GatedAsk, QrSlot } from "../../../src/account/contract.js";
import { DevicesPane } from "../../../src/account/devices/DevicesPane.js";
import type { DevicesDoor, DevicesModel } from "../../../src/account/devices/model.js";
import { DEVICES_NAMESPACE } from "../../../src/account/devices/namespace.js";
import { devicesStates } from "../../../src/account/devices/states.js";
import { useDevices } from "../../../src/account/devices/use-devices.js";
import { fillOver, TextProvider, type Messages } from "../../../src/text/index.js";
import accountDe from "../../../messages/account.de.json" with { type: "json" };
import accountEn from "../../../messages/account.en.json" with { type: "json" };
import ownDe from "../../../messages/account-devices.de.json" with { type: "json" };
import ownEn from "../../../messages/account-devices.en.json" with { type: "json" };
/* The states the comparison registers, by address. */
import registry from "../../../../../test/compare/registry.json" with { type: "json" };
import {
  CODE,
  FACTOR,
  fakeDevicesDoor,
  LAPTOP,
  lists,
  ok,
  PHONE,
  plain,
  said as refusedWith,
  THIS,
} from "./fake-door.js";

afterEach(cleanup);

type Lang = "en" | "de";
const EN: Messages = { ...accountEn, ...ownEn };
const WORDS: Readonly<Record<Lang, Messages>> = { en: EN, de: fillOver(EN, { ...accountDe, ...ownDe }) };
type Values = Record<string, string | number>;
/** A sentence by its key, as a reader of that language says it: a case names a sentence by its key, never by its words. */
function said(namespace: string, key: string, values: Values = {}, lang: Lang = "en"): string {
  const t = createTranslator({
    locale: lang,
    messages: WORDS[lang] as Parameters<typeof createTranslator>[0]["messages"],
    namespace: namespace as never,
    timeZone: "Europe/Zurich",
    onError: () => {},
    getMessageFallback: () => "",
  }) as unknown as (key: string, values: Values) => string;
  const text = t(key, values);
  if (text === "") throw new Error(`no sentence ${namespace}.${key} in ${lang}`);
  return text;
}
const dev = (key: string, values?: Values, lang?: Lang) => said("devices", key, values, lang);
const own = (key: string, lang?: Lang) => said(DEVICES_NAMESPACE, key, {}, lang);
const seen = (words: string): boolean => (document.body.textContent ?? "").includes(words);
const button = (name: string) => screen.queryByRole("button", { name });
const line = (name: string) => screen.getByRole("group", { name });

/* The page's own fixtures: no source file holds a link. Its last part is what only the person may see. */
const PART = createHash("sha256").update("devices-pane fixture").digest("base64url");
const LINK = `https://api.ohmail.example/pair#${PART}`;
const FAILED = "The server could not be reached.";
const SESSIONS = [THIS, PHONE, LAPTOP, plain(3), plain(2)];
const STATES = devicesStates({ sessions: SESSIONS, code: CODE, link: LINK, failed: FAILED });

const noFactor: FactorSlot = () => null;
/** The picture of the link, stood in for: what is held is what the pane hands the slot. */
const pictured: { value: string; label: string }[] = [];
const qr: QrSlot = (value, label) => {
  pictured.push({ value, label });
  return <p>the picture to scan</p>;
};
afterEach(() => {
  pictured.length = 0;
});
function drawn(model: DevicesModel, { factor = noFactor, lang = "en" as Lang } = {}) {
  return render(
    <TextProvider locale={lang} messages={WORDS[lang]} timeZone="Europe/Zurich">
      <DevicesPane model={model} factor={factor} qr={qr} />
    </TextProvider>,
  );
}
/** A state's model with the verbs a case listens on. */
const listening = (model: DevicesModel, verbs: Partial<DevicesModel>): DevicesModel => ({
  ...model,
  ...verbs,
});
const press = (el: HTMLElement) => fireEvent.click(el);

describe("what the pane lists", () => {
  it("at rest: the lead, the name's blank and the verb by the names the journeys find, and what is signed in", () => {
    drawn(STATES.rest.model);
    expect(seen(dev("intro"))).toBe(true);
    expect((screen.getByRole("textbox", { name: dev("addFor") }) as HTMLInputElement).maxLength).toBe(100);
    expect(button(dev("addAction"))).toBeTruthy();
    expect(seen(dev("addHint"))).toBe(true);
    expect(screen.getByRole("heading", { name: dev("devicesTitle") })).toBeTruthy();
    expect(seen(dev("codesTitle"))).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("this device stands first, is marked, and has no way out here", () => {
    drawn(STATES.rest.model);
    const lines = screen.getAllByRole("group").map((each) => each.getAttribute("aria-labelledby"));
    const first = line(dev("kindWeb"));
    expect(first.getAttribute("aria-labelledby")).toBe(lines[0]);
    expect(first.textContent).toContain(own("thisOne"));
    expect(within(first).queryAllByRole("button")).toHaveLength(0);
  });

  it("every other device has its kind, the day it was added, the day last seen, and its way out", () => {
    drawn(STATES.rest.model);
    expect(within(line("Mila's phone")).getByRole("button", { name: dev("remove") })).toBeTruthy();
    expect(
      seen(dev("deviceMeta", { kind: dev("kindAndroid"), created: PHONE.added, seen: PHONE.seen })),
    ).toBe(true);
  });

  it("a device that paired without a name is named by ohmail, in the reader's language", () => {
    drawn(STATES.rest.model);
    expect(line(dev("mintedName", { kind: dev("kindLinux") }))).toBeTruthy();
    cleanup();
    drawn(STATES.rest.model, { lang: "de" });
    const german = dev("mintedName", { kind: dev("kindLinux", {}, "de") }, "de");
    expect(german).not.toBe(dev("mintedName", { kind: dev("kindLinux") }));
    expect(line(german)).toBeTruthy();
    expect(button(dev("addAction", {}, "de"))).toBeTruthy();
  });

  it("the other plain browser sessions are one line with their count, their last day and one way out", () => {
    drawn(STATES.rest.model);
    const group = line(dev("webGroup", { count: 2 }));
    expect(within(group).getByRole("button", { name: dev("webGroupAction") })).toBeTruthy();
    expect(seen(dev("webGroupMeta", { seen: plain(3).seen }))).toBe(true);
    expect(screen.getAllByRole("button").map((each) => each.textContent)).toEqual([
      dev("addAction"),
      dev("remove"),
      dev("remove"),
      dev("webGroupAction"),
    ]);
  });

  it("a kind this build does not know is a device, never a browser", () => {
    const strange = { ...PHONE, id: "d-x", kind: "other", name: { by: "nobody" } } as const;
    drawn({ ...STATES.rest.model, list: { at: "read", devices: [THIS, strange], webGroup: null } });
    expect(line(dev("kindOther"))).toBeTruthy();
    expect(screen.getAllByRole("group")).toHaveLength(2);
  });

  it("the codes not used yet: the name or the fallback, the time each works until, and Revoke", () => {
    drawn({ ...STATES.codes.model, codes: [CODE, { id: "c-2", name: null, until: "09:41" }] });
    expect(screen.getByRole("heading", { name: dev("codesTitle") })).toBeTruthy();
    expect(line("Ben").textContent).toContain(dev("codeMeta", { time: "09:29" }));
    expect(within(line("Ben")).getByRole("button", { name: dev("revoke") })).toBeTruthy();
    expect(line(dev("codeFallback")).textContent).toContain(dev("codeMeta", { time: "09:41" }));
  });

  it("before the list has answered: its heading, and that it is being read, where a screen reader hears it", () => {
    drawn(STATES.loading.model);
    expect(screen.getByRole("heading", { name: dev("devicesTitle") })).toBeTruthy();
    expect(screen.getAllByRole("status").some((each) => each.textContent === dev("loading"))).toBe(true);
    expect(seen(own("thisOne"))).toBe(false);
    expect(button(dev("addAction"))).toBeTruthy();
  });

  it("a read that failed: its reason, that the devices could not be loaded, and Try again; never an empty list", () => {
    const retry = vi.fn();
    drawn(listening(STATES.failed.model, { retry }));
    expect(seen(own("notRead"))).toBe(true);
    expect(seen(FAILED)).toBe(true);
    expect(seen(dev("loadFailed"))).toBe(true);
    expect(screen.getByRole("heading", { name: dev("devicesTitle") })).toBeTruthy();
    expect(screen.queryAllByRole("group")).toHaveLength(0);
    press(button(dev("retry"))!);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("a list that was read empty draws no signed-in sheet", () => {
    drawn({ ...STATES.rest.model, list: { at: "read", devices: [], webGroup: null } });
    expect(screen.queryByRole("heading", { name: dev("devicesTitle") })).toBeNull();
    expect(seen(dev("loadFailed"))).toBe(false);
  });
});

describe("the link, shown once", () => {
  it("is drawn as its picture and printed for typing, under the sentence that says so, with the name it was made for", () => {
    drawn(STATES.pair.model);
    expect(screen.getByRole("heading", { name: "Ben" })).toBeTruthy();
    expect(seen(dev("mintedLeadFor", { name: "Ben" }))).toBe(true);
    expect(pictured).toEqual([{ value: LINK, label: dev("qrAria") }]);
    expect(seen(dev("typedEntry"))).toBe(true);
    expect((document.body.textContent ?? "").split(LINK)).toHaveLength(2);
    expect(seen(dev("mintedOnce"))).toBe(true);
    expect(button(dev("addAction"))).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(within(line("Ben")).getByRole("button", { name: dev("revoke") })).toBeTruthy();
  });

  it("a link made for nobody is named by the fallback and says the plain lead", () => {
    const model = { ...STATES.pair.model, made: { id: "c-1", link: LINK, name: "" } };
    drawn(model);
    expect(screen.getByRole("heading", { name: dev("codeFallback") })).toBeTruthy();
    expect(seen(dev("mintedLead"))).toBe(true);
  });

  it("Copy and Done are the model's two verbs", () => {
    const copy = vi.fn();
    const done = vi.fn();
    drawn(listening(STATES.pair.model, { copy, done }));
    press(button(dev("copyLink"))!);
    press(button(dev("mintedDone"))!);
    expect([copy.mock.calls.length, done.mock.calls.length]).toEqual([1, 1]);
  });

  it("stands in what is read and in the picture's slot, never in an attribute", () => {
    for (const state of [STATES.pair, STATES.pairNotCopied, STATES.copied]) {
      const { container } = drawn(state.model);
      const attributes = [...container.querySelectorAll("*")].flatMap((el) =>
        el.getAttributeNames().map((attribute) => el.getAttribute(attribute) ?? ""),
      );
      expect(attributes.filter((value) => value.includes(PART))).toEqual([]);
      cleanup();
    }
  });
});

describe("what the last read, verb or copy left to say", () => {
  it("a copy the clipboard refused is said by the sentence it has today", () => {
    drawn(STATES.pairNotCopied.model);
    expect(seen(own("notCopied"))).toBe(true);
    expect(seen(dev("copyFailed"))).toBe(true);
    expect(seen(dev("copied"))).toBe(false);
  });

  it("a closed window is the sign-in sentence, and a refusal is said as the shell said it", () => {
    drawn(STATES.windowClosed.model);
    expect(seen(own("notDone"))).toBe(true);
    expect(seen(dev("stepUpExpired"))).toBe(true);
    cleanup();
    drawn(STATES.refused.model);
    expect(seen(own("notDone"))).toBe(true);
    expect(seen(FAILED)).toBe(true);
    cleanup();
    drawn(STATES.notReadAgain.model);
    expect(seen(own("notRead"))).toBe(true);
    expect(seen(dev("loadFailed"))).toBe(false);
  });

  it("a factor thrown away says nothing ran, beside a refusal too", () => {
    drawn(STATES.nothingRan.model);
    expect(seen(own("cancelled"))).toBe(true);
    expect(seen(dev("stepUpCancelledNothingRan"))).toBe(true);
    cleanup();
    drawn({ ...STATES.refused.model, nothingRan: true });
    expect(seen(FAILED)).toBe(true);
    expect(seen(dev("stepUpCancelledNothingRan"))).toBe(true);
  });

  it("what a verb did is said where a screen reader hears it: copied, revoked, signed out, and how many", () => {
    const told = (): string =>
      screen
        .getAllByRole("status")
        .map((each) => each.textContent)
        .join("");
    for (const [state, sentence] of [
      [STATES.copied, dev("copied")],
      [STATES.revoked, dev("revoked")],
      [STATES.removed, dev("removed")],
      [STATES.signedOutWeb, dev("webGroupDone", { count: 2 })],
    ] as const) {
      drawn(state.model);
      expect(told()).toBe(sentence);
      cleanup();
    }
    drawn(STATES.rest.model);
    expect(told()).toBe("");
  });

  it("a verb on its way says so, and every verb is off meanwhile", () => {
    drawn({ ...STATES.codes.model, working: { kind: "add", name: "" } });
    expect(button(dev("addAction"))).toBeNull();
    const off = screen.getAllByRole("button") as HTMLButtonElement[];
    expect(off.map((each) => each.disabled)).toEqual([true, true, true, true, true]);
    expect(off[0]!.textContent).toBe(dev("working"));
  });
});

describe("the presses", () => {
  it("typing is the model's; the verb and Enter in the name both add; Enter adds nothing while a verb works", () => {
    const type = vi.fn();
    const add = vi.fn();
    drawn(listening(STATES.rest.model, { type, add }));
    const name = screen.getByRole("textbox", { name: dev("addFor") });
    fireEvent.change(name, { target: { value: "Ben" } });
    expect(type).toHaveBeenCalledWith("Ben");
    press(button(dev("addAction"))!);
    fireEvent.keyDown(name, { key: "Enter" });
    fireEvent.keyDown(name, { key: "a" });
    expect(add).toHaveBeenCalledTimes(2);
    cleanup();
    drawn(listening(STATES.working.model, { add }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: dev("addFor") }), { key: "Enter" });
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("Revoke names its code; a device's way out and the group's only ask", () => {
    const verbs = { revokeCode: vi.fn(), askRemove: vi.fn(), askSignOutWeb: vi.fn(), confirm: vi.fn() };
    drawn(listening(STATES.codes.model, verbs));
    press(within(line("Ben")).getByRole("button", { name: dev("revoke") }));
    press(within(line("Mila's phone")).getByRole("button", { name: dev("remove") }));
    press(button(dev("webGroupAction"))!);
    expect(verbs.revokeCode).toHaveBeenCalledWith(CODE.id);
    expect(verbs.askRemove).toHaveBeenCalledWith(PHONE.id);
    expect(verbs.askSignOutWeb).toHaveBeenCalledTimes(1);
    expect(verbs.confirm).not.toHaveBeenCalled();
  });

  it("a device's removal is asked with what it does; only the question's own answer confirms", () => {
    const confirm = vi.fn();
    const dismiss = vi.fn();
    drawn(listening(STATES.asked.model, { confirm, dismiss }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(dev("removeAsk", { name: "Mila's phone" }));
    expect(dialog.textContent).toContain(dev("removeWhat"));
    press(within(dialog).getByRole("button", { name: dev("cancel") }));
    expect([confirm.mock.calls.length, dismiss.mock.calls.length]).toEqual([0, 1]);
    press(within(dialog).getByRole("button", { name: dev("remove") }));
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("the group's sign-out is asked with its count and what it does", () => {
    const confirm = vi.fn();
    drawn(listening(STATES.askedWeb.model, { confirm }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(dev("webGroupAsk", { count: 2 }));
    expect(dialog.textContent).toContain(dev("webGroupWhat"));
    press(within(dialog).getByRole("button", { name: dev("webGroupAction") }));
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("hands the factor's dialog what the model asks, and only while it asks", () => {
    const factor: FactorSlot = vi.fn(() => <p>the factor</p>);
    drawn(STATES.rest.model, { factor });
    expect(factor).not.toHaveBeenCalled();
    cleanup();
    drawn(STATES.factor.model, { factor });
    expect(factor).toHaveBeenCalledWith(STATES.factor.model.ask);
    expect(seen("the factor")).toBe(true);
  });
});

describe("before the page's script", () => {
  it("in every state: no form, no named control, no link, no handler written into the page, no test id", () => {
    for (const [name, state] of Object.entries(STATES)) {
      const { container } = drawn(state.model);
      expect(container.querySelectorAll("form, a[href], [name], [data-testid]"), name).toHaveLength(0);
      const written = [...document.body.querySelectorAll("*")].flatMap((el) =>
        el.getAttributeNames().filter((attribute) => attribute.startsWith("on")),
      );
      expect(written, name).toEqual([]);
      cleanup();
    }
  });
});

describe("the pane over its door", () => {
  function Pane({ door, factor }: { door: DevicesDoor; factor: FactorSlot }) {
    return <DevicesPane model={useDevices(door)} factor={factor} qr={qr} />;
  }
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const pressed = async (name: string, inside: HTMLElement = document.body) => {
    fireEvent.click(within(inside).getByRole("button", { name }));
    await settle();
  };
  const over = async (door: DevicesDoor, factor: FactorSlot = noFactor) => {
    const view = render(
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <Pane door={door} factor={factor} />
      </TextProvider>,
    );
    await settle();
    return view;
  };
  const made = { id: CODE.id, link: LINK, name: "Ben" };

  it("a read that failed offers Try again and no device, and reads again on the press", async () => {
    const door = fakeDevicesDoor({ reads: [refusedWith(FAILED), ok(lists())] });
    await over(door);
    expect(seen(FAILED)).toBe(true);
    expect(screen.queryAllByRole("group")).toHaveLength(0);
    await pressed(dev("retry"));
    expect(seen(FAILED)).toBe(false);
    expect(line("Mila's phone")).toBeTruthy();
  });

  it("makes the link on the press, shows it once, and Done takes it off the page", async () => {
    const door = fakeDevicesDoor({
      reads: [ok(lists()), ok(lists([THIS, PHONE], [CODE])), ok(lists())],
      adds: [ok(made)],
    });
    await over(door);
    fireEvent.change(screen.getByRole("textbox", { name: dev("addFor") }), { target: { value: " Ben " } });
    await pressed(dev("addAction"));
    expect(door.calls()).toEqual(["read", "groupsWebSessions", "add:Ben", "read"]);
    expect(seen(LINK)).toBe(true);
    await pressed(dev("mintedDone"));
    expect(document.body.innerHTML.includes(PART)).toBe(false);
    expect((screen.getByRole("textbox", { name: dev("addFor") }) as HTMLInputElement).value).toBe("");
  });

  it("revoking the code on show takes its picture and its link down with the row", async () => {
    const door = fakeDevicesDoor({
      reads: [ok(lists()), ok(lists([THIS, PHONE], [CODE])), ok(lists())],
      adds: [ok(made)],
      revokes: [ok(null)],
    });
    await over(door);
    await pressed(dev("addAction"));
    await pressed(dev("revoke"));
    expect(document.body.innerHTML.includes(PART)).toBe(false);
    expect(seen("the picture to scan")).toBe(false);
    expect(seen(dev("revoked"))).toBe(true);
  });

  it("a device is signed out only from the question's own answer; the factor is asked through the slot and sends once", async () => {
    const slot = { asked: null as GatedAsk | null };
    const factor: FactorSlot = (ask) => {
      slot.asked = ask;
      return null;
    };
    const door = fakeDevicesDoor({ reads: [ok(lists()), ok(lists([THIS]))], removes: [FACTOR, ok(null)] });
    await over(door, factor);
    await pressed(dev("remove"));
    expect(door.calls()).toEqual(["read", "groupsWebSessions"]);
    await pressed(dev("remove"), screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(door.calls()).toEqual(["read", "groupsWebSessions", "remove:d-phone"]);
    await act(async () => slot.asked!.onVerified());
    await settle();
    expect(door.calls()).toEqual(["read", "groupsWebSessions", "remove:d-phone", "remove:d-phone", "read"]);
    expect(seen(dev("removed"))).toBe(true);
    expect(screen.queryByRole("group", { name: "Mila's phone" })).toBeNull();
  });
});

describe("the pane's states", () => {
  const registered = new Set((registry as { states: { key: string }[] }).states.map((state) => state.key));
  const addresses = Object.values(STATES).flatMap((state) => (state.address === null ? [] : [state.address]));

  it("each address is a state the comparison registers, once", () => {
    expect(addresses.filter((address) => !registered.has(address))).toEqual([]);
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it("cover every picture of the pane itself: not the card's, not the desktop's own pane", () => {
    const pictured_ = [...registered].filter((key) => {
      const parts = key.split("&");
      return (
        parts.includes("screen=settings") &&
        parts.includes("sec=devices") &&
        !parts.includes("door=cloud") &&
        !parts.includes("door=local")
      );
    });
    expect([...addresses].sort()).toEqual(pictured_.sort());
  });
});
