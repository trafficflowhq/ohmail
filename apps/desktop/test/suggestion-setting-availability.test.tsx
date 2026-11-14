/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConsentContext } from "@ohmail/app-logic/consent";
import { Frame } from "@ohmail/app/frame";
import { TextProvider } from "@ohmail/app/text";
import { mailSettings } from "@ohmail/app/mail";
import type { ConsentWire } from "@ohmail/app/host";
import { MailStateMount } from "../../../packages/app/src/mail/ground/MailStateMount.js";
import { fakeMail } from "../../../packages/app/test/reader/support/mail.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import { pairedAccountDoor, pairedPaneParts } from "../../../test/support/paired-mail-fixtures.js";
import { en as messages } from "../../../test/support/web-catalogues.js";
import { DesktopAutoSuggest } from "../src/DesktopAutoSuggest.js";
import { bridgeFetch } from "../src/bridge-fetch.js";
import type { ConsentRow } from "@ohmail/app-logic/consent";

vi.mock("../src/bridge-fetch.js", () => ({ bridgeFetch: vi.fn() }));

const bridge = vi.mocked(bridgeFetch);
const setting = () => screen.getByRole<HTMLButtonElement>("switch", {
  name: messages.screener.suggest.autoTitle,
});
const day = "2026-09-15T08:00:00.000Z";
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

beforeEach(() => {
  bridge.mockReset();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});

afterEach(cleanup);

it("shows a disabled Off preference while the standalone read is pending or refused", async () => {
  let answer!: (res: Response) => void;
  bridge.mockImplementation(async (path) =>
    path === "/local/auto-suggest" ? new Promise((resolve) => { answer = resolve; }) : reply({}));
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <DesktopAutoSuggest />
    </IntlProvider>,
  );
  expect(setting().disabled).toBe(true);
  expect(setting().getAttribute("aria-checked")).toBe("false");
  await act(async () => { answer(reply({}, 503)); });
  expect(setting().disabled).toBe(true);
  expect(setting().getAttribute("aria-checked")).toBe("false");
  expect(screen.getByText(messages.desktopScreener.autoSuggestOff)).toBeTruthy();
  fireEvent.click(setting());
  expect(bridge.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(false);
});

it.each([null, day])("shows the paired computer's suggestion status as read-only (%s)", (stamp) => {
  const setAutoSuggest = vi.fn();
  const consent = {
    suggestionConsentKnown: stamp !== null,
    autoSuggest: stamp !== null,
    autoSuggestAt: stamp,
    setAutoSuggest,
  } as unknown as ConsentRow;
  const panes = pairedPaneParts(() => pairedAccountDoor(async () => undefined), () => null);
  const { host } = fakeHost({
    engine: fakeMail([]).engine, service: "ownComputer", scope: "paired",
    window: fakeWindow("desktop"), address: fakeAddress("#/settings/screener"),
    above: MailStateMount,
    features: { screener: { name: "screener", render: () => null } },
    wires: { consent: { setAutoSuggest } as unknown as ConsentWire },
    places: { settings: mailSettings(panes) },
  });
  render(
    <TextProvider locale="en" messages={messages} timeZone="UTC">
      <ConsentContext.Provider value={consent}><Frame host={host} /></ConsentContext.Provider>
    </TextProvider>,
  );
  expect(setting().disabled).toBe(true);
  expect(setting().getAttribute("aria-checked")).toBe(String(stamp !== null));
  fireEvent.click(setting());
  expect(setAutoSuggest).not.toHaveBeenCalled();
});
