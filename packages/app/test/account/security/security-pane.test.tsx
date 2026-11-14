/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Answer, FactorSlot, GatedAsk } from "../../../src/account/contract.js";
import type { Enrolled, SecurityDoor, SecurityModel } from "../../../src/account/security/model.js";
import { SECURITY_NAMESPACE } from "../../../src/account/security/namespace.js";
import { SecurityPane } from "../../../src/account/security/SecurityPane.js";
import { securityStates } from "../../../src/account/security/states.js";
import { useSecurity } from "../../../src/account/security/use-security.js";
import { fillOver, TextProvider, type Messages } from "../../../src/text/index.js";
import accountDe from "../../../messages/account.de.json" with { type: "json" };
import accountEn from "../../../messages/account.en.json" with { type: "json" };
import ownDe from "../../../messages/account-security.de.json" with { type: "json" };
import ownEn from "../../../messages/account-security.en.json" with { type: "json" };
/* The states the comparison registers, by address. */
import registry from "../../../../../test/compare/registry.json" with { type: "json" };
import {
  ENROLLED,
  FACTOR,
  fakeSecurityDoor,
  held,
  ok,
  said as refusedWith,
  type Handed,
} from "./fake-door.js";

afterEach(cleanup);

type Lang = "en" | "de";
const EN: Messages = { ...accountEn, ...ownEn };
const WORDS: Readonly<Record<Lang, Messages>> = { en: EN, de: fillOver(EN, { ...accountDe, ...ownDe }) };
/** A sentence by its namespace and key: a case names a sentence by its key, never by its words. */
function said(namespace: string, key: string, lang: Lang = "en"): string {
  const at = (WORDS[lang][namespace] as Record<string, unknown> | undefined)?.[key];
  if (typeof at !== "string") throw new Error(`no sentence ${namespace}.${key} in ${lang}`);
  return at;
}
const sec = (key: string, lang: Lang = "en") => said("security", key, lang);
const own = (key: string, lang: Lang = "en") => said(SECURITY_NAMESPACE, key, lang);
const seen = (words: string): boolean => (document.body.textContent ?? "").includes(words);
const button = (name: string) => screen.queryByRole("button", { name });
const line = (name: string) => screen.getByRole("group", { name });

/* The page's own fixtures: no source file holds a code or a key. */
const CODES = ["58049-86391", "88255-40533", "75220-66993"];
const KEY = "JBSWY3DPEHPK3PXP";
const FAILED = "The server could not be reached.";
const STATES = securityStates({ codes: CODES, key: KEY, failed: FAILED });

/** The verbs that change what is enrolled, by the names a person and the journeys find them by. */
const CHANGING = ["codesGenerate", "codesReplace", "totpAdd", "totpReplace", "totpRemove"] as const;

const noFactor: FactorSlot = () => null;
function drawn(model: SecurityModel, { factor = noFactor, lang = "en" as Lang } = {}) {
  return render(
    <TextProvider locale={lang} messages={WORDS[lang]} timeZone="Europe/Zurich">
      <SecurityPane model={model} factor={factor} />
    </TextProvider>,
  );
}
/** A state's model with the verbs a case listens on. */
const listening = (model: SecurityModel, verbs: Partial<SecurityModel>): SecurityModel => ({
  ...model,
  ...verbs,
});

describe("what the pane says about what is enrolled", () => {
  it("draws nothing while that is not read", () => {
    const { container } = drawn(STATES.loading.model);
    expect(container.textContent).toBe("");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("over a read that failed: its reason, and no verb that changes what is enrolled", () => {
    drawn(STATES.unread.model);
    expect(seen(own("notRead"))).toBe(true);
    expect(seen(FAILED)).toBe(true);
    for (const key of CHANGING) expect(button(sec(key)), key).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("group")).toHaveLength(0);
  });

  it("at rest: unused codes with Replace, no authenticator with Set up, and no Remove", () => {
    drawn(STATES.rest.model);
    expect(line(sec("codesTitle")).textContent).toContain(own("codesUnused"));
    expect(within(line(sec("codesTitle"))).getByRole("button", { name: sec("codesReplace") })).toBeTruthy();
    expect(line(sec("totpTitle")).textContent).toContain(own("notSetUp"));
    expect(within(line(sec("totpTitle"))).getByRole("button", { name: sec("totpAdd") })).toBeTruthy();
    expect(button(sec("totpRemove"))).toBeNull();
    expect(seen(sec("codesNone"))).toBe(false);
  });

  it("with no unused codes: says what that costs, and offers Generate by the name the journeys find", () => {
    drawn(STATES.noCodes.model);
    expect(line(sec("codesTitle")).textContent).toContain(own("codesNoneUnused"));
    expect(seen(sec("codesNone"))).toBe(true);
    expect(button(sec("codesGenerate"))).toBeTruthy();
    expect(button(sec("codesReplace"))).toBeNull();
  });

  it("offers Remove only while a passkey is enrolled beside the authenticator", () => {
    drawn(STATES.authenticatorOn.model);
    expect(line(sec("totpTitle")).textContent).toContain(own("on"));
    expect(button(sec("totpReplace"))).toBeTruthy();
    expect(button(sec("totpRemove"))).toBeTruthy();
    cleanup();
    drawn({ ...STATES.rest.model, enrolled: { at: "read", ...ENROLLED.authenticator } });
    expect(button(sec("totpReplace"))).toBeTruthy();
    expect(button(sec("totpRemove"))).toBeNull();
  });

  it("reads German where the catalogue is German", () => {
    drawn(STATES.noCodes.model, { lang: "de" });
    expect(line(sec("codesTitle", "de")).textContent).toContain(own("codesNoneUnused", "de"));
    expect(button(sec("codesGenerate", "de"))).toBeTruthy();
    expect(seen(sec("codesNone"))).toBe(false);
  });
});

describe("new codes are asked for before they replace the set", () => {
  it("the line's press asks; only the question's own Confirm confirms; Cancel takes it back", () => {
    const askNewCodes = vi.fn();
    const confirmNewCodes = vi.fn();
    const cancelNewCodes = vi.fn();
    const verbs = { askNewCodes, confirmNewCodes, cancelNewCodes };
    drawn(listening(STATES.rest.model, verbs));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(button(sec("codesReplace"))!);
    expect(askNewCodes).toHaveBeenCalledTimes(1);
    expect(confirmNewCodes).not.toHaveBeenCalled();
    cleanup();

    drawn(listening(STATES.asked.model, verbs));
    const question = within(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog").textContent).toContain(sec("codesReplaceWarning"));
    fireEvent.click(question.getByRole("button", { name: sec("cancel") }));
    expect(cancelNewCodes).toHaveBeenCalledTimes(1);
    expect(confirmNewCodes).not.toHaveBeenCalled();
    fireEvent.click(question.getByRole("button", { name: sec("codesConfirm") }));
    expect(confirmNewCodes).toHaveBeenCalledTimes(1);
  });

  it("shows the new set once with what to do, and Done; the verb that replaces it is away meanwhile", () => {
    const codesDone = vi.fn();
    drawn(listening(STATES.codes.model, { codesDone }));
    expect(seen(sec("codesShownOnce"))).toBe(true);
    for (const code of CODES) expect(seen(code), code).toBe(true);
    expect(button(sec("codesReplace"))).toBeNull();
    fireEvent.click(button(sec("codesDone"))!);
    expect(codesDone).toHaveBeenCalledTimes(1);
  });

  it("a new set over a read that failed after it: the set and its Done stand, the failure said beside them", () => {
    const codesDone = vi.fn();
    drawn(listening(STATES.codesUnread.model, { codesDone }));
    expect(seen(sec("codesShownOnce"))).toBe(true);
    for (const code of CODES) expect(seen(code), code).toBe(true);
    expect(seen(own("notRead"))).toBe(true);
    expect(seen(FAILED)).toBe(true);
    // Done is all it offers: nothing that changes what is enrolled stands over an unread session.
    for (const key of CHANGING) expect(button(sec(key)), key).toBeNull();
    expect(screen.getAllByRole("button")).toEqual([button(sec("codesDone"))]);
    fireEvent.click(button(sec("codesDone"))!);
    expect(codesDone).toHaveBeenCalledTimes(1);
  });
});

describe("a new authenticator", () => {
  it("shows its key, takes six digits on a number pad, and turns on only with a code", () => {
    const activate = vi.fn();
    const typeCode = vi.fn();
    const cancelAuthenticator = vi.fn();
    drawn(listening(STATES.authenticatorKey.model, { activate, typeCode, cancelAuthenticator }));
    expect(seen(KEY)).toBe(true);
    const code = screen.getByRole("textbox", { name: sec("totpCodeLabel") });
    expect(code.getAttribute("inputmode")).toBe("numeric");
    expect(code.getAttribute("autocomplete")).toBe("one-time-code");
    expect((button(sec("totpActivate")) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(code, { target: { value: "123456" } });
    expect(typeCode).toHaveBeenCalledWith("123456");
    // The verbs that start or remove one are away while its key stands.
    for (const key of ["totpAdd", "totpReplace", "totpRemove"]) expect(button(sec(key)), key).toBeNull();
    fireEvent.click(button(sec("cancel"))!);
    expect(cancelAuthenticator).toHaveBeenCalledTimes(1);
    cleanup();

    const typed = { ...STATES.authenticatorKey.model.authenticator, code: " 123456 " };
    drawn(listening({ ...STATES.authenticatorKey.model, authenticator: typed }, { activate }));
    fireEvent.click(button(sec("totpActivate"))!);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("a code the server would not take is said at its field", () => {
    drawn(STATES.codeRefused.model);
    const code = screen.getByRole("textbox", { name: sec("totpCodeLabel") });
    expect(code.getAttribute("aria-invalid")).toBe("true");
    expect(seen(FAILED)).toBe(true);
    expect(seen(own("notDone"))).toBe(false);
  });

  it("its key over a read that failed after it: the key, its code, Turn it on and Cancel stand, the failure beside them", () => {
    const typeCode = vi.fn();
    const cancelAuthenticator = vi.fn();
    drawn(listening(STATES.keyUnread.model, { typeCode, cancelAuthenticator }));
    expect(seen(KEY)).toBe(true);
    expect(seen(own("notRead"))).toBe(true);
    expect(seen(FAILED)).toBe(true);
    // The sheet's own ways out are all it offers: nothing that changes what is enrolled stands over an unread session.
    for (const key of CHANGING) expect(button(sec(key)), key).toBeNull();
    expect(screen.getAllByRole("button")).toEqual([button(sec("totpActivate")), button(sec("cancel"))]);
    fireEvent.change(screen.getByRole("textbox", { name: sec("totpCodeLabel") }), {
      target: { value: "123456" },
    });
    expect(typeCode).toHaveBeenCalledWith("123456");
    fireEvent.click(button(sec("cancel"))!);
    expect(cancelAuthenticator).toHaveBeenCalledTimes(1);
  });
});

describe("what the last verb left to say", () => {
  it("a closed window is the sentence it has today, on the sheet", () => {
    drawn(STATES.windowClosed.model);
    expect(seen(own("notDone"))).toBe(true);
    expect(seen(sec("stepUpExpired"))).toBe(true);
  });

  it("a factor thrown away says nothing ran", () => {
    drawn(STATES.nothingRan.model);
    expect(seen(said("devices", "stepUpCancelledNothingRan"))).toBe(true);
  });

  it("a verb on its way says so, and every other verb is off", () => {
    drawn({ ...STATES.authenticatorOn.model, working: "newCodes" });
    expect(button(sec("codesReplace"))).toBeNull();
    const off = screen.getAllByRole("button") as HTMLButtonElement[];
    expect(off.map((b) => b.disabled)).toEqual([true, true, true]);
    expect(seen(sec("working"))).toBe(true);
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

describe("before the page's script, and where a secret may be", () => {
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

  it("a code and the key stand in what is read, never in an attribute", () => {
    for (const state of [STATES.codes, STATES.codesUnread, STATES.authenticatorKey, STATES.keyUnread]) {
      const { container } = drawn(state.model);
      const attributes = [...container.querySelectorAll("*")].flatMap((el) =>
        el.getAttributeNames().map((attribute) => el.getAttribute(attribute) ?? ""),
      );
      for (const secret of [...CODES, KEY])
        expect(
          attributes.filter((value) => value.includes(secret)),
          secret,
        ).toEqual([]);
      cleanup();
    }
  });
});

describe("the pane over its door", () => {
  function Pane({ door, factor }: { door: SecurityDoor; factor: FactorSlot }) {
    return <SecurityPane model={useSecurity(door)} factor={factor} />;
  }
  const settle = () => act(async () => {});
  const press = async (name: string, inside: HTMLElement = document.body) => {
    await act(async () => {
      fireEvent.click(within(inside).getByRole("button", { name }));
    });
  };
  const over = async (door: SecurityDoor, factor: FactorSlot = noFactor) => {
    const view = render(
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <Pane door={door} factor={factor} />
      </TextProvider>,
    );
    await settle();
    return view;
  };

  it("over a session that could not be read, offers none of the verbs that change it", async () => {
    const door = fakeSecurityDoor({ reads: [refusedWith(FAILED)], newCodes: [ok(CODES)] });
    await over(door);
    expect(seen(FAILED)).toBe(true);
    for (const key of CHANGING) expect(button(sec(key)), key).toBeNull();
    expect(door.calls()).toEqual(["read"]);
  });

  it("replaces the codes only from the question's Confirm, shows them once, and Done takes them off the page", async () => {
    const door = fakeSecurityDoor({ reads: [ok(ENROLLED.both), ok(ENROLLED.both)], newCodes: [ok(CODES)] });
    await over(door);
    await press(sec("codesReplace"));
    expect(door.calls()).toEqual(["read"]);
    await press(sec("codesConfirm"), screen.getByRole("dialog"));
    expect(door.calls()).toEqual(["read", "newCodes", "read"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    for (const code of CODES) expect(seen(code), code).toBe(true);
    await press(sec("codesDone"));
    for (const code of CODES) expect(document.body.innerHTML.includes(code), code).toBe(false);
  });

  it("a read that fails after the set is made: the set stays on the page with the failure beside it, until Done", async () => {
    const door = fakeSecurityDoor({ reads: [ok(ENROLLED.both), refusedWith(FAILED)], newCodes: [ok(CODES)] });
    await over(door);
    await press(sec("codesReplace"));
    await press(sec("codesConfirm"), screen.getByRole("dialog"));
    expect(door.calls()).toEqual(["read", "newCodes", "read"]);
    for (const code of CODES) expect(seen(code), code).toBe(true);
    expect(seen(own("notRead"))).toBe(true);
    expect(seen(FAILED)).toBe(true);
    await press(sec("codesDone"));
    for (const code of CODES) expect(document.body.innerHTML.includes(code), code).toBe(false);
    expect(seen(FAILED)).toBe(true);
    expect(door.calls()).toEqual(["read", "newCodes", "read"]);
  });

  it("a read that answers after the set is made: the set and what is enrolled, as before", async () => {
    const door = fakeSecurityDoor({
      reads: [ok(ENROLLED.both), ok(ENROLLED.passkey)],
      newCodes: [ok(CODES)],
    });
    await over(door);
    await press(sec("codesReplace"));
    await press(sec("codesConfirm"), screen.getByRole("dialog"));
    for (const code of CODES) expect(seen(code), code).toBe(true);
    expect(line(sec("codesTitle")).textContent).toContain(own("codesUnused"));
    expect(line(sec("totpTitle")).textContent).toContain(own("notSetUp"));
    expect(seen(own("notRead"))).toBe(false);
  });

  it("the factor is asked through the slot, and its verified answer makes the set once", async () => {
    const slot = { asked: null as GatedAsk | null };
    const factor: FactorSlot = (ask) => {
      slot.asked = ask;
      return null;
    };
    const door = fakeSecurityDoor({
      reads: [ok(ENROLLED.both), ok(ENROLLED.both)],
      newCodes: [FACTOR, ok(CODES)],
    });
    await over(door, factor);
    await press(sec("codesReplace"));
    await press(sec("codesConfirm"), screen.getByRole("dialog"));
    expect(door.calls()).toEqual(["read", "newCodes"]);
    expect(slot.asked).not.toBeNull();
    await act(async () => slot.asked!.onVerified());
    expect(door.calls()).toEqual(["read", "newCodes", "newCodes", "read"]);
    for (const code of CODES) expect(seen(code), code).toBe(true);
  });

  it("the code typed is sent trimmed, and Turn it on is off while none is typed", async () => {
    const door = fakeSecurityDoor({
      reads: [ok(ENROLLED.passkey), ok(ENROLLED.both)],
      starts: [ok({ key: KEY })],
      activates: [ok(null)],
    });
    await over(door);
    await press(sec("totpAdd"));
    expect((button(sec("totpActivate")) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: sec("totpCodeLabel") }), {
        target: { value: " 123456 " },
      });
    });
    await press(sec("totpActivate"));
    expect(door.codes()).toEqual(["123456"]);
    expect(document.body.innerHTML.includes(KEY)).toBe(false);
    expect(line(sec("totpTitle")).textContent).toContain(own("on"));
  });

  /* The key sheet's Cancel and an activation that is owed: the hook lives above the sheet, so closing it drops nothing. */
  async function activating(activates: readonly Handed<null>[]) {
    const asks: GatedAsk[] = [];
    const factor: FactorSlot = (ask) => {
      asks.push(ask);
      return <p>the factor</p>;
    };
    const door = fakeSecurityDoor({
      reads: [ok(ENROLLED.passkey), ok(ENROLLED.both)],
      starts: [ok({ key: KEY })],
      activates,
    });
    await over(door, factor);
    await press(sec("totpAdd"));
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: sec("totpCodeLabel") }), {
        target: { value: "123456" },
      });
    });
    await press(sec("totpActivate"));
    return { door, asks };
  }

  it("the key's Cancel while its code is on its way leaves nothing a factor would turn on", async () => {
    const first = held<Answer<null>>();
    const { door, asks } = await activating([first.promise, ok(null)]);
    expect(door.codes()).toEqual(["123456"]);
    const cancel = button(sec("cancel")) as HTMLButtonElement | null;
    expect(cancel).not.toBeNull();
    // A Cancel that is off while the code is on its way walks away from nothing: nothing more to read then.
    if (cancel!.disabled) return;
    fireEvent.click(cancel!);
    expect(screen.queryByRole("textbox", { name: sec("totpCodeLabel") })).toBeNull();
    await act(async () => {
      first.settle(FACTOR);
    });
    const askedAfterCancel = asks.length;
    for (const ask of [...asks]) {
      await act(async () => {
        ask.onVerified();
      });
    }
    expect({ askedAfterCancel, sent: door.codes().length }).toEqual({ askedAfterCancel: 0, sent: 1 });
  });

  it("the key's Cancel while the factor is asked for its code leaves nothing a factor would turn on either", async () => {
    const { door, asks } = await activating([FACTOR, ok(null)]);
    expect(asks.length).toBeGreaterThan(0);
    const cancel = button(sec("cancel")) as HTMLButtonElement | null;
    expect(cancel).not.toBeNull();
    // A Cancel that is off while the factor is asked leaves the dialog the one way out: nothing more to read then.
    if (cancel!.disabled) return;
    fireEvent.click(cancel!);
    for (const ask of [...asks]) {
      await act(async () => {
        ask.onVerified();
      });
    }
    expect(door.codes()).toEqual(["123456"]);
  });

  /* An enrolment started, new codes made while its key stands, and the read after them answered as handed. */
  async function keyThenRead(
    read: Handed<Enrolled>,
    factor: FactorSlot = noFactor,
    activates: Handed<null>[] = [],
  ) {
    const door = fakeSecurityDoor({
      reads: [ok(ENROLLED.passkey), read, ok(ENROLLED.both)],
      starts: [ok({ key: KEY })],
      newCodes: [ok(CODES)],
      activates,
    });
    await over(door, factor);
    await press(sec("totpAdd"));
    await press(sec("codesReplace"));
    await press(sec("codesConfirm"), screen.getByRole("dialog"));
    expect(door.calls()).toEqual(["read", "startAuthenticator", "newCodes", "read"]);
    return door;
  }

  it("a read that fails while a new key stands: the key stays on the page with the failure beside it, until its Cancel", async () => {
    const door = await keyThenRead(refusedWith(FAILED));
    expect(seen(KEY)).toBe(true);
    expect(seen(own("notRead"))).toBe(true);
    expect(seen(FAILED)).toBe(true);
    await press(sec("cancel"));
    expect(document.body.innerHTML.includes(KEY)).toBe(false);
    expect(seen(FAILED)).toBe(true);
    expect(door.calls()).toEqual(["read", "startAuthenticator", "newCodes", "read"]);
  });

  it("over that failed read the code that finishes the enrolment is still taken, through the factor it asks", async () => {
    const slot = { asked: null as GatedAsk | null };
    const factor: FactorSlot = (ask) => {
      slot.asked = ask;
      return <p>the factor</p>;
    };
    const door = await keyThenRead(refusedWith(FAILED), factor, [FACTOR, ok(null)]);
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: sec("totpCodeLabel") }), {
        target: { value: " 123456 " },
      });
    });
    await press(sec("totpActivate"));
    expect(seen("the factor")).toBe(true);
    await act(async () => slot.asked!.onVerified());
    expect(door.codes()).toEqual(["123456", "123456"]);
    expect(document.body.innerHTML.includes(KEY)).toBe(false);
    expect(line(sec("totpTitle")).textContent).toContain(own("on"));
    expect(seen(own("notRead"))).toBe(false);
  });

  it("a read that answers while a new key stands: the key, the set and what is enrolled, as before", async () => {
    await keyThenRead(ok(ENROLLED.passkey));
    expect(seen(KEY)).toBe(true);
    for (const code of CODES) expect(seen(code), code).toBe(true);
    expect(line(sec("codesTitle")).textContent).toContain(own("codesUnused"));
    expect(line(sec("totpTitle")).textContent).toContain(own("notSetUp"));
    expect(seen(own("notRead"))).toBe(false);
  });
});

describe("the pane's states", () => {
  const registered = new Set((registry as { states: { key: string }[] }).states.map((state) => state.key));
  const addresses = Object.values(STATES).flatMap((state) => (state.address === null ? [] : [state.address]));

  it("each address is a state the comparison registers, once", () => {
    expect(addresses.filter((address) => !registered.has(address))).toEqual([]);
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it("cover every picture of the pane itself", () => {
    const pictured = [...registered].filter((key) => {
      const parts = key.split("&");
      return (
        parts.includes("screen=settings") && parts.includes("sec=security") && !parts.includes("door=cloud")
      );
    });
    expect([...addresses].sort()).toEqual(pictured.sort());
  });
});
