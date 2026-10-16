import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";

/**
 * WHAT A DRAFT SENDS, SAID WHERE THE PROVIDER IS CHOSEN.
 *
 * A suggestion sends the sender, the subject and a short extract. A draft sends more: the
 * drafting service grounds it in up to `MAX_THREAD_MESSAGES` other messages of the thread (sender
 * and extract) and up to `DEFAULT_KB_K` matching knowledge-base notes. The provider form said only
 * the first, which became a narrower claim than the truth once drafting worked on the desktop.
 * The counts are read off the service, so a change to what a draft sends breaks this file before
 * it can make the sentence false.
 */

/* @reads: packages/services/src/drafting-service.ts */
const SERVICE = readFileSync(
  fileURLToPath(new URL("../../../packages/services/src/drafting-service.ts", import.meta.url)),
  "utf8",
);

function constant(name: string): number {
  const found = new RegExp(`const ${name} = (\\d+);`).exec(SERVICE)?.[1];
  expect(found, `${name} is no longer a literal in drafting-service.ts`).toBeDefined();
  return Number(found);
}

const THREAD = constant("MAX_THREAD_MESSAGES");
const NOTES = constant("DEFAULT_KB_K");

/** The five destination lines: each is shown on its own, as the option's line and as the summary's. */
const WHY = [
  "choiceAnthropicWhy", "choiceOpenaiWhy", "choiceOpenCodeGoWhy", "choiceOllamaWhy", "choiceOllamaWhyElsewhere",
] as const;

describe("the provider form says what a draft sends", () => {
  it("the service still grounds a draft in the thread and the knowledge base", () => {
    expect(SERVICE).toContain('label: "thread"');
    expect(SERVICE).toContain('label: "kb"');
  });

  it("the note names both counts, in English and German", () => {
    expect(en.aiProvider.note).toContain(`up to ${THREAD} other messages in its thread`);
    expect(en.aiProvider.note).toContain(`up to ${NOTES} matching knowledge-base notes`);
    expect(de.aiProvider.note).toContain(`bis zu ${THREAD} weiteren Nachrichten im Thread`);
    expect(de.aiProvider.note).toContain(`bis zu ${NOTES} passende Notizen aus der Wissensdatenbank`);
  });

  it("names every destination line the catalogue has (None sends nothing)", () => {
    for (const cat of [en, de]) {
      const lines = Object.keys(cat.aiProvider).filter((k) => /^choice\w*Why/.test(k) && k !== "choiceNoneWhy");
      expect(lines.sort()).toEqual([...WHY].sort());
    }
  });

  it("every destination line says a draft sends more, in English and German", () => {
    for (const key of WHY) {
      expect(en.aiProvider[key], key).toContain("A draft also sends extracts from the thread and matching knowledge-base notes.");
      expect(de.aiProvider[key], key).toContain(
        "Ein Entwurf schickt zusätzlich Auszüge aus dem Thread und passende Notizen aus der Wissensdatenbank.",
      );
    }
  });
});
