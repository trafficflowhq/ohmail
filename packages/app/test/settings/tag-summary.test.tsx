/** @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { EngineContext, type EngineBinding } from "@ohmail/app-logic/engine/context";
import { PresentedMirrorContext } from "@ohmail/app-logic/reading";
import { TextProvider } from "../../src/text/index.js";
import { useTagSummary } from "../../src/settings/tags/summary.js";
import { fakeMail } from "../reader/support/fake-mail.js";
import en from "../../messages/settings.en.json" with { type: "json" };
import de from "../../messages/settings.de.json" with { type: "json" };

it.each([
  ["en", en, "None"],
  ["de", de, "Keine"],
] as const)("summarizes an empty tag list in %s", (locale, messages, expected) => {
  const { engine } = fakeMail([]);
  const { result } = renderHook(() => useTagSummary(), {
    wrapper: ({ children }) => (
      <TextProvider locale={locale} messages={messages}>
        <EngineContext.Provider value={{ engine } as EngineBinding}>
          <PresentedMirrorContext.Provider value={engine.read()}>{children}</PresentedMirrorContext.Provider>
        </EngineContext.Provider>
      </TextProvider>
    ),
  });
  expect(result.current?.detail).toBe(expected);
});
