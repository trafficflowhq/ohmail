/**
 * A RULE FILING INTO NEWS IS THE SAME RULE IN EITHER SPELLING — the phone's readers.
 *
 * Rules stored before the 0.22 rename say `ohmail/Reads`; the organizer files them into the one News folder.
 * Read by spelling, the phone retargeted such a rule to the place it already filed into (a rewrite nobody
 * asked for) and a release wrote a second rule beside it. The screening press is driven over the real wire
 * (`bootEngine` against the loopback fake), so the PATCH body and the rule the fake then holds are the reading.
 */
import type { Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, type SyncChange } from "@ohmail/client-engine";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, releaseRules } from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

/** The pre-0.22 spelling as stored rows carry it — a fixture; code reaches it through the resolver. */
const LEGACY = "ohmail/Reads" as Folder;
const SENDER = { name: "Ledger", address: "ledger@shop.test" };

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};

async function mirrorOf(rules: RuleDTO[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(rules.map((r, i): SyncChange => ({
    type: "rule", op: "create", id: r.id, seq: i + 1, updatedAt: r.updatedAt, entity: r,
  })));
  return store;
}

describe("releasing a sender reads the rule's place, not its spelling", () => {
  it("no second rule when the sender's own pre-0.22 News rule stands", async () => {
    const store = await mirrorOf([
      ruleDto("dom", "domain", "shop.test", "ohmail/Screened"),
      ruleDto("legacy", "sender", SENDER.address, LEGACY),
    ]);
    const planned = releaseRules(store, SENDER.address, "ohmail/Screened", "ohmail/News");
    expect(planned.kind).toBe("address");
    expect(planned.mutations, "a duplicate rule_create").toEqual([]);
  });

  it("a rule holding a sender is found whichever spelling the held folder carries", async () => {
    const store = await mirrorOf([ruleDto("own", "sender", SENDER.address, "ohmail/News")]);
    expect(releaseRules(store, SENDER.address, LEGACY, "INBOX")).toEqual({
      kind: "retarget", mutations: [{ kind: "rule_update", ruleId: "own", destination: "INBOX" }],
    });
  });
});

describe("screening into News with a pre-0.22 News rule standing (round trip over the wire)", () => {
  it("re-arms the rule in its stored spelling: no retarget, no second rule, the rule unchanged", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addMessage(dto("p1", { subject: "Receipt", from: SENDER, date: "2026-08-12T08:00:00.000Z" }));
    fake.addRule(ruleDto("legacy", "sender", SENDER.address, LEGACY));
    const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
    if (boot.kind !== "ready") throw new Error("boot refused");
    await boot.verifyIdentity();
    await boot.engine.start();
    const actions = liveActions({ engine: boot.engine, toast: (m) => void sayArg(m), uuid: deps.uuid, zone: "UTC" });

    expect(await actions.screenSender("p1", "reads", "sender", true)).toBe(true);
    const creates = fake.seen.filter((r) => r.method === "POST" && r.url === "/rules");
    const patches = fake.seen.filter((r) => r.method === "PATCH" && r.url.startsWith("/rules/"));
    expect(creates, "a second rule").toEqual([]);
    expect(patches.map((r) => r.url)).toEqual(["/rules/legacy"]);
    expect(JSON.parse(patches[0]!.body)).toMatchObject({ destination: LEGACY, applyRetro: true });
    expect(fake.rule("legacy")!.destination, "the press rewrote the stored spelling").toBe(LEGACY);
    boot.store.close();
    fake.server.close();
  });
});
