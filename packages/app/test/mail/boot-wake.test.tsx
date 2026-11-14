/** @vitest-environment jsdom */
/**
 * BEING WOKEN, PUT BACK AT BOOT (`MailBoot` on the mail ground). The frame comes up once per sign-in: the host's
 * wake registration is brought back to what the stored switches ask for, once, with the words the worker may draw.
 * The words then follow the account's language by a RELABEL: the reconcile is never run a second time for them,
 * because a reconcile works "may draw" out again, and that is how a previous person's surviving registration would
 * be armed again. Nothing is asked on the demo, and nothing before the sentence is there.
 */
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import { EngineContext } from "@ohmail/app-logic/engine";
import { SYNC_SETTLED } from "@ohmail/app-logic/session/sync-scheduler";
import type { FrameHost, FramePlaces } from "../../src/frame/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import { NONE, type DeviceNotifications } from "../../src/host/index.js";
import { MailGround } from "../../src/mail/index.js";
import { TextProvider, type Locale, type Messages } from "../../src/text/index.js";
import { fakeMail, letter, WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, type FakeAddress } from "../support/fake-window.js";
import settingsDe from "../../messages/settings.de.json" with { type: "json" };
import settingsEn from "../../messages/settings.en.json" with { type: "json" };

const PLACES: Partial<FramePlaces> = {
  ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: () => <p>the Ohbox</p> } },
  news: { id: "news", body: "news", rail: null, panes: { kind: "wide", Wide: () => <p>News</p> } },
};
/** The catalogue with Settings' words, where the worker's sentence stands; and the first screen's cut, without. */
const WHOLE: Readonly<Record<Locale, Messages>> = {
  en: { ...WORDS.en, ...settingsEn } as Messages,
  de: { ...WORDS.de, ...settingsDe } as Messages,
};

/** What the host's two doors were asked, in order. */
let asked: string[] = [];
const DOORS: DeviceNotifications = {
  permission: () => "granted",
  request: async () => "granted",
  emitter: NONE,
  reconcile: async (body) => {
    asked.push(`reconcile "${body}"`);
    return "subscribed";
  },
  relabel: async (title, body) => {
    asked.push(`relabel ${title} "${body}"`);
  },
};

function hostOf(
  scope: string,
  address: FakeAddress,
  engine: OhmailEngine,
  doors: DeviceNotifications | null,
) {
  const { host } = fakeHost({ engine, service: "self", scope, places: PLACES, above: MailGround, address });
  return doors === null ? host : { ...host, device: { ...host.device, notifications: doors } };
}
const drawn = (host: FrameHost, locale: Locale, messages: Messages): ReactNode => (
  <TextProvider locale={locale} messages={messages} timeZone="Europe/Zurich">
    <Frame host={host} />
  </TextProvider>
);

beforeEach(() => {
  asked = [];
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("being woken, put back at boot", () => {
  it("puts the registration back once as the frame comes up, with the worker's words; a walk asks nothing more", () => {
    const address = fakeAddress("#/ohbox");
    const host = hostOf("acct-1", address, fakeMail([letter("m1")]).engine, DOORS);
    const view = render(drawn(host, "en", WHOLE.en));
    expect(asked).toEqual(['reconcile "New mail."', 'relabel ohmail "New mail."']);
    act(() => address.visit("#/reads"));
    view.rerender(drawn(host, "en", WHOLE.en));
    expect(asked).toHaveLength(2);
  });

  it("the words follow the account's language by a relabel, and the reconcile is never run again for them", () => {
    const host = hostOf("acct-1", fakeAddress("#/ohbox"), fakeMail([letter("m1")]).engine, DOORS);
    const view = render(drawn(host, "en", WHOLE.en));
    view.rerender(drawn(host, "de", WHOLE.de));
    expect(asked).toEqual([
      'reconcile "New mail."',
      'relabel ohmail "New mail."',
      'relabel ohmail "Neue Mail."',
    ]);
  });

  it("asks nothing on the demo, read off the browser's own answer and not the flag the page was served with", () => {
    const { engine } = fakeMail([letter("m1")]);
    const host = hostOf("acct-1", fakeAddress("#/ohbox"), engine, DOORS);
    render(
      <EngineContext.Provider value={{ engine, demo: true, serverDemo: false, sync: SYNC_SETTLED }}>
        {drawn(host, "en", WHOLE.en)}
      </EngineContext.Provider>,
    );
    expect(asked).toEqual([]);
  });

  it("asks nothing before the sentence is there, and then once: an empty sentence never reaches the worker", () => {
    const host = hostOf("acct-1", fakeAddress("#/ohbox"), fakeMail([letter("m1")]).engine, DOORS);
    const view = render(drawn(host, "en", WORDS.en));
    expect(asked).toEqual([]);
    view.rerender(drawn(host, "en", WHOLE.en));
    expect(asked).toEqual(['reconcile "New mail."', 'relabel ohmail "New mail."']);
  });

  it("once per sign-in: under the next account the registration is put back again, once", () => {
    const address = fakeAddress("#/ohbox");
    const { engine } = fakeMail([letter("m1")]);
    const view = render(drawn(hostOf("acct-1", address, engine, DOORS), "en", WHOLE.en));
    view.rerender(drawn(hostOf("acct-2", address, engine, DOORS), "en", WHOLE.en));
    expect(asked.filter((line) => line.startsWith("reconcile"))).toHaveLength(2);
  });

  it("a host that registers no wake is asked nothing, and the frame stands", () => {
    const host = hostOf("acct-1", fakeAddress("#/ohbox"), fakeMail([letter("m1")]).engine, null);
    const view = render(drawn(host, "en", WHOLE.en));
    expect(view.getByText("the Ohbox")).toBeTruthy();
    expect(asked).toEqual([]);
  });
});
