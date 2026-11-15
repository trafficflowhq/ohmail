import { describe, expect, it } from "vitest";
import { mailboxes } from "@trafficflow/db";
import type { RuleDTO } from "@ohmail/client-engine";
import { verbWorld, type VerbWorld } from "./verb-parity/world.js";

/**
 * A HOLDER WHOSE LEASE LAPSED ORGANIZES NOTHING. The real engine over the real route table: a
 * reader whose holder stopped renewing (`organizer_state = 'stopped'`) is refused `no_organizer`
 * at the rules fan-out, the per-mailbox move door and the Screener's reader branch. Before the
 * fix all three said `organizer_outdated`, and the sentence sent the person to update ohmail on
 * a machine that had stopped organizing. A LIVE holder lacking the capability stays outdated.
 */

type Holder = Partial<typeof mailboxes.$inferInsert>;

/** The world's one mailbox, rewritten (no `where`: this package cannot resolve drizzle-orm). */
async function setOnlyMailbox(w: VerbWorld, set: Holder): Promise<void> {
  const rows = await w.db.select({ id: mailboxes.id }).from(mailboxes);
  expect(rows.map((r) => r.id)).toEqual([w.mailboxId]);
  await w.db.update(mailboxes).set(set);
}

const stopped = (caps: string): Holder => ({
  organizerRole: "reader", organizerState: "stopped", organizedByKind: "local",
  organizedByName: "Studio laptop", organizedByCapabilities: caps,
});
const liveWithout = (caps: string): Holder => ({ ...stopped(caps), organizerState: "held" });

type Refusal = { reason?: string; by?: { name?: string | null } } | undefined;

async function ruleRevoke(set: Holder) {
  const w = await verbWorld();
  const made = await w.engine.mutate({
    kind: "rule_create", ruleKind: "sender", match: "lena@atelier.example", destination: "ohmail/News",
  });
  expect(made.status).toBe("confirmed");
  const rule = w.store.list<RuleDTO>("rule").find((r) => r.match === "lena@atelier.example");
  await setOnlyMailbox(w, set);
  return w.engine.mutate({ kind: "rule_delete", ruleId: rule!.id });
}

async function messageMove(set: Holder) {
  const w = await verbWorld();
  const id = await w.seedMail({ folder: "INBOX" });
  await setOnlyMailbox(w, set);
  return w.engine.mutate({ kind: "move", messageId: id, folder: "ohmail/News" });
}

describe("a stopped holder is no_organizer at every door the route reaches", () => {
  it("a rule revoke (the account fan-out): 409, no_organizer, and the server says nothing organizes it", async () => {
    const res = await ruleRevoke(stopped("requests,rules"));
    expect(res.status).toBe("rolled_back");
    expect(res.error?.code).toBe("organized_elsewhere");
    expect((res.error?.details as Refusal)?.reason).toBe("no_organizer");
    expect(res.error?.message).toMatch(/^nothing organizes this mailbox right now/);
  });

  it("a message move (the per-mailbox door): 409, no_organizer", async () => {
    const res = await messageMove(stopped("requests,moves"));
    expect(res.status).toBe("rolled_back");
    expect(res.error?.code).toBe("organized_elsewhere");
    expect((res.error?.details as Refusal)?.reason).toBe("no_organizer");
  });

  it("a Screener decision on a stopped mailbox beside a live one (the reader branch): 409, no_organizer", async () => {
    const w = await verbWorld();
    const held = await w.seedHeld({ fromAddress: "lena@atelier.example" });
    await setOnlyMailbox(w, stopped("requests"));
    // The OTHER mailbox's holder takes decisions, so the fan-out does not refuse first.
    await w.db.insert(mailboxes).values({
      accountId: w.accountId, provider: "imap", address: `other-${w.mailboxId.slice(0, 8)}@atelier.example`,
      ...liveWithout("requests"),
    });
    const res = await w.engine.mutate({ kind: "screener_decide", senderId: held, decision: "yes" });
    expect(res.status).toBe("rolled_back");
    expect(res.error?.code).toBe("organized_elsewhere");
    expect((res.error?.details as Refusal)?.reason).toBe("no_organizer");
  });
});

describe("controls: a LIVE holder whose build cannot take the change stays organizer_outdated", () => {
  it("a rule revoke to a holder without `rules`", async () => {
    const res = await ruleRevoke(liveWithout("requests"));
    expect((res.error?.details as Refusal)?.reason).toBe("organizer_outdated");
    expect((res.error?.details as Refusal)?.by?.name).toBe("Studio laptop");
  });

  it("a message move to a holder without `moves`", async () => {
    const res = await messageMove(liveWithout("requests"));
    expect((res.error?.details as Refusal)?.reason).toBe("organizer_outdated");
  });
});
