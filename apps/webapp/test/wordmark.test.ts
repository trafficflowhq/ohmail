/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SignedOutPage, type SignedOutState } from "@ohmail/app/doors/signed-out";
import { NONE } from "@ohmail/app/host";
import { TextProvider } from "@ohmail/app/text";
import { marksUnder } from "../../../test/support/wordmark.js";
import en from "../messages/en.json";

const sessionCards = [
  ["checking the session", { at: "checking", slow: false }],
  ["still waiting for confirmation", { at: "checking", slow: true }],
  ["the session service is busy", { at: "busy" }],
  ["a sign-in was already used", { at: "signedOut", reason: "reused" }],
] as const satisfies readonly (readonly [string, SignedOutState])[];

function markAt(state: SignedOutState): HTMLElement | null {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    createElement(TextProvider, {
      locale: "en",
      messages: en,
      timeZone: "Europe/Zurich",
      children: createElement(SignedOutPage, {
        door: { state, tryAgain: () => {}, signIn: () => {}, demo: NONE },
      }),
    }),
  );
  return host.querySelector(".way-mark");
}

describe("webapp wordmarks", () => {
  it("finds the mark on each session card", () => {
    expect([...marksUnder("apps/webapp/app/(product)"), ...marksUnder("apps/webapp/app/shell")]).toEqual([]);
    const engine = readFileSync(resolve(process.cwd(), "apps/webapp/app/shell/engine.tsx"), "utf8");
    expect(engine).toMatch(/function UnconfirmedGate[\s\S]*?<SignedOutPage/);
    expect(engine).toMatch(/function SessionScreen[\s\S]*?<SignedOutPage/);
    expect(engine).toMatch(/return dead \? <SessionDialog \/> : null/);
    expect(engine).toMatch(/return <SessionDialog onRetry=\{onRetry\}/);
    expect(sessionCards.map(([, state]) => markAt(state)?.textContent)).toEqual(["oh", "oh", "oh", "oh"]);
  });

  it.each(sessionCards)("%s uses the short oh mark", (_screen, state) => {
    expect(markAt(state)?.textContent).toBe("oh");
  });

  it("the accent run is 'oh' on every one of them", () => {
    for (const [, state] of sessionCards) {
      const mark = markAt(state);
      expect(mark?.textContent).toBe("oh");
      expect(mark?.getAttribute("aria-hidden")).toBe("true");
    }
  });
});
