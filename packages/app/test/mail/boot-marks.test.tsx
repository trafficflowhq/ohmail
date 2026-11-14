/** @vitest-environment jsdom */
/**
 * THE APP TIMES ITSELF FROM THE FRAME'S FIRST DRAW (`MailBoot` on the mail ground). The cold start's own measure, "a
 * list a person can use", is marked once mail is on screen, or once an empty mailbox has been drained: never before,
 * so the figure is the wait a person sat through and not the first draw of an empty frame.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import { EngineContext } from "@ohmail/app-logic/engine";
import { resetUiVitalsForTest, startupMarks } from "@ohmail/app-logic/session/ui-vitals";
import { SYNC_BOOTSTRAPPING, SYNC_SETTLED, type SyncStatus } from "@ohmail/app-logic/session/sync-scheduler";
import type { FramePlaces } from "../../src/frame/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import { MailGround } from "../../src/mail/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeMail, letter, WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress } from "../support/fake-window.js";

const PLACES: Partial<FramePlaces> = {
  ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: () => <p>the Ohbox</p> } },
};

/** The frame over the ground, its engine's sync in the state a case names. */
function drawn(engine: OhmailEngine, sync: SyncStatus) {
  const { host } = fakeHost({
    engine,
    service: "self",
    scope: "acct-1",
    places: PLACES,
    above: MailGround,
    address: fakeAddress("#/ohbox"),
  });
  return (
    <EngineContext.Provider value={{ engine, demo: false, serverDemo: false, sync }}>
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <Frame host={host} />
      </TextProvider>
    </EngineContext.Provider>
  );
}
const usable = (): number | null => startupMarks().listUsable;

beforeEach(() => {
  resetUiVitalsForTest();
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  resetUiVitalsForTest();
});

describe("cold start to a usable list, marked by the ground", () => {
  it("is not marked while nothing is on screen, and is marked once the first letter arrives", () => {
    const mail = fakeMail([]);
    render(drawn(mail.engine, SYNC_BOOTSTRAPPING));
    expect(usable(), "marked before any mail was on screen").toBeNull();
    act(() => mail.add(letter("m1")));
    expect(usable()).not.toBeNull();
  });

  it("an empty mailbox is marked once it has been drained, and the first figure stands", () => {
    const mail = fakeMail([]);
    const view = render(drawn(mail.engine, SYNC_BOOTSTRAPPING));
    expect(usable()).toBeNull();
    view.rerender(drawn(mail.engine, SYNC_SETTLED));
    const first = usable();
    expect(first).not.toBeNull();
    act(() => mail.add(letter("m1")));
    expect(usable(), "a later draw wrote over the cold figure").toBe(first);
  });
});
