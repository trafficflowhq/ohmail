import { describe, it, expect } from "vitest";
import { dbFor } from "../src/context.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, rules } from "@trafficflow/db";
import { evaluateRules, type NormalizedMessage, type Rule } from "@trafficflow/core/mail";
import { pressOverTwins, type EngineMutation, type RuleDTO } from "@ohmail/client-engine";
import { rulesService } from "../src/rules-service.js";
import { mutated } from "./helpers.js";
import { ServiceError } from "../src/errors.js";
import type { Db, ServiceContext } from "../src/context.js";

/**
 * REVIEW-026's two probes as named cases, through the real service door and the real router.
 * A: the sheet's press Ohbox with "also move" off over an inferred twin already at the Ohbox made no
 * write, so the next newsletter went to News. B: the phone's way back from a committed Move named
 * the old place and made the rule the person's. The press claims; the undo puts the rule back as
 * it was read, and only an undo of a claim can.
 */
const NOW = new Date("2026-10-01T21:00:00Z");
const SENDER = "letters@vendor.example";
const bulk = {
  canonical: { messageIdHeader: null, bodyHash: "x" }, subject: "issue", from: { name: null, address: SENDER },
  to: [], date: null, headers: { "list-id": ["<n.vendor.example>"] }, textBody: "", htmlBody: null,
  hasAttachments: false, attachments: [],
} as unknown as NormalizedMessage;
const route = (r: { id: string; destination: string; provenance: string; priority: number; enabled: boolean }) =>
  evaluateRules({
    msg: bulk, rules: [{ id: r.id, kind: "sender", match: SENDER, destination: r.destination, effect: "allow",
      priority: r.priority, provenance: r.provenance, enabled: r.enabled } as Rule],
    knownSenders: { addresses: new Set([SENDER]), inferred: new Set<string>(), lists: new Map() }, auth: "unauthenticated", ohboxPolicy: "people_only", ownAddresses: new Set(), identity: null,
  } as Parameters<typeof evaluateRules>[0]).destination;

async function world(provenance: string, destination: string) {
  const db = (await makeTestDb()) as unknown as Db;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `pu-${accountId.slice(0, 8)}` });
  const ctx = { db: dbFor(db, accountId), accountId, now: () => NOW } as unknown as ServiceContext;
  const [r] = await db.insert(rules).values({
    accountId, kind: "sender", match: SENDER, destination, priority: 0, provenance: provenance as "promoted",
  }).returning();
  const row = async () => (await db.select().from(rules).where(eq(rules.id, r!.id)))[0]!;
  const dto = async (): Promise<RuleDTO> => {
    const x = await row();
    return { ...x, createdAt: x.createdAt.toISOString(), updatedAt: x.updatedAt.toISOString() } as unknown as RuleDTO;
  };
  /** A client mutation, sent as the HTTP adapter sends it. */
  const send = async (m: EngineMutation) => {
    if (m.kind !== "rule_update") throw new Error(`unexpected ${m.kind}`);
    return mutated(await rulesService.update(ctx, m.ruleId, {
      destination: m.destination,
      ...(m.priority === undefined ? {} : { priority: m.priority }),
      ...(m.applyRetro === undefined ? {} : { applyRetro: m.applyRetro }),
      ...(m.keepProvenance === true ? { keepProvenance: true } : {}),
      ...(m.keepProvenance === true && m.restoreProvenance !== undefined ? { restoreProvenance: m.restoreProvenance } : {}),
    }));
  };
  return { db, ctx, id: r!.id, row, dto, send };
}

describe("REVIEW-026 probe A: the press over an inferred twin at the Ohbox, also-move off", () => {
  it("claims the rule, moves nothing, and the next newsletter goes to the Ohbox", async () => {
    const w = await world("promoted", "INBOX");
    expect(route(await w.row()), "the premise: the inference refiles newsletters").toBe("ohmail/News");
    const press = pressOverTwins([await w.dto()], "sender", SENDER, "INBOX", false);
    expect(press.state).toBe("already");
    expect(press.claimed, "the toast says the rule is theirs now").toBe(true);
    expect(press.writes, "a press that writes nothing leaves the inference standing").toHaveLength(1);
    for (const m of press.writes) await w.send(m);
    const after = await w.row();
    expect(after.provenance).toBe("manual");
    expect(after.retroRequestedAt, "also-move off: no backlog asked").toBeNull();
    expect(route(after)).toBe("INBOX");
  });

  it("a manual twin already there is left alone (the positive control)", async () => {
    const w = await world("manual", "INBOX");
    const press = pressOverTwins([await w.dto()], "sender", SENDER, "INBOX", false);
    expect(press.writes).toEqual([]);
    expect(press.claimed).toBe(false);
  });
});

describe("REVIEW-026 probe B: the phone's undo after a committed Move", () => {
  it("puts the rule back as it was read, provenance included", async () => {
    const w = await world("promoted", "INBOX");
    const before = await w.row();
    expect(route(before)).toBe("ohmail/News");
    await w.send({ kind: "rule_update", ruleId: w.id, destination: "ohmail/News", applyRetro: false });
    expect((await w.row()).provenance, "the Move names a place: the person's").toBe("manual");
    // The phone's `routingReversal`, read before the forward write.
    await w.send({ kind: "rule_update", ruleId: w.id, destination: "INBOX", priority: before.priority,
      applyRetro: false, keepProvenance: true, restoreProvenance: "promoted" });
    const after = await w.row();
    expect(after.destination).toBe("INBOX");
    expect(after.provenance, "the undo minted a claim the person never made").toBe("promoted");
    expect(route(after)).toBe("ohmail/News");
  });

  it("a forward Move to the Ohbox over a promoted News twin still makes the rule the person's", async () => {
    const w = await world("promoted", "ohmail/News");
    await w.send({ kind: "rule_update", ruleId: w.id, destination: "INBOX", applyRetro: false });
    const after = await w.row();
    expect(after.provenance).toBe("manual");
    expect(route(after)).toBe("INBOX");
  });

  it("keepProvenance alone keeps what is stored and never sets one", async () => {
    const w = await world("promoted", "ohmail/News");
    await w.send({ kind: "rule_update", ruleId: w.id, destination: "INBOX", applyRetro: false, keepProvenance: true });
    expect((await w.row()).provenance).toBe("promoted");
  });
});

describe("the restore's admission", () => {
  const refused = async (p: Promise<unknown>) => {
    const e = await p.then(() => null, (x: unknown) => x);
    return e instanceof ServiceError && e.httpStatus === 400;
  };
  it("refuses a restore without keepProvenance", async () => {
    const w = await world("manual", "INBOX");
    expect(await refused(rulesService.update(w.ctx, w.id, { destination: "INBOX", restoreProvenance: "promoted" }))).toBe(true);
    expect((await w.row()).provenance).toBe("manual");
  });
  it("refuses a restore with no destination, as the relayed door does", async () => {
    const w = await world("manual", "INBOX");
    expect(await refused(rulesService.update(w.ctx, w.id,
      { priority: 3, keepProvenance: true, restoreProvenance: "promoted" }))).toBe(true);
    expect((await w.row()).provenance).toBe("manual");
    expect(await refused(rulesService.update(w.ctx, w.id, { priority: 3, keepProvenance: true })),
      "the keep alone without a destination stays admitted").toBe(false);
  });
  it("refuses a restore to manual or to a value outside the inferred set", async () => {
    const w = await world("manual", "INBOX");
    for (const v of ["manual", "who-knows", 7]) {
      expect(await refused(rulesService.update(w.ctx, w.id,
        { destination: "INBOX", keepProvenance: true, restoreProvenance: v as never }))).toBe(true);
    }
  });
  it("writes the restore only over a manual row", async () => {
    const w = await world("seeded-from-sent", "INBOX");
    await w.send({ kind: "rule_update", ruleId: w.id, destination: "INBOX", applyRetro: false,
      keepProvenance: true, restoreProvenance: "promoted" });
    expect((await w.row()).provenance, "an inferred row is not re-labelled").toBe("seeded-from-sent");
  });
  it("is account-scoped: another account's rule is not found", async () => {
    const w = await world("manual", "INBOX");
    const otherAccount = randomUUID();
    const other = { ...w.ctx, accountId: otherAccount, db: dbFor(w.db, otherAccount) } as ServiceContext;
    const e = await rulesService.update(other, w.id,
      { destination: "INBOX", keepProvenance: true, restoreProvenance: "promoted" }).then(() => null, (x: unknown) => x);
    expect(e instanceof ServiceError && e.httpStatus === 404).toBe(true);
    expect((await w.row()).provenance).toBe("manual");
  });
});
