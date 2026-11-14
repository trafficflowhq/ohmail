/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement as h, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authHintPreset } from "@ohmail/app-logic/mailboxes/connect/providers";
import { NO_DETAILS } from "@ohmail/app-logic/mailboxes/connect/refusal";
import { standaloneSaid } from "@ohmail/app-logic/mailboxes/connect/standalone-said";
import type { Refusal } from "@ohmail/app-logic/mailboxes/connect/types";
import { NONE, type ConnectWire } from "../../../src/host/index.js";
import { sentenceOf } from "../../../src/mailboxes/connect/sentence.js";
import {
  TextProvider,
  useTextLookup,
  type Locale,
  type Messages,
  type Text,
} from "../../../src/text/index.js";
import phoneDe from "../../../messages/phone.de.json" with { type: "json" };
import phone from "../../../messages/phone.en.json" with { type: "json" };
import { J, O, P, WORDS, draw, fakeDoor, id, later, no } from "./support.js";

/*
 * THE ONE FORM OPENED FOR A PHONE'S OWN MAILBOX, over a wire double: the name's field on this mount alone, no
 * username and no test, the connect as the phone's wire is handed it, and a refused open said by its code in the
 * phone's own words. Beside it: a wire with no test draws no test press on a mount that has one.
 */
const F = phone.phoneDoor.form;
const R: Record<string, string> = phone.phoneRefusal;
const ADDRESS = "ada@lichtgrat.example";
const IMAP = "mail.lichtgrat.example:993";
const SMTP = "smtp.lichtgrat.example:587";
const CONNECTED = { ok: true as const, value: { mailboxId: id("engine-account"), address: null } };
const type = (label: string, value: string): void =>
  void fireEvent.change(screen.getByLabelText(label), { target: { value } });
const press = (name: string): void => void fireEvent.click(screen.getByRole("button", { name }));
const settle = (): Promise<void> => act(async () => {});
/** A refusal as the phone's wire answers one. */
const refused = (code: string | null): Refusal => ({ status: 0, code, message: "", details: NO_DETAILS });
/** The page's words with the phone's place among them, as the door's page holds them. */
const withPhone = (form: ReactNode): ReactNode =>
  h(TextProvider, {
    locale: "en",
    messages: { ...WORDS, ...phone } as never,
    timeZone: "UTC",
    children: form,
  });
const open = (door: ConnectWire) =>
  draw(door, { purpose: { kind: "standalone" } }, { factor: NONE, around: withPhone });

function fill(): void {
  type(F.addressLabel, ADDRESS);
  press(P.otherLabel);
  type(F.imapHost, IMAP);
  type(F.smtpHost, SMTP);
  type(F.passwordLabel, "a-typed-password");
}

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  errors.mockRestore();
});

describe("opened for a phone's own mailbox", () => {
  it("draws the name's field, no username and no test press, and connects with the name as it is stored", async () => {
    const answer = later<typeof CONNECTED>();
    const { door, of } = fakeDoor({ connect: [answer.promise], ways: "none", discover: "none" });
    const view = open({ ...door, probe: NONE, edit: NONE });
    fill();
    type(F.nameLabel, "  Ada   Lovelace ");
    expect(screen.getByText(F.nameHint)).toBeTruthy();
    // The login is the address: this mount has no field for another, and no test of its own.
    expect([...document.querySelectorAll("input")].map((field) => field.getAttribute("type"))).toEqual([
      "email",
      "text",
      "text",
      "password",
      "text",
    ]);
    expect(screen.queryByRole("button", { name: O.test })).toBeNull();

    press(F.connect);
    expect(screen.getByRole("button", { name: F.opening })).toBeTruthy();
    answer.resolve(CONNECTED);
    await settle();
    const server = (host: string, port: number) => ({ host, port, user: ADDRESS, pass: "a-typed-password" });
    expect(of("connect").map((call) => call.sent)).toEqual([
      {
        input: {
          provider: "imap",
          address: ADDRESS,
          imap: server("mail.lichtgrat.example", 993),
          smtp: server("smtp.lichtgrat.example", 587),
          displayName: "Ada Lovelace",
        },
        mode: "seed",
      },
    ]);
    expect(of("probe")).toEqual([]);
    expect(view.done).toEqual([
      { kind: "connected", mailboxId: id("engine-account"), address: null, created: true },
    ]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("sends no name where none was typed", async () => {
    const { door, of } = fakeDoor({ connect: [CONNECTED], ways: "none", discover: "none" });
    open({ ...door, probe: NONE, edit: NONE });
    fill();
    press(F.connect);
    await settle();
    expect(of("connect")).toHaveLength(1);
    expect((of("connect")[0]!.sent as { input: object }).input).not.toHaveProperty("displayName");
  });

  it("a name that cannot be stored sends nothing and says so, with everything typed still there", async () => {
    const { door, calls } = fakeDoor({ connect: [CONNECTED], ways: "none", discover: "none" });
    const view = open({ ...door, probe: NONE, edit: NONE });
    fill();
    type(F.nameLabel, "Ada\u0007Lovelace");
    press(F.connect);
    await settle();
    expect(calls).toEqual([]);
    expect(screen.getByRole("alert").contains(screen.getByText(R.standaloneNameRefused!))).toBe(true);
    expect((screen.getByLabelText(F.passwordLabel) as HTMLInputElement).value).toBe("a-typed-password");
    // Mended, the same press connects.
    type(F.nameLabel, "Ada Lovelace");
    press(F.connect);
    await settle();
    expect(calls.filter((call) => call.verb === "connect")).toHaveLength(1);
    expect(view.done).toHaveLength(1);
  });

  it("says a refused open by its code in the phone's own words, the provider's names from the table, and what this build cannot word in the sentence for that", async () => {
    const preset = authHintPreset();
    const named = R.standaloneAuthAppOnly!.replaceAll("{0}", preset.label).replaceAll(
      "{1}",
      preset.account ?? preset.label,
    );
    const { door, of } = fakeDoor({
      connect: [
        no(refused("standaloneSignInRefused")),
        no(refused("standaloneAuthAppOnly")),
        no(refused("aCodeNoCatalogueHolds")),
        no(refused(null)),
        // Two sentences that are nothing but words that crossed with them: none is taken, and the line is never blank.
        no(refused("verbatimDetail")),
        no(refused("storeFault")),
      ],
      ways: "none",
      discover: "none",
    });
    open({ ...door, probe: NONE, edit: NONE });
    fill();
    for (const sentence of [R.standaloneSignInRefused, named, R.unknown, R.unknown, R.unknown, R.unknown]) {
      press(F.connect);
      await settle();
      expect(screen.getByRole("alert").contains(screen.getByText(sentence!))).toBe(true);
    }
    expect(of("connect")).toHaveLength(6);
    // A refusal keeps what was typed: the next press sends it again.
    expect((screen.getByLabelText(F.passwordLabel) as HTMLInputElement).value).toBe("a-typed-password");
    expect(errors).not.toHaveBeenCalled();
  });

  it.each(["en", "de"] as const)(
    "every code of the phone's refusals is said as a sentence with what the form hands it, never as a blank line (%s)",
    (locale) => {
      const catalogue: Record<Locale, Messages> = { en: phone as Messages, de: phoneDe as Messages };
      let lookup: ((namespace: string) => Text) | null = null;
      const Take = (): ReactNode => {
        lookup = useTextLookup();
        return null;
      };
      render(h(TextProvider, { locale, messages: catalogue[locale], timeZone: "UTC", children: h(Take) }));
      const text = lookup as unknown as (namespace: string) => Text;
      const unknown = text("phoneRefusal")("unknown");
      const keys = Object.keys(phone.phoneRefusal);
      expect(keys.length).toBeGreaterThan(250);
      const worded = keys.filter((key) => {
        const said = standaloneSaid(refused(key));
        if ("server" in said) throw new Error(`${key} is said in words that crossed`);
        const sentence = sentenceOf(said, text);
        expect(sentence.trim(), key).not.toBe("");
        return sentence !== unknown;
      });
      // What an open refuses with is the `standalone` family: each of those has its own sentence, none falls back.
      const family = keys.filter((key) => key.startsWith("standalone"));
      expect(family.length).toBeGreaterThan(30);
      expect(family.filter((key) => !worded.includes(key))).toEqual([]);
      // The sentences that are only a place fall back, where they would have been a blank line.
      expect(worded).not.toContain("verbatimDetail");
      // A place the form handed nothing for is reported by the reader: none was.
      expect(errors).not.toHaveBeenCalled();
    },
  );
});

describe("the mounts that stood", () => {
  it("draw no name field, and keep their username field", () => {
    const { door } = fakeDoor();
    draw(door, { purpose: { kind: "add" } }, { around: withPhone });
    type(O.address, ADDRESS);
    press(P.otherLabel);
    expect(screen.queryByLabelText(F.nameLabel)).toBeNull();
    expect(screen.getByLabelText(O.user)).toBeTruthy();
    cleanup();
    draw(door, { purpose: { kind: "join" } }, { around: withPhone });
    type(J.mailboxAddress, ADDRESS);
    press(P.otherLabel);
    expect(screen.queryByLabelText(F.nameLabel)).toBeNull();
    expect(screen.getByLabelText(J.mailboxUser)).toBeTruthy();
  });

  it("draw their test press over a wire that tests, and none over a wire that has no test", () => {
    const { door, calls } = fakeDoor();
    draw(door, { purpose: { kind: "add" } });
    type(O.address, ADDRESS);
    press(P.otherLabel);
    expect(screen.getByRole("button", { name: O.test })).toBeTruthy();
    cleanup();
    draw({ ...door, probe: NONE }, { purpose: { kind: "add" } });
    type(O.address, ADDRESS);
    press(P.otherLabel);
    expect(screen.queryByRole("button", { name: O.test })).toBeNull();
    expect(screen.getByRole("button", { name: O.connect })).toBeTruthy();
    expect(calls.filter((call) => call.verb === "probe")).toEqual([]);
  });
});
