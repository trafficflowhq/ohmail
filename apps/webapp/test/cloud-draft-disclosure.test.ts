import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * WHAT A CLOUD DRAFT SENDS, SAID ON THE FIRST-RUN CONSENT STEP. The sentence said only the sender,
 * the subject and a short extract go out for "Suggestions and drafts". A draft is grounded in up
 * to `MAX_THREAD_MESSAGES` other messages of its thread (sender and extract) and up to
 * `DEFAULT_KB_K` knowledge-base notes. The counts are read off the service, so a change to what a
 * draft sends breaks this file before it can make the sentence false.
 */

/* @reads: packages/services/src/drafting-service.ts apps/webapp/app/shell/FirstRun.tsx */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SERVICE = read("../../../packages/services/src/drafting-service.ts");

function constant(name: string): number {
  const found = new RegExp(`const ${name} = (\\d+);`).exec(SERVICE)?.[1];
  expect(found, `${name} is no longer a literal in drafting-service.ts`).toBeDefined();
  return Number(found);
}

describe("the Cloud consent step says what a draft sends", () => {
  const THREAD = constant("MAX_THREAD_MESSAGES");
  const NOTES = constant("DEFAULT_KB_K");

  it("the service still grounds a draft in the thread and the knowledge base", () => {
    expect(SERVICE).toContain('label: "thread"');
    expect(SERVICE).toContain('label: "kb"');
  });

  it("the first-run step shows this sentence", () => {
    expect(read("../app/shell/FirstRun.tsx")).toContain('t("providerCloudBody")');
  });

  it("names both counts, in English and German, and no longer says only", () => {
    const enBody = en.onboarding.providerCloudBody;
    const deBody = de.onboarding.providerCloudBody;
    expect(enBody).toContain(`up to ${THREAD} other messages in its thread`);
    expect(enBody).toContain(`up to ${NOTES} matching knowledge-base notes`);
    expect(enBody).not.toContain("Only the sender");
    expect(deBody).toContain(`bis zu ${THREAD} weiteren Nachrichten im Thread`);
    expect(deBody).toContain(`bis zu ${NOTES} passende Notizen aus der Wissensdatenbank`);
    expect(deBody).not.toContain("Gesendet werden nur");
  });
});
