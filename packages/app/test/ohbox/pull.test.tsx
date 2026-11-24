/** @vitest-environment jsdom */
/**
 * PULL NEW MAIL AT THE OHBOX (the switch's point 66): the mail ground's one binding is handed to the
 * Ohbox, so "Ohbox actions" offers Pull new mail where the engine can pull (and the list under a finger takes the
 * same pull), as today's shell handed its one binding to the view. One binding: a press while a pull is out rings
 * nothing a second time. Where nothing can pull, nothing offers it.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import { Frame } from "../../src/frame/Frame.js";
import { NONE } from "../../src/host/index.js";
import { MailGround, mailPlaces, mailReader } from "../../src/mail/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import frameEn from "../../messages/frame.en.json" with { type: "json" };
import ohboxEn from "../../messages/ohbox.en.json" with { type: "json" };
import tagsEn from "../../messages/tags.en.json" with { type: "json" };
import { bodyDouble, fakeMail, letter, WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";

const READER = mailReader({ body: bodyDouble().body, look: NONE });
const MESSAGES = { ...WORDS.en, ...tagsEn, cursor: frameEn.cursor } as Messages;
const O = ohboxEn.ohbox.list;

let rings = 0;
/** An answer to the pull the test holds open: one flight at a time. */
let answer: (() => void) | null = null;
function seat(canPull: boolean) {
  const mail = fakeMail([letter("a")]);
  Object.assign(mail.engine, {
    pullAvailable: () => canPull,
    requestPull: () => {
      rings += 1;
      return new Promise<{ mailboxes: string[] }>((done) => {
        answer = () => done({ mailboxes: [] });
      });
    },
    syncOnce: async () => undefined,
  });
  const { host } = fakeHost({
    engine: mail.engine as OhmailEngine,
    service: "self",
    scope: "acct-1",
    places: mailPlaces(),
    above: MailGround,
    reader: READER,
    window: fakeWindow("phone"),
    address: fakeAddress("#/ohbox"),
  });
  render(
    <TextProvider locale="en" messages={MESSAGES} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>,
  );
}
const openMenu = () => fireEvent.click(screen.getByRole("button", { name: O.menu }));
const pullItem = () => screen.queryByRole("menuitem", { name: new RegExp(O.pull) });

beforeEach(() => {
  rings = 0;
  answer = null;
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(cleanup);

describe("Pull new mail at the Ohbox, over the ground's one binding", () => {
  it("Ohbox actions offers it; a press rings once, and a press while that pull is out rings nothing more", async () => {
    seat(true);
    openMenu();
    expect(pullItem(), "the menu offers Pull new mail").not.toBeNull();
    fireEvent.click(pullItem()!);
    expect(rings).toBe(1);
    openMenu();
    if (pullItem() && !(pullItem() as HTMLButtonElement).disabled) fireEvent.click(pullItem()!);
    expect(rings, "a second flight while one is out").toBe(1);
    await act(async () => {
      answer?.();
      await Promise.resolve();
    });
  });

  it("offers nothing where nothing can pull", () => {
    seat(false);
    openMenu();
    expect(pullItem()).toBeNull();
  });
});
