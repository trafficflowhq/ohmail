/** @vitest-environment jsdom */
/**
 * AN ENGINE HANDED IN IS READY AT ONCE. The desktop window, the paired page and `/demo` mount the provider with their
 * own engine and no word for the first frame: the wait arm reads the binding, which a handed-in engine settles in its
 * initializer, so the word could not hold them back even if one were passed.
 */
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import messages from "../../messages/en.json";
import { engineOver, storeWith } from "../_view-shell";

describe("an engine handed to the provider", () => {
  it("draws the provider's children at the first render, even under the word `wait`", async () => {
    const { EngineProvider } = await import("../../app/shell/engine");
    const engine = engineOver(await storeWith([]));
    const html = renderToString(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC" } as never,
      h(EngineProvider, { demo: false, engine, drawMail: "wait" } as never, h("p", null, "the mail"))));
    expect(html).toContain("the mail");
  });
});
