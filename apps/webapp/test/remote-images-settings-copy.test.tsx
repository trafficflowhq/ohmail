/** @vitest-environment jsdom */
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GeneralPane } from "@ohmail/app/settings/general";
import { TextProvider } from "@ohmail/app/text";
import { generalState } from "../../../packages/app/src/settings/general/states.js";
import messages from "../messages/en.json";
import de from "../messages/de.json";

afterEach(cleanup);

describe("the Settings copy names the machine that fetches the pictures", () => {
  /** The shared pane over each host's image model, with both kinds of pictures allowed. */
  function rows(fromComputer: boolean, locale: "en" | "de"): string {
    const words = locale === "en" ? messages : de;
    const allow = { blocked: false, fromComputer, set: async () => true };
    const view = render(
      <TextProvider locale={locale} messages={words} timeZone="UTC">
        <GeneralPane model={{ ...generalState(), images: allow, pixels: allow }} />
      </TextProvider>,
    );
    try {
      const pane = within(view.container);
      expect(within(pane.getByRole("group", { name: words.settings.images.title })).getByRole("switch", { checked: true })).toBeTruthy();
      expect(within(pane.getByRole("group", { name: words.settings.pixels.title })).getByRole("switch", { checked: false })).toBeTruthy();
      return view.container.textContent ?? "";
    } finally {
      view.unmount();
    }
  }

  it("a computer of the reader's own promises no proxy, in either language", () => {
    for (const locale of ["en", "de"] as const) {
      expect(rows(true, locale)).not.toMatch(/proxy/i);
    }
  });

  it("pictures ON says mail in the Screener asks first, on either door and in either language", () => {
    for (const locale of ["en", "de"] as const) {
      for (const fromComputer of [false, true]) {
        expect(rows(fromComputer, locale)).not.toMatch(/Screener/i);
      }
    }
  });
});
