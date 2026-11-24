/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsentContext, useConsentState } from "@ohmail/app-logic/consent";
import { READER_SCROLL_STEP } from "@ohmail/app-logic/keys";
import { Frame } from "@ohmail/app/frame";
import { mailSettings, NO_PANE_PARTS } from "@ohmail/app/mail";
import { TextProvider } from "@ohmail/app/text";
import { madeOf, SETTINGS } from "../../../packages/app/test/settings/frame/hosts.js";
import { FRAME_WORDS } from "../../../packages/app/test/support/frame-words.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import settingsWords from "../../../packages/app/messages/settings.en.json";
import menuWords from "../../../packages/app/messages/settings-menu.en.json";

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

function General() {
  return <label>Display name<input /></label>;
}
const empty = () => null;
const settings = mailSettings({
  ...NO_PANE_PARTS,
  general: General,
  notifications: empty,
  help: empty,
  about: empty,
});

function AccountSettings({ host }: { host: Parameters<typeof Frame>[0]["host"] }) {
  const consent = useConsentState(false, host.session.scope, "none");
  return <ConsentContext.Provider value={consent}><Frame host={host} /></ConsentContext.Provider>;
}

async function mount() {
  const { host } = madeOf(SETTINGS["W-d"]!, {
    address: fakeAddress("#/settings/general"),
    window: fakeWindow("desktop"),
    places: { settings },
  });
  render(
    <TextProvider locale="en" messages={{ ...FRAME_WORDS.en, ...settingsWords, ...menuWords }} timeZone="UTC">
      <AccountSettings host={host} />
    </TextProvider>,
  );
  await screen.findByRole("navigation", { name: "Settings sections" });
  await screen.findByRole("region", { name: "General" });
}

const key = (word: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key: word });
const focused = () => document.activeElement;
const navButtons = () => within(screen.getByRole("navigation", { name: "Settings sections" })).getAllByRole("button");
const general = () => screen.getByRole("region", { name: "General" });
const settingsRail = () => within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: "Settings" });

describe("the zone model inside Settings", () => {
  it("↓ enters the nav on its active pane and ↓/↑ rove it, clamped at both ends", async () => {
    await mount();
    const items = navButtons();
    expect(items.length, "fixture: the nav must hold rows to rove").toBeGreaterThan(2);
    expect(items[0]).toBe(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "General" }));
    expect(items[0]!.getAttribute("aria-current")).toBe("page");

    key("ArrowDown");
    expect(focused()).toBe(items[0]);
    key("ArrowDown");
    expect(focused()).toBe(items[1]);
    key("ArrowUp");
    expect(focused()).toBe(items[0]);
    key("ArrowUp");
    expect(focused()).toBe(items[0]);
    for (const _item of items) key("ArrowDown");
    expect(focused()).toBe(items.at(-1));
    key("ArrowDown");
    expect(focused()).toBe(items.at(-1));
  });

  it("→ dives into the pane column — a named, focusable region — and ↓/↑ scroll the view", async () => {
    await mount();
    key("ArrowDown");
    key("ArrowRight");

    const pane = general();
    expect(focused()).toBe(pane);
    expect(pane.tabIndex).toBe(-1);
    expect(pane.scrollTop).toBe(0);
    key("ArrowDown");
    expect(pane.scrollTop).toBe(READER_SCROLL_STEP);
    key("ArrowUp");
    expect(pane.scrollTop).toBe(0);
  });

  it("Escape walks back left: pane → nav → rail; ← from the nav reaches the rail too", async () => {
    await mount();
    const active = navButtons()[0];
    key("ArrowDown");
    key("ArrowRight");
    expect(focused()).toBe(general());

    key("Escape");
    expect(focused()).toBe(active);
    key("Escape");
    expect(focused()).toBe(settingsRail());

    key("ArrowRight");
    expect(focused()).toBe(active);
    key("ArrowLeft");
    expect(focused()).toBe(settingsRail());
  });

  it("arrows never touch a settings input", async () => {
    await mount();
    const input = screen.getByRole("textbox", { name: "Display name" });
    input.focus();
    key("ArrowUp");
    expect(focused()).toBe(input);
    expect(general().scrollTop).toBe(0);
  });
});
