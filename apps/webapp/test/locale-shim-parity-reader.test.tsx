/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { TextProvider, useText } from "../../../packages/app/src/text/index.js";
import { LETTER_WORDS } from "./_reader-1-letters.js";

/**
 * THE READING PANE'S FILES SAY THEIR SENTENCES IN GERMAN, with their numbers and their plural: the halves of
 * `locale-shim-parity.test.ts`'s two German cases that read today's attachment strip and preview, re-pointed (share
 * reader-1, the switch's older tests) over the words the new reader's files say them with (`packages/app/src/reader/
 * files/Files.tsx`: `useText("attachments")`; the look's: `useText("attachmentPreview")`), in the reader's German
 * catalogue as the reader's mounts compose it. Each expectation as it stood.
 */

const german = ({ children }: { children: ReactNode }) => (
  <TextProvider locale="de" messages={LETTER_WORDS.de} timeZone="UTC">
    {children}
  </TextProvider>
);
const wordsOf = (namespace: string) => renderHook(() => useText(namespace), { wrapper: german }).result.current;

describe("with a German catalogue set, the non-hook surfaces answer German", () => {
  it("the reading pane's sentences are German (the files' half)", () => {
    expect(wordsOf("attachments")("downloadAll")).toBe("Alle herunterladen");
    expect(wordsOf("attachmentPreview")("close")).toBe("Schließen");
  });

  it("an interpolated sentence keeps its number and takes the German plural (the files' half)", () => {
    const t = wordsOf("attachments");
    expect(t("count", { count: 1, size: "2 MB" })).toBe("1 Anhang · 2 MB");
    expect(t("count", { count: 4, size: "4 MB" })).toBe("4 Anhänge · 4 MB");
    expect(t("idle", { size: "2,3 MB" })).toContain("2,3 MB");
  });
});
