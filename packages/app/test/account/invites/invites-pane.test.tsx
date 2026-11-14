/** @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createTranslator } from "use-intl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactorSlot, GatedAsk, QrSlot } from "../../../src/account/contract.js";
import { InvitesPane } from "../../../src/account/invites/InvitesPane.js";
import type { InvitesDoor, InvitesModel } from "../../../src/account/invites/model.js";
import { INVITES_NAMESPACE } from "../../../src/account/invites/namespace.js";
import { invitesStates } from "../../../src/account/invites/states.js";
import { useInvites } from "../../../src/account/invites/use-invites.js";
import { fillOver, TextProvider, type Messages } from "../../../src/text/index.js";
import accountDe from "../../../messages/account.de.json" with { type: "json" };
import accountEn from "../../../messages/account.en.json" with { type: "json" };
import ownDe from "../../../messages/account-invites.de.json" with { type: "json" };
import ownEn from "../../../messages/account-invites.en.json" with { type: "json" };
/* The states the comparison registers, by address. */
import registry from "../../../../../test/compare/registry.json" with { type: "json" };
import { FACTOR, fakeInvitesDoor, FOR_NOBODY, FOR_RAHEL, ok, said as refusedWith } from "./fake-door.js";

afterEach(cleanup);

type Lang = "en" | "de";
type Values = Record<string, string | number>;
const EN: Messages = { ...accountEn, ...ownEn };
const WORDS: Readonly<Record<Lang, Messages>> = { en: EN, de: fillOver(EN, { ...accountDe, ...ownDe }) };
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
const inv = (key: string, values?: Values, lang?: Lang) => said("invites", key, values, lang);
const own = (key: string, lang?: Lang) => said(INVITES_NAMESPACE, key, {}, lang);
const seen = (words: string): boolean => (document.body.textContent ?? "").includes(words);
const button = (name: string) => screen.queryByRole("button", { name });
const line = (name: string) => screen.getByRole("group", { name });

/* The page's own fixtures: no source file holds a link. Its last part is what only the person may see. */
const PART = createHash("sha256").update("invites-pane fixture").digest("base64url");
const LINK = `https://mail.lichtgrat.example/join/invite#${PART}`;
const FAILED = "The server could not be reached.";
const STATES = invitesStates({ invite: FOR_RAHEL, link: LINK, failed: FAILED });

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
function drawn(model: InvitesModel, { factor = noFactor, lang = "en" as Lang } = {}) {
  return render(
    <TextProvider locale={lang} messages={WORDS[lang]} timeZone="Europe/Zurich">
      <InvitesPane model={model} factor={factor} qr={qr} />
    </TextProvider>,
  );
}
/** A state's model with the verbs a case listens on. */
const listening = (model: InvitesModel, verbs: Partial<InvitesModel>): InvitesModel => ({
  ...model,
  ...verbs,
});
const press = (el: HTMLElement) => fireEvent.click(el);

describe("what the pane lists", () => {
  it("at rest: the lead, the name's blank and the verb by the names the journeys find, and that no invite is open", () => {
    drawn(STATES.rest.model);
    expect(seen(inv("intro"))).toBe(true);
    expect((screen.getByRole("textbox", { name: inv("mintFor") }) as HTMLInputElement).maxLength).toBe(100);
    expect(button(inv("mintAction"))).toBeTruthy();
    expect(seen(inv("mintHint"))).toBe(true);
    expect(screen.getByRole("heading", { name: inv("liveTitle") })).toBeTruthy();
    expect(seen(own("none"))).toBe(true);
    expect(screen.queryAllByRole("group")).toHaveLength(0);
  });

  it("the open invites: the name or the fallback, the day made, the day it expires, and Revoke", () => {
    drawn({ ...STATES.open.model, invites: [FOR_RAHEL, FOR_NOBODY] });
    expect(within(line("Rahel Beck")).getByRole("button", { name: inv("revoke") })).toBeTruthy();
    expect(seen(inv("rowMeta", { created: FOR_RAHEL.made, expires: FOR_RAHEL.expires }))).toBe(true);
    expect(within(line(inv("rowFallback"))).getByRole("button", { name: inv("revoke") })).toBeTruthy();
    expect(seen(inv("rowMeta", { created: FOR_NOBODY.made, expires: FOR_NOBODY.expires }))).toBe(true);
    expect(seen(own("none"))).toBe(false);
  });

  it("a list that could not be read is not an empty one: its reason, and no open-invites sheet at all", () => {
    drawn(STATES.unread.model);
    expect(seen(own("notRead"))).toBe(true);
    expect(seen(FAILED)).toBe(true);
    expect(screen.queryByRole("heading", { name: inv("liveTitle") })).toBeNull();
    expect(seen(own("none"))).toBe(false);
    expect(button(inv("mintAction"))).toBeTruthy();
  });

  it("reads German where the catalogue is German", () => {
    drawn(STATES.rest.model, { lang: "de" });
    expect(button(inv("mintAction", {}, "de"))).toBeTruthy();
    expect(seen(own("none", "de"))).toBe(true);
    expect(seen(own("none"))).toBe(false);
  });
});

describe("the link, shown once", () => {
  it("is drawn as its picture with the name it was made for, and is never printed", () => {
    drawn(STATES.made.model);
    expect(screen.getByRole("heading", { name: "Rahel Beck" })).toBeTruthy();
    expect(seen(inv("mintedLeadFor", { name: "Rahel Beck" }))).toBe(true);
    expect(pictured).toEqual([{ value: LINK, label: inv("qrAria") }]);
    expect(seen(inv("mintedOnce"))).toBe(true);
    expect(document.body.innerHTML).not.toContain(PART);
    expect(button(inv("mintAction"))).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(within(line("Rahel Beck")).getByRole("button", { name: inv("revoke") })).toBeTruthy();
  });

  it("a link made for nobody is named by the fallback and says the plain lead", () => {
    drawn({ ...STATES.made.model, made: { link: LINK, name: "" } });
    expect(screen.getByRole("heading", { name: inv("rowFallback") })).toBeTruthy();
    expect(seen(inv("mintedLead"))).toBe(true);
  });

  it("Copy and Done are the model's two verbs", () => {
    const copy = vi.fn();
    const done = vi.fn();
    drawn(listening(STATES.made.model, { copy, done }));
    press(button(inv("copyLink"))!);
    press(button(inv("mintedDone"))!);
    expect([copy.mock.calls.length, done.mock.calls.length]).toEqual([1, 1]);
  });
});

describe("what the last read, verb or copy left to say", () => {
  it("a copy the clipboard refused is said by the sentence it has today", () => {
    drawn(STATES.madeNotCopied.model);
    expect(seen(own("notCopied"))).toBe(true);
    expect(seen(inv("copyFailed"))).toBe(true);
    expect(seen(inv("copied"))).toBe(false);
  });

  it("a closed window is the sign-in sentence, and a refusal is said as the shell said it", () => {
    drawn(STATES.windowClosed.model);
    expect(seen(own("notDone"))).toBe(true);
    expect(seen(inv("stepUpExpired"))).toBe(true);
    cleanup();
    drawn(STATES.refused.model);
    expect(seen(own("notDone"))).toBe(true);
    expect(seen(FAILED)).toBe(true);
  });

  it("a factor thrown away says nothing ran, beside a refusal too", () => {
    const nothingRan = said("devices", "stepUpCancelledNothingRan");
    drawn(STATES.nothingRan.model);
    expect(seen(own("cancelled"))).toBe(true);
    expect(seen(nothingRan)).toBe(true);
    cleanup();
    drawn({ ...STATES.refused.model, nothingRan: true });
    expect(seen(FAILED)).toBe(true);
    expect(seen(nothingRan)).toBe(true);
  });

  it("what a verb did is said where a screen reader hears it: copied, revoked", () => {
    const told = (): string =>
      screen
        .getAllByRole("status")
        .map((each) => each.textContent)
        .join("");
    for (const [state, sentence] of [
      [STATES.copied, inv("copied")],
      [STATES.revoked, inv("revoked")],
    ] as const) {
      drawn(state.model);
      expect(told()).toBe(sentence);
      cleanup();
    }
    drawn(STATES.rest.model);
    expect(told()).toBe("");
  });

  it("a verb on its way says so, and every verb is off meanwhile", () => {
    drawn({ ...STATES.open.model, working: { kind: "make", name: "" } });
    expect(button(inv("mintAction"))).toBeNull();
    const off = screen.getAllByRole("button") as HTMLButtonElement[];
    expect(off.map((each) => each.disabled)).toEqual([true, true]);
    expect(off[0]!.textContent).toBe(inv("working"));
  });
});

describe("the presses", () => {
  it("typing is the model's; the verb and Enter in the name both make; Enter makes nothing while a verb works", () => {
    const type = vi.fn();
    const make = vi.fn();
    drawn(listening(STATES.rest.model, { type, make }));
    const name = screen.getByRole("textbox", { name: inv("mintFor") });
    fireEvent.change(name, { target: { value: "Rahel" } });
    expect(type).toHaveBeenCalledWith("Rahel");
    press(button(inv("mintAction"))!);
    fireEvent.keyDown(name, { key: "Enter" });
    fireEvent.keyDown(name, { key: "a" });
    expect(make).toHaveBeenCalledTimes(2);
    cleanup();
    drawn(listening(STATES.working.model, { make }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: inv("mintFor") }), { key: "Enter" });
    expect(make).toHaveBeenCalledTimes(2);
  });

  it("Revoke names its invite", () => {
    const revoke = vi.fn();
    drawn(listening(STATES.open.model, { revoke }));
    press(within(line("Rahel Beck")).getByRole("button", { name: inv("revoke") }));
    expect(revoke).toHaveBeenCalledWith(FOR_RAHEL.id);
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

describe("before the page's script, and where the link may be", () => {
  it("in every state: no form, no named control, no link, no handler written into the page, no test id", () => {
    for (const [name, state] of Object.entries(STATES)) {
      const { container } = drawn(state.model);
      expect(container.querySelectorAll("form, a[href], [name], [data-testid]"), name).toHaveLength(0);
      const written = [...container.querySelectorAll("*")].flatMap((el) =>
        el.getAttributeNames().filter((attribute) => attribute.startsWith("on")),
      );
      expect(written, name).toEqual([]);
      cleanup();
    }
  });

  it("in every state the link is in the picture's slot alone: in no text and no attribute of the page", () => {
    for (const [name, state] of Object.entries(STATES)) {
      drawn(state.model);
      expect(document.body.innerHTML.includes(PART), name).toBe(false);
      cleanup();
    }
  });
});

describe("the pane over its door", () => {
  function Pane({ door, factor }: { door: InvitesDoor; factor: FactorSlot }) {
    return <InvitesPane model={useInvites(door)} factor={factor} qr={qr} />;
  }
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const pressed = async (name: string) => {
    fireEvent.click(screen.getByRole("button", { name }));
    await settle();
  };
  const over = async (door: InvitesDoor, factor: FactorSlot = noFactor) => {
    const view = render(
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <Pane door={door} factor={factor} />
      </TextProvider>,
    );
    await settle();
    return view;
  };
  const made = { link: LINK, name: "Rahel Beck" };

  it("a list that could not be read says why and lists nothing as open", async () => {
    await over(fakeInvitesDoor({ reads: [refusedWith(FAILED)] }));
    expect(seen(FAILED)).toBe(true);
    expect(screen.queryByRole("heading", { name: inv("liveTitle") })).toBeNull();
  });

  it("makes the link on the press, hands it to the picture alone, and Done takes it down", async () => {
    const door = fakeInvitesDoor({ reads: [ok([]), ok([FOR_RAHEL])], makes: [ok(made)] });
    await over(door);
    fireEvent.change(screen.getByRole("textbox", { name: inv("mintFor") }), {
      target: { value: " Rahel Beck " },
    });
    await pressed(inv("mintAction"));
    expect(door.calls()).toEqual(["read", "make:Rahel Beck", "read"]);
    expect(pictured.map((each) => each.value)).toContain(LINK);
    expect(document.body.innerHTML.includes(PART)).toBe(false);
    await pressed(inv("mintedDone"));
    expect(seen("the picture to scan")).toBe(false);
    expect((screen.getByRole("textbox", { name: inv("mintFor") }) as HTMLInputElement).value).toBe("");
    expect(door.calls()).toEqual(["read", "make:Rahel Beck", "read"]);
  });

  it("revoking the invite on show leaves its picture up, as it always did", async () => {
    const door = fakeInvitesDoor({
      reads: [ok([]), ok([FOR_RAHEL]), ok([])],
      makes: [ok(made)],
      revokes: [ok(null)],
    });
    await over(door);
    await pressed(inv("mintAction"));
    await pressed(inv("revoke"));
    expect(seen(inv("revoked"))).toBe(true);
    expect(seen("the picture to scan")).toBe(true);
  });

  it("the factor is asked through the slot, and its verified answer revokes once", async () => {
    const slot = { asked: null as GatedAsk | null };
    const factor: FactorSlot = (ask) => {
      slot.asked = ask;
      return null;
    };
    const door = fakeInvitesDoor({ reads: [ok([FOR_RAHEL]), ok([])], revokes: [FACTOR, ok(null)] });
    await over(door, factor);
    await pressed(inv("revoke"));
    expect(door.calls()).toEqual(["read", "revoke:i-1"]);
    await act(async () => slot.asked!.onVerified());
    await settle();
    expect(door.calls()).toEqual(["read", "revoke:i-1", "revoke:i-1", "read"]);
    expect(seen(own("none"))).toBe(true);
  });
});

describe("the pane's states", () => {
  const registered = new Set((registry as { states: { key: string }[] }).states.map((state) => state.key));
  const addresses = Object.values(STATES).flatMap((state) => (state.address === null ? [] : [state.address]));

  it("each address is a state the comparison registers, once", () => {
    expect(addresses.filter((address) => !registered.has(address))).toEqual([]);
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it("cover every picture of the pane", () => {
    const drawnByTheDesign = [...registered].filter((key) => {
      const parts = key.split("&");
      return parts.includes("screen=settings") && parts.includes("sec=invites");
    });
    expect([...addresses].sort()).toEqual(drawnByTheDesign.sort());
  });
});
