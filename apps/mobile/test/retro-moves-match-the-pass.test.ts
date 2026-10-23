/**
 * THE PHONE MOVES NONE OF A RULE'S BACKLOG — THE SERVER'S PASS DOES (THE-CLIENTS-FIFTY).
 *
 * Measured on the real wire, through the same `bootEngine` composition the app runs: what reaches
 * `POST /messages/:id/move` is what the press did. The sheet used to move up to fifty itself,
 * chosen by a predicate that cannot see a reply or a hand filing, so mail the person had replied
 * to or placed themselves moved while the note said the pass leaves it alone. Every branch of the
 * phone's sheet writes a rule or a decide, so the press now asks the pass (`applyRetro`) and moves
 * nothing. The fixture is `test/support/retro-candidates.ts`, shared with the webapp's twin.
 */
import { describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, type LiveWorldActions } from "../src/state/live";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";
import {
  RETRO_FIXTURE,
  RETRO_MOVES,
  RETRO_SENDER,
  type RetroFixtureRow,
} from "../../../test/support/retro-candidates.js";

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};

async function liveOn(fake: ReturnType<typeof mailServer>, origin: string) {
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine,
    toast: (m) => void sayArg(m),
    uuid: deps.uuid,
    zone: "UTC",
  });
  return { ...boot, actions };
}

/** The message ids the phone put on the wire as moves. */
const moved = (fake: ReturnType<typeof mailServer>): string[] =>
  fake.seen
    .filter((r) => r.method === "POST" && /^\/messages\/[^/]+\/move$/.test(r.url))
    .map((r) => r.url.split("/")[2]!);

/** Screen the fixture's sender to Reads with the past-mail switch ON, and read the wire. */
async function pressed(rows: readonly RetroFixtureRow[]) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  for (const r of rows) {
    fake.addMessage(dto(r.id, {
      subject: r.why, from: RETRO_SENDER, date: r.date, folder: r.folder,
      triage: r.triage === null ? null : { state: r.triage },
    }));
  }
  const live = await liveOn(fake, origin);
  expect(await live.actions.screenSender(rows[0]!.id, "reads", "sender", true)).toBe(true);
  // A window a surplus move would land in: the old press dispatched its moves unawaited.
  await new Promise((r) => setTimeout(r, 500));
  const ids = moved(fake);
  const rule = fake.seen.find((r) => r.method === "POST" && r.url === "/rules");
  live.store.close();
  fake.server.close();
  return { ids, rule };
}

describe("the phone leaves a rule's past mail to the pass", () => {
  it("puts no backlog move on the wire, though the fixture holds rows the pass would move", async () => {
    // Anti-vacuity: the fixture does hold mail the pass would reach, so "none" is a finding.
    expect(RETRO_MOVES.length).toBeGreaterThan(1);
    const { ids } = await pressed(RETRO_FIXTURE);
    // The one move is the letter the press was made on (RULE-FILED-MESSAGE-SNAPS-BACK-TO-OHBOX).
    expect(ids, "the press moved backlog the pass alone can judge").toEqual([RETRO_FIXTURE[0]!.id]);
  }, 30_000);

  it("and the rule it writes asks the pass for that mail — the positive control", async () => {
    const { rule } = await pressed(RETRO_FIXTURE);
    expect(rule, "no rule reached the wire").toBeDefined();
    expect(JSON.parse(rule!.body) as { applyRetro?: boolean }).toMatchObject({ applyRetro: true });
  }, 30_000);
});
