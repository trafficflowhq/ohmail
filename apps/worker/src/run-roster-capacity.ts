import { UNMETERED } from "@trafficflow/db";
import {
  alertReadersOf, closePooledDbs, makeEntitlementsClient, makePooledDb, workerHeartbeats, workerTopology,
} from "@trafficflow/db/cloud";
import { loadRosterCapacity } from "./mailboxes.js";

const [shardCount, mailboxCap, verification] = process.argv.slice(2);
const databaseUrl = process.env.DATABASE_URL_POOLED;
const planeUrl = process.env.ENTITLEMENTS_URL;
const planeSecret = process.env.ENTITLEMENTS_SECRET;

if (!databaseUrl || !/^[1-9][0-9]*$/.test(shardCount ?? "") || !/^[1-9][0-9]*$/.test(mailboxCap ?? "") ||
    Boolean(planeUrl) !== Boolean(planeSecret) || (verification !== undefined && verification !== "--verify-active")) {
  console.error("Supply the proposed shard count, mailbox cap and the pooled database connection. Hosted billing requires its complete configuration.");
  process.exitCode = 2;
} else {
  try {
    const db = makePooledDb(databaseUrl, { role: "roster", max: 1 });
    let billingUnavailable = false;
    const entitlements = planeUrl && planeSecret ? makeEntitlementsClient({
      baseUrl: planeUrl, secret: planeSecret, onCallFault: () => { billingUnavailable = true; },
    }) : UNMETERED;
    const parking = alertReadersOf(entitlements).parkedAccounts ?? undefined;
    const now = new Date();
    const report = await db.transaction(async (tx) => {
      const capacity = await loadRosterCapacity(tx, Number(shardCount), Number(mailboxCap), now, parking);
      if (billingUnavailable) throw new Error("billing availability could not be verified");
      const [topology] = await tx.select({ shards: workerTopology.shards }).from(workerTopology);
      const topologyMatches = topology?.shards === Number(shardCount);
      const result = { ...capacity, cap: Number(mailboxCap), activeShards: topology?.shards ?? null };
      if (verification === undefined) return result;
      const beats = await tx.select({
        shard: workerHeartbeats.shardIndex, shards: workerHeartbeats.shards,
        leader: workerHeartbeats.leader, degraded: workerHeartbeats.degraded, beatAt: workerHeartbeats.beatAt,
        expected: workerHeartbeats.expected, connected: workerHeartbeats.mailboxes,
      }).from(workerHeartbeats);
      const readied = capacity.occupancy.map((eligible, shard) => beats.some((beat) =>
        beat.shard === shard && beat.shards === Number(shardCount) && beat.leader && !beat.degraded &&
        beat.expected === eligible && beat.connected === eligible && now.getTime() - beat.beatAt.getTime() < 120_000));
      return { ...result, ready: topologyMatches && readied.every(Boolean), readied };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    console.log(JSON.stringify(report));
    if (report.verdict === "overflow" || ("ready" in report && !report.ready)) process.exitCode = 4;
  } catch {
    console.error("Could not verify roster capacity.");
    process.exitCode = 6;
  } finally {
    await closePooledDbs();
  }
}
