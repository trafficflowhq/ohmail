import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import en from "../../../packages/app/messages/mailboxes.en.json";
import de from "../../../packages/app/messages/mailboxes.de.json";
import enSite from "../../../packages/app/messages/site.en.json";
import deSite from "../../../packages/app/messages/site.de.json";

/** The consent names the context sent for drafts. The drafting service supplies both limits. */
/* @reads: packages/services/src/drafting-service.ts packages/app/src/mailboxes/first-run/Ai.tsx */
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
    expect(SERVICE).toMatch(/const threadMessages = target\.threadId\s+\? await this\.retrieveThreadContext\(ctx, target\.threadId, target\.id\)/);
    expect(SERVICE).toMatch(/const kbHits = await this\.kb\.retrieve\(ctx, query, deps\.k \?\? DEFAULT_KB_K\)/);
    expect(SERVICE).toMatch(/context: \{\s+kbEntries: kbHits\.map\(\(e\) => \(\{ title: e\.title, content: e\.content \}\)\),\s+threadMessages,\s+\}/);
  });

  it("the first-run step shows this sentence", () => {
    const ai = read("../../../packages/app/src/mailboxes/first-run/Ai.tsx");
    expect(ai).toContain('say("onboarding.aiSends")');
    expect(ai).toContain('door === "cloud" ? [{ note: say("onboarding.aiDraftSends") }]');
    expect(ai).not.toContain("providerCloudBody");
  });

  it("names both counts, in English and German, and no longer says only", () => {
    expect(en.onboarding.aiSends).toBe("A suggestion sends the sender, the subject and a short extract.");
    expect(de.onboarding.aiSends).toContain("Absender, Betreff und ein kurzer Auszug");

    const enBody = en.onboarding.aiDraftSends;
    const deBody = de.onboarding.aiDraftSends;
    expect(enBody).toContain(`up to ${THREAD} other messages in its thread`);
    expect(enBody).toContain(`up to ${NOTES} matching knowledge-base notes`);
    // The site FAQ is the single source of the provider's name in each language.
    const enProvider = /^On Cloud: via the (.+? API) \([^()]+\),/.exec(enSite.faq.a3)?.[1];
    expect(enProvider).toBeDefined();
    expect(/, through the ([^.]+)\./.exec(enBody)?.[1]).toBe(enProvider);
    expect(enBody).toContain("Codes and login links are never sent");
    expect(enBody).not.toContain("Only the sender");
    expect(deBody).toContain(`bis zu ${THREAD} weiteren Nachrichten im Thread`);
    expect(deBody).toContain(`bis zu ${NOTES} passende Notizen aus der Wissensdatenbank`);
    const deProvider = /^In der Cloud: über die (.+?-API) \([^()]+\),/.exec(deSite.faq.a3)?.[1];
    expect(deProvider).toBeDefined();
    expect(/^Ein Entwurf sendet über die (.+?) dieselben Angaben\b/.exec(deBody)?.[1]).toBe(deProvider);
    expect(deBody).toContain("Codes und Login-Links werden nie gesendet");
    expect(deBody).not.toContain("Gesendet werden nur");

    expect(en.onboarding).not.toHaveProperty("providerCloudBody");
    expect(de.onboarding).not.toHaveProperty("providerCloudBody");
  });
});
