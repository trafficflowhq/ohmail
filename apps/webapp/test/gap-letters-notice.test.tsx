/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { GapLettersNotice } from "../app/shell/GapLettersNotice";
import type { GapOffer } from "../app/shell/mail-state";

/**
 * THE GAP OFFER NAMES BOTH NUMBERS (mail 0158). Letters the person's rules file, letters from
 * senders they have not decided about, or both: three sentences, and the press carries the pair
 * the person was shown, so the server can refuse a pair that moved. Strangers are never filed "by
 * your rules"; their sentence says the Screener.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await act(() => r.unmount());
  document.body.innerHTML = "";
});

async function show(offer: GapOffer, locale: "en" | "de" = "en") {
  const sent: Array<{ id: string; answer: { file: boolean; count: number; strangers: number } }> = [];
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  await act(() => root.render(h(NextIntlClientProvider, {
    locale, messages: locale === "en" ? en : de, timeZone: "UTC",
    children: h(GapLettersNotice, {
      offers: [offer],
      onAnswer: async (id, answer) => { sent.push({ id, answer }); },
    }),
  })));
  const text = el.querySelector(".rn-text")?.textContent ?? "";
  const buttons = [...el.querySelectorAll<HTMLButtonElement>(".rn-verbs button")];
  return { el, text, buttons, sent };
}

describe("the gap offer's three sentences", () => {
  it("rules only: no device organized the letters, and File sends strangers 0", async () => {
    const v = await show({ id: "mb", address: "me@x.test", count: 2, strangers: 0 });
    expect(v.text).toBe("2 letters arrived in me@x.test, and no device organized them. File them by your rules?");
    expect(v.buttons.map((b) => b.textContent)).toEqual(["File them", "Leave them"]);
    await act(async () => { v.buttons[0]!.click(); });
    expect(v.sent).toEqual([{ id: "mb", answer: { file: true, count: 2, strangers: 0 } }]);
  });

  it("strangers only: the Screener, never the rules, and the press carries the stranger count", async () => {
    const v = await show({ id: "mb", address: "me@x.test", count: 0, strangers: 3 });
    expect(v.text).toContain("3 letters from senders you have not decided about");
    expect(v.text).toContain("Screener");
    expect(v.text).not.toMatch(/rules/);
    expect(v.buttons.map((b) => b.textContent)).toEqual(["Screen them", "Leave them"]);
    await act(async () => { v.buttons[0]!.click(); });
    expect(v.sent).toEqual([{ id: "mb", answer: { file: true, count: 0, strangers: 3 } }]);
  });

  it("both: names each number, and Leave sends the pair too", async () => {
    const v = await show({ id: "mb", address: "me@x.test", count: 1, strangers: 2 });
    expect(v.text).toMatch(/^1 letter for your rules and 2 from senders you have not decided about arrived in me@x\.test/);
    expect(v.text).toContain("Screener");
    await act(async () => { v.buttons[1]!.click(); });
    expect(v.sent).toEqual([{ id: "mb", answer: { file: false, count: 1, strangers: 2 } }]);
  });

  it("German names both numbers too", async () => {
    const v = await show({ id: "mb", address: "me@x.test", count: 1, strangers: 2 }, "de");
    expect(v.text).toMatch(/^1 Mail für deine Regeln und 2 von Absendern, über die du nie entschieden hast,/);
    const only = await show({ id: "mb2", address: "me@x.test", count: 0, strangers: 1 }, "de");
    expect(only.text).toContain("In den Screener legen?");
    expect(only.buttons[0]!.textContent).toBe("In den Screener");
  });

  /* A letter another device took in while the holder's last pass had not reached it is offered too
     (mail 0169), so no sentence says nothing was organizing the mailbox when the letters arrived. */
  it("every sentence, in both languages, says no device organized the letters, never that none was organizing", async () => {
    for (const [locale, said] of [["en", "and no device organized"], ["de", "und kein Gerät hat sie organisiert"]] as const) {
      for (const [count, strangers] of [[2, 0], [0, 1], [1, 2]]) {
        const v = await show({ id: `mb-${locale}-${count}-${strangers}`, address: "me@x.test", count: count!, strangers: strangers! }, locale);
        expect(v.text).toContain(said);
        expect(v.text).not.toMatch(/while no device was organizing|während kein Gerät/);
      }
    }
  });
});
