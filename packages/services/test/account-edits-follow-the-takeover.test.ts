import { accountOfMailbox } from "@trafficflow/db";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  accounts, accountSettings, awayResponders, mailboxCredentials, mailboxes, organizerRequests, rules,
} from "@trafficflow/db";
import { AwayResponderService, RulesService, setDormancyDays, setScreeningPreference } from "../src/index.js";
import { makeMailboxService } from "../src/mailbox-service.js";
import { makeCtx } from "./helpers.js";

/**
 * AN EDIT MADE DURING A TAKEOVER IS WRITTEN HERE. "Organize here instead" writes the stamp and
 * leaves the role to the gate; an edit on any account door before the claim lands is written on
 * this install and nothing is asked of the holder the claim displaces. It answered 409 over a
 * stopped holder and queued a request to a live one. To watch it fail: gate the `takeoverPending`
 * arm of `planAccountFanOut` again.
 */

async function readerUnder(state: "held" | "stopped", pressed = true) {
  const w = await makeCtx();
  await w.db.insert(accounts).values({ id: w.accountId, name: "takeover" }).onConflictDoNothing();
  await w.db.update(mailboxes).set({
    organizerRole: "reader", organizerState: state, organizedByCapabilities: "requests,profile",
    organizedByKind: "local", organizedByName: "W-old",
  }).where(eq(mailboxes.id, w.mailboxId));
  await w.db.insert(mailboxCredentials).values({
    mailboxId: w.mailboxId, accountId: accountOfMailbox(w.mailboxId), transport: "imap", secretEnc: "sealed", keyVersion: 1,
    meta: { host: "imap.example.test", port: 993, secure: true, user: "u" }, updatedAt: new Date(),
  });
  if (pressed) {
    await makeMailboxService({ allowance: async () => {} })
      .organizeHere(w.ctx, w.mailboxId, { intent: "takeover", screening: { scope: "window" } });
  }
  const role = (await w.db.select().from(mailboxes).where(eq(mailboxes.id, w.mailboxId)))[0]?.organizerRole;
  const requests = async () => (await w.db.select().from(organizerRequests)
    .where(eq(organizerRequests.accountId, w.accountId))).length;
  const settings = async () => (await w.db.select().from(accountSettings)
    .where(eq(accountSettings.accountId, w.accountId)))[0];
  return { ...w, role, requests, settings };
}

/** One word per outcome, so every reading below prints all of it on a failure. */
const outcome = async (p: Promise<unknown>): Promise<string> => {
  try { return (await p as { pending?: boolean }).pending === true ? "request" : "written"; }
  catch (e) { return `refused ${(e as { httpStatus?: number }).httpStatus}`; }
};

describe.each(["stopped", "held"] as const)("an edit pressed before the takeover lands, holder %s", (s) => {
  it("a rule", async () => {
    const w = await readerUnder(s);
    expect(w.role, "the claim has not landed").toBe("reader");
    const out = await outcome(new RulesService().create(w.ctx, { kind: "sender", match: "b@b.test", destination: "INBOX" }));
    const n = (await w.db.select().from(rules).where(eq(rules.accountId, w.accountId))).length;
    expect({ out, rules: n, requests: await w.requests() }).toEqual({ out: "written", rules: 1, requests: 0 });
  });

  it("the away responder", async () => {
    const w = await readerUnder(s);
    const out = await outcome(new AwayResponderService().put(w.ctx, { enabled: true, body: "Away.", audience: "everyone" }));
    const n = (await w.db.select().from(awayResponders).where(eq(awayResponders.accountId, w.accountId))).length;
    expect({ out, rows: n, requests: await w.requests() }).toEqual({ out: "written", rows: 1, requests: 0 });
  });

  it("the screening preference", async () => {
    const w = await readerUnder(s);
    const out = await outcome(setScreeningPreference(w.ctx, { ohboxPolicy: "people_only" }));
    expect({ out, policy: (await w.settings())?.ohboxPolicy ?? null, requests: await w.requests() })
      .toEqual({ out: "written", policy: "people_only", requests: 0 });
  });

  it("the dormancy window", async () => {
    const w = await readerUnder(s);
    const out = await outcome(setDormancyDays(w.ctx, 30));
    expect({ out, days: (await w.settings())?.dormancyDays ?? null, requests: await w.requests() })
      .toEqual({ out: "written", days: 30, requests: 0 });
  });
});

describe("CONTROLS: no takeover pressed, the doors answer as before", () => {
  it("a stopped holder refuses the rule", async () => {
    const w = await readerUnder("stopped", false);
    expect(await outcome(new RulesService().create(w.ctx, { kind: "sender", match: "b@b.test", destination: "INBOX" })))
      .toBe("refused 409");
  });

  it("a live holder is asked, and nothing is written here", async () => {
    const w = await readerUnder("held", false);
    expect(await outcome(new AwayResponderService().put(w.ctx, { enabled: true, body: "Away.", audience: "everyone" })))
      .toBe("request");
    expect(await w.requests()).toBe(1);
  });
});
