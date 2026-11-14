import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import en from "../../../packages/app/messages/mailboxes.en.json";
import de from "../../../packages/app/messages/mailboxes.de.json";

/**
 * WHAT A CLOUD DRAFT SENDS, SAID ON THE FIRST-RUN CONSENT STEP. The sentence said only the sender,
 * the subject and a short extract go out for "Suggestions and drafts". A draft is grounded in up
 * to `MAX_THREAD_MESSAGES` other messages of its thread (sender and extract) and up to
 * `DEFAULT_KB_K` knowledge-base notes. The counts are read off the service, so a change to what a
 * draft sends breaks this file before it can make the sentence false.
 *
 * RE-POINTED (the switch's older tests, sorted once): the step is the new first run's AI step, which says the
 * service's sentence by the key its words name (`packages/app/src/mailboxes/first-run/words.ts`, `PROVIDER_STEP`),
 * from the catalogue the new stage speaks (`packages/app/messages/mailboxes.*.json`). Every expectation is as it stood.
 */

/* @reads: packages/services/src/drafting-service.ts packages/app/src/mailboxes/first-run/words.ts */
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
    expect(read("../../../packages/app/src/mailboxes/first-run/words.ts")).toContain(
      'cloud: { title: "onboarding.providerCloudTitle", body: () => "onboarding.providerCloudBody" }',
    );
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
