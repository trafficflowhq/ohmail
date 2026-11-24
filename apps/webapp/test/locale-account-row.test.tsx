/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GeneralPane, type GeneralModel } from "@ohmail/app/settings/general";
import { TextProvider } from "@ohmail/app/text";
import { generalState } from "../../../packages/app/src/settings/general/states.js";
import en from "../messages/en.json";
import de from "../messages/de.json";

const settings = en.settings;
afterEach(cleanup);

function mount(language: GeneralModel["language"]) {
  const locale = language?.value === "de" ? "de" : "en";
  const words = locale === "de" ? de : en;
  const view = render(
    <TextProvider locale={locale} messages={words} timeZone="UTC">
      <GeneralPane model={{ ...generalState(), language }} />
    </TextProvider>,
  );
  const pane = within(view.container);
  return {
    ...view,
    language: () => within(pane.getByLabelText(words.settings.languageAria, { selector: "[aria-label]" })),
  };
}

function controlsFor(
  value: "en" | "de",
  set: (next: string) => Promise<void>,
  local = false,
): NonNullable<GeneralModel["language"]> {
  return { value, choices: ["en", "de"], set, busy: false, local };
}

describe("Settings → General → Language", () => {
  it("promises an account-wide language only where a host writes the account", () => {
    const account = mount(controlsFor("en", async () => {}));
    expect(account.container.textContent).toContain(settings.languageHint);
    expect(account.container.textContent).not.toContain(settings.languageHintLocal);
    account.unmount();

    const install = mount(controlsFor("en", async () => {}, true));
    expect(install.container.textContent).toContain(settings.languageHintLocal);
    expect(
      install.container.textContent,
      "a standalone install promised a language that follows an account it has no client for",
    ).not.toContain(settings.languageHint);
  });

  it("offers both languages, each named in its own language, with the active one pressed", () => {
    const selector = mount(controlsFor("de", async () => {})).language();
    expect(selector.getAllByRole("button").map((button) => button.textContent)).toEqual(["English", "Deutsch"]);
    expect(selector.getAllByRole("button", { pressed: true }).map((button) => button.textContent)).toEqual(["Deutsch"]);
  });

  it("pressing a language calls setLocale ONCE with that language", async () => {
    const calls: string[] = [];
    const selector = mount(controlsFor("en", async (next) => { calls.push(next); })).language();
    await act(async () => { fireEvent.click(selector.getByRole("button", { name: "Deutsch" })); });
    expect(calls).toEqual(["de"]);
    await act(async () => { fireEvent.click(selector.getByRole("button", { name: "English" })); });
    expect(calls).toEqual(["de"]);
  });

  it("a REFUSED write leaves the control where it was and SAYS so", async () => {
    const view = mount(controlsFor("en", async () => { throw new Error("write refused"); }));
    const selector = view.language();
    await act(async () => { fireEvent.click(selector.getByRole("button", { name: "Deutsch" })); });
    expect(selector.getAllByRole("button", { pressed: true }).map((button) => button.textContent)).toEqual(["English"]);
    expect(view.container.textContent).toContain(settings.languageFailed);
  });

  it("NO PROVIDER ⇒ NO ROW — the demo and every bare pane, rather than a control that cannot control", () => {
    const { container } = mount(null);
    const pane = within(container);
    expect(pane.getByRole("button", { name: settings.themeAuto })).toBeTruthy();
    expect(pane.queryByRole("group", { name: settings.languageAria })).toBeNull();
    expect(container.textContent).not.toContain(settings.languageHint);
    expect(container.textContent).not.toContain(settings.languageHintLocal);
  });
});
