/** @vitest-environment jsdom */
/**
 * THE OHBOX's VISIT MARK, WRITTEN BY THE GROUND (the switch's point 66): when a person leaves the Ohbox for
 * another place, the engine's visit mark moves, as today's shell wrote it, so what was filed elsewhere since is
 * counted from there. The ground writes it, not the Ohbox's seat (which leaves with the walk). Opening a letter at the
 * Ohbox is no leave; the demo writes nothing. (Where the count is drawn is the studio's: the Ohbox's head draws no
 * where-line, `planner/DIFFERENCES-FROM-TODAY.md`.)
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import { EngineContext } from "@ohmail/app-logic/engine";
import { SYNC_SETTLED } from "@ohmail/app-logic/session/sync-scheduler";
import type { FramePlaces } from "../../src/frame/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import { MailGround } from "../../src/mail/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeMail, letter, WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, type FakeAddress } from "../support/fake-window.js";

const PLACES: Partial<FramePlaces> = {
  ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: () => <p>the Ohbox</p> } },
  search: { id: "search", body: "search", rail: null, panes: { kind: "wide", Wide: () => <p>Search</p> } },
};

let mail = fakeMail([]);
function drawn(demo: boolean) {
  mail = fakeMail([letter("m1")]);
  const engine: OhmailEngine = mail.engine;
  const address = fakeAddress("#/ohbox");
  const { host } = fakeHost({
    engine,
    service: "self",
    scope: "acct-1",
    places: PLACES,
    above: MailGround,
    address,
  });
  render(
    <EngineContext.Provider value={{ engine, demo, serverDemo: demo, sync: SYNC_SETTLED }}>
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <Frame host={host} />
      </TextProvider>
    </EngineContext.Provider>,
  );
  return address;
}
const visit = async (address: FakeAddress, to: string) => {
  act(() => address.visit(to));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
};

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the Ohbox's visit mark, written by the mail ground", () => {
  it("moves once when the person leaves the Ohbox for another place, and not while they stay", async () => {
    const address = drawn(false);
    expect(document.body.textContent).toContain("the Ohbox");
    await visit(address, "#/ohbox/m/m1");
    expect(mail.visitMarks.count, "opening a letter at the Ohbox is no leave").toBe(0);
    await visit(address, "#/search");
    expect(document.body.textContent).toContain("Search");
    expect(mail.visitMarks.count).toBe(1);
    await visit(address, "#/search");
    expect(mail.visitMarks.count).toBe(1);
  });

  it("writes nothing on the demo", async () => {
    const address = drawn(true);
    await visit(address, "#/search");
    expect(mail.visitMarks.count).toBe(0);
  });
});
