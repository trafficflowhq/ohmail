/** @vitest-environment jsdom */
/**
 * THE ACCOUNT'S LANGUAGE, OFFERED AT START (`MailBoot` on the mail ground): the language the account's consent row names
 * is ADOPTED by the controls the host wraps around the frame, once, where it is not the language being drawn. An
 * adoption moves what is drawn and never writes the account back; no language in the row, or the same one, moves
 * nothing; a host that hands no controls is asked nothing.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrameHost, PlaceEntry } from "../../src/frame/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import { NONE, type ConsentWire, type HostLanguage } from "../../src/host/index.js";
import { MailGround } from "../../src/mail/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeMail, letter, WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress } from "../support/fake-window.js";

const OHBOX: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: null,
  panes: { kind: "wide", Wide: () => <p>the Ohbox</p> },
};

/** The consent row as the account's server answers it, with the language a case names. */
const rowOf = (locale: string | null) => ({
  seedConfirmedAt: "2026-11-01T00:00:00.000Z",
  dormancyDays: 60,
  blockRemoteImagesAt: null,
  loadTrackingPixelsAt: null,
  onboardingCompletedAt: "2026-11-01T00:00:00.000Z",
  screeningBaselineAt: null,
  locale,
});
const consentOf = (row: object): ConsentWire => ({ state: async () => row }) as unknown as ConsentWire;

/** The host's controls over a device drawn in English: the adoption, and beside it a door that would write the account. */
function controlsOf() {
  const adoptLocale = vi.fn(async (_next: "en" | "de") => undefined);
  const setLocale = vi.fn(async (_next: "en" | "de") => undefined);
  const controls = { locale: "en" as const, adoptLocale, setLocale };
  return { language: controls as HostLanguage, adoptLocale, setLocale };
}

/** The ground's reads answer over a few turns (the consent row, then what follows from it). */
const answered = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn += 1) await act(async () => {});
};

function mount(row: object, language: HostLanguage | typeof NONE) {
  const address = fakeAddress("#/ohbox");
  const { host } = fakeHost({
    engine: fakeMail([letter("m1")]).engine,
    service: "self",
    scope: "acct-1",
    places: { ohbox: OHBOX },
    above: MailGround,
    wires: { consent: consentOf(row) },
    address,
  });
  const withControls: FrameHost = { ...host, device: { ...host.device, language } };
  const view = render(
    <TextProvider locale="en" messages={WORDS.en} timeZone="UTC">
      <Frame host={withControls} />
    </TextProvider>,
  );
  return { address, view, host: withControls };
}

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the account's language, offered at start", () => {
  it("an account whose row says German, on a device drawn in English, adopts German once and writes nothing", async () => {
    const { language, adoptLocale, setLocale } = controlsOf();
    const { address } = mount(rowOf("de"), language);
    await answered();
    expect(adoptLocale.mock.calls).toEqual([["de"]]);
    act(() => address.visit("#/reads"));
    await answered();
    expect(adoptLocale, "a walk adopted the language again").toHaveBeenCalledOnce();
    expect(setLocale, "the account was written back the value it was read with").not.toHaveBeenCalled();
  });

  it("a row with no language adopts nothing: the device stands", async () => {
    const { language, adoptLocale, setLocale } = controlsOf();
    mount(rowOf(null), language);
    await answered();
    expect(adoptLocale).not.toHaveBeenCalled();
    expect(setLocale).not.toHaveBeenCalled();
  });

  it("the language already drawn is not adopted again", async () => {
    const { language, adoptLocale } = controlsOf();
    mount(rowOf("en"), language);
    await answered();
    expect(adoptLocale).not.toHaveBeenCalled();
  });

  it("a host that hands no controls is asked nothing, and the frame stands", async () => {
    mount(rowOf("de"), NONE);
    await answered();
    expect(screen.getByText("the Ohbox")).toBeTruthy();
  });
});
