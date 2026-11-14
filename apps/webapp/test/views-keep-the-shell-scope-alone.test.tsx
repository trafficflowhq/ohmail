/** @vitest-environment jsdom */
/**
 * DRAWN IN NO SHELL, A LETTER KEEPS NOTHING: the letter's body the new reader mounts (`@ohmail/letter-body`, which
 * `packages/app/src/reader/Letter.tsx` hands the session's scope as `owner`), drawn with no owner, keeps a letter's
 * original look for itself and stores nothing. Moved from `views-keep-the-shell-scope.test.tsx` (it drew today's
 * wrapper of the same body, which leaves with today's views); its expectation is the old case's word for word.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const NOW = new Date("2026-10-01T09:00:00.000Z");
const LIGHT = '<body><table bgcolor="#ffffff" width="600"><tr><td>Newsletter</td></tr></table></body>';

const settle = async (rounds = 10): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
};
const press = async (el: Element | null | undefined, what: string): Promise<void> => {
  if (!el) throw new Error(`no ${what}`);
  await act(async () => { (el as HTMLElement).click(); });
  await settle(4);
};
const buttonSaying = (root: ParentNode, words: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").trim() === words);

describe("drawn in no shell, a view keeps nothing", () => {
  let root: Root | null = null;
  afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); });
    root = null;
    window.localStorage.clear();
  });
  const bare = async (node: React.ReactElement): Promise<HTMLElement> => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    const { ThemeProvider } = await import("@ohmail/ui");
    await act(async () => {
      root!.render(React.createElement(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: React.createElement(ThemeProvider, { defaultPreference: "dark", storageKey: null, children: node }),
      } as never));
    });
    await settle(4);
    return el;
  };
  const stored = (): string[] => Object.keys(window.localStorage).sort();

  it("a letter shown in its original look alone keeps the choice for itself and stores nothing", async () => {
    const { MAIL_BODY_COPY: COPY, MessageBody } = await import("@ohmail/letter-body");
    const el = await bare(React.createElement(MessageBody, {
      owner: null, text: "Newsletter", html: LIGHT, messageId: "m-1",
    } as never));
    const before = stored();
    await press(buttonSaying(el, COPY.darkOriginal), "Original");
    expect({ shown: buttonSaying(el, COPY.darkAdapt) != null, stored: stored() }).toEqual({ shown: true, stored: before });
  });
});
