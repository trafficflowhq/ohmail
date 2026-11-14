/** @vitest-environment jsdom */
/**
 * THE ONE NUMBER A NATIVE SHELL IS TOLD (`MailBadge` on the mail ground): the Ohbox's unread count, put on the app's
 * icon by a host that has a badge. It is the count the Ohbox's rail entry draws, told once it may be stated and again
 * as letters arrive and are read. A host with no badge is told nothing, and the frame stands.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import { EngineContext } from "@ohmail/app-logic/engine";
import { SYNC_BOOTSTRAPPING, SYNC_SETTLED, type SyncStatus } from "@ohmail/app-logic/session/sync-scheduler";
import type { FrameHost } from "../../src/frame/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import { NONE } from "../../src/host/index.js";
import { MailGround } from "../../src/mail/index.js";
import { ohboxPlace } from "../../src/ohbox/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeMail, letter, WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress } from "../support/fake-window.js";

/** The letters' sender, admitted by a rule: the partition presents a decided sender's mail in the Ohbox. */
const ADMITTED = {
  "rule:r1": {
    id: "r1",
    kind: "sender",
    match: "ben@kiln.example",
    destination: "INBOX",
    priority: 0,
    provenance: "manual",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

/** What the app's icon was told, in order. */
let told: number[] = [];

/** The frame over the ground at History, over a host whose badge is counted or which has none. */
function hostOf(engine: OhmailEngine, badge: boolean): FrameHost {
  const { host } = fakeHost({
    engine,
    service: "self",
    scope: "acct-1",
    address: fakeAddress("#/history"),
    places: {
      ohbox: ohboxPlace,
      history: {
        id: "history",
        body: "history",
        rail: null,
        panes: { kind: "wide", Wide: () => <p>History</p> },
      },
    },
    above: MailGround,
  });
  const count = (unread: number): void => void told.push(unread);
  return { ...host, device: { ...host.device, badge: badge ? count : NONE } };
}
const over = (engine: OhmailEngine, host: FrameHost, sync: SyncStatus) => (
  <EngineContext.Provider value={{ engine, demo: false, serverDemo: false, sync }}>
    <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>
  </EngineContext.Provider>
);

beforeEach(() => {
  told = [];
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the unread count on the app's icon", () => {
  it("is told the Ohbox's count once it may be stated, then as letters arrive and are read", () => {
    const mail = fakeMail([letter("m0"), letter("m1"), letter("m2", { unread: false })], [], {}, ADMITTED);
    const host = hostOf(mail.engine, true);
    const page = render(over(mail.engine, host, SYNC_BOOTSTRAPPING));
    expect(told, "a count told before the Ohbox may state it").toEqual([]);
    page.rerender(over(mail.engine, host, SYNC_SETTLED));
    expect(told.at(-1)).toBe(2);
    act(() => mail.add(letter("m3")));
    expect(told.at(-1), "a letter arrived and the icon was not told").toBe(3);
    act(() => {
      mail.patch("m0", { unread: false });
      mail.patch("m1", { unread: false });
      mail.patch("m3", { unread: false });
    });
    expect(told.at(-1), "the letters were read and the icon still said they were not").toBe(0);
  });

  it("a host with no badge is told nothing, and the frame stands", () => {
    const mail = fakeMail([letter("m0")], [], {}, ADMITTED);
    render(over(mail.engine, hostOf(mail.engine, false), SYNC_SETTLED));
    expect(screen.getByText("History")).toBeTruthy();
    expect(told).toEqual([]);
  });
});
