import { describe, it, expect } from "vitest";
import { makeTestDb } from "../src/testing.js";
import {
  alertState, listOpenAlerts, runAlertPass, writeHeartbeat, type AlertKind,
} from "../src/cloud.js";

/**
 * ── EVERY FIELD A FIRING ALERT CARRIES SURVIVES THE ROW, FOR EVERY KIND ──────────────────
 *
 * THE FAMILY THIS CLOSES. Eleven review rounds each found one more member of the same defect:
 * a surface reading `alert_state` instead of evaluating, and INVENTING the parts the row did not
 * hold. The count became a hardcoded 1. The title became the detail's first sentence, so a burst
 * of forty refusals rendered as "1" under a heading that was the opening clause of a paragraph.
 *
 * Reading the row is not the exceptional path, which is what made it worth closing rather than
 * patching: two rules are keyed by DRIVER and one by ROLE, and a console read names no driver and
 * runs on the content-blind handle — so for those three the row is the ONLY source there is.
 *
 * This is table-driven over the whole `AlertKind` union on purpose. A per-kind test would have
 * been satisfied by whichever kind the last round happened to name; the union is what makes a
 * NEW kind, or a new field, fail here rather than in a twelfth review.
 */
const NOW = new Date("2026-09-04T12:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

/** Every kind, with a distinctive title and count so a swap or a default cannot pass. */
const EVERY_KIND: ReadonlyArray<{ kind: AlertKind; count: number }> = [
  { kind: "worker_down", count: 3 },
  { kind: "worker_degraded", count: 1 },
  { kind: "sends_stuck", count: 7 },
  { kind: "sync_lag", count: 41 },
  { kind: "storage_at_cap", count: 5 },
  { kind: "device_sync_stale", count: 9 },
  { kind: "session_sync_stale", count: 4 },
  { kind: "session_reuse_revoked", count: 6 },
  { kind: "credential_replay_wide", count: 3 },
  { kind: "session_refresh_replayed", count: 8 },
  { kind: "api_5xx_rate", count: 20 },
  { kind: "schema_behind", count: 1 },
  { kind: "imap_admission_refused", count: 40 },
  { kind: "ai_provider_down", count: 1 },
  { kind: "alert_driver_dark", count: 1 },
  { kind: "api_fault_rate", count: 12 },
  { kind: "pooler_refusals", count: 11 },
  { kind: "alert_driver_undeliverable", count: 1 },
  { kind: "alert_sink_degraded", count: 1 },
  { kind: "api_cron_stale", count: 1 },
  { kind: "signal_source_dark", count: 1 },
  { kind: "plane_pass_stale", count: 1 },
  { kind: "billing_alert", count: 13 },
  { kind: "plane_ops_unreadable", count: 6 },
];

describe("alert_state round-trips every field, for every kind", () => {
  it("covers the WHOLE AlertKind union — a new kind must appear here", async () => {
    // Anti-vacuity: the table is retyped rather than derived, so this asserts the two agree.
    // Deriving it would make the test agree with whatever the source says, which is the one
    // thing a census must not do.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/alert-types.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const union = [...src.match(/export type AlertKind =([\s\S]*?);/)![1]!
      .matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!);
    expect([...EVERY_KIND.map((e) => e.kind)].sort()).toEqual([...union].sort());
  });

  it("projects title, count, detail, class, accounts and link — never reconstructs them", async () => {
    const db = await makeTestDb();
    for (const { kind, count } of EVERY_KIND) {
      await db.insert(alertState).values({
        alertKey: `${kind}:probe`,
        kind,
        severity: "critical",
        openedAt: ago(3 * 3_600_000),
        lastSeenAt: ago(60_000),
        notifiedAt: ago(2 * 3_600_000),
        notifyCount: 2,
        // A title that is NOT the detail's first sentence, so a reconstruction cannot pass.
        title: `TITLE-${kind}`,
        count,
        detail: `First sentence for ${kind}. Second sentence that must never become the title.`,
        cls: kind === "device_sync_stale" ? "signal" : "incident",
        affectedAccounts: count > 5 ? count : null,
        fixHref: `/accounts/${kind}`,
      } as never);
    }

    const rows = await listOpenAlerts(db);
    expect(rows.length, "every kind was written").toBe(EVERY_KIND.length);
    const byKey = new Map(rows.map((r) => [r.alertKey, r]));

    for (const { kind, count } of EVERY_KIND) {
      const r = byKey.get(`${kind}:probe`)!;
      expect(r, `${kind} came back`).toBeTruthy();
      expect(r.title, `${kind}: the title is the rule's, not the detail's first sentence`)
        .toBe(`TITLE-${kind}`);
      expect(r.count, `${kind}: the count is the rule's, not a hardcoded 1`).toBe(count);
      expect(r.detail, `${kind}: the detail survives whole`).toContain("Second sentence");
      expect(r.cls, `${kind}: the class survives`)
        .toBe(kind === "device_sync_stale" ? "signal" : "incident");
      expect(r.affectedAccounts, `${kind}: the account count survives, null and all`)
        .toBe(count > 5 ? count : null);
      expect(r.fixHref, `${kind}: the deep link survives`).toBe(`/accounts/${kind}`);
      expect(r.openedAt.getTime(), `${kind}: opened_at is when the fault STARTED`)
        .toBe(ago(3 * 3_600_000).getTime());
      expect(r.notifyCount, `${kind}: the page count survives`).toBe(2);
    }
  });

  it("a REAL pass persists what its rule said — not just what a hand-written row holds", async () => {
    // The tests above insert rows directly, which proves the column round-trips and proves
    // NOTHING about whether the writer fills it. That gap let a mutation removing the two fields
    // from `runAlertPass` pass every one of them. So this drives the actual pass and reads back
    // what it wrote.
    const db = await makeTestDb();
    await writeHeartbeat(db, {
      shardIndex: 0, instanceId: "wkr", shards: 1,
      mailboxes: 1, expected: 1, accounts: 1, quarantined: 0,
      degraded: false, aiCircuitOpenSince: null,
      lastCycleAt: ago(10_000), startedAt: ago(3_600_000),
    }, ago(10_000));

    // A shard with no leader at all: `worker_down` fires with the rule's own sentence.
    const pass = await runAlertPass(db, { now: NOW, sinks: [], shards: [7] });
    const firing = pass.firing.find((a) => a.kind === "worker_down")!;
    expect(firing, "the rule fired").toBeTruthy();

    const [row] = (await listOpenAlerts(db)).filter((r) => r.alertKey === "worker_down:7");
    expect(row, "and it was persisted").toBeTruthy();
    expect(row!.title, "the row carries the RULE's title, verbatim").toBe(firing.title);
    expect(row!.count, "and the RULE's count").toBe(firing.count);
    expect(row!.title, "which is not the detail's first sentence")
      .not.toBe(firing.detail.split(". ")[0]);
  });

  it("a pass over a row that already exists writes the rule's fields through the conflict arm", async () => {
    // The observation is one multi-row upsert; each field must reach an EXISTING row from its own
    // incoming value, not stay what the row held.
    const db = await makeTestDb();
    await db.insert(alertState).values({
      alertKey: "worker_down:7", kind: "worker_down", severity: "warning",
      openedAt: ago(3_600_000), lastSeenAt: ago(600_000), notifiedAt: null, notifyCount: 0,
      detail: "stale detail", cls: "incident", title: "stale title", count: 99,
      affectedAccounts: 99, fixHref: "/stale",
    } as never);
    const pass = await runAlertPass(db, { now: NOW, sinks: [], shards: [7] });
    const firing = pass.firing.find((a) => a.key === "worker_down:7")!;
    expect(firing, "the rule fired").toBeTruthy();
    const [row] = (await listOpenAlerts(db)).filter((r) => r.alertKey === "worker_down:7");
    expect(row!.title).toBe(firing.title);
    expect(row!.count).toBe(firing.count);
    expect(row!.detail).toBe(firing.detail);
    expect(row!.severity).toBe(firing.severity);
    expect(row!.fixHref).toBe(firing.fixHref ?? null);
    expect(row!.affectedAccounts).toBe(firing.affectedAccounts ?? null);
    expect(row!.openedAt.getTime(), "the start of the fault is kept").toBe(ago(3_600_000).getTime());
  });

  it("a row from BEFORE these columns projects NULL, so a reader can say so", async () => {
    // The honest half. A driver mid-deploy writes no title, and the reader must render
    // "recorded by the other driver" rather than fabricate a sentence out of the detail.
    const db = await makeTestDb();
    await db.insert(alertState).values({
      alertKey: "worker_down:0", kind: "worker_down", severity: "critical",
      openedAt: ago(60_000), lastSeenAt: ago(60_000), notifiedAt: null, notifyCount: 0,
      detail: "An older driver wrote this. There is no title on the row.",
      cls: "incident",
    } as never);

    const [r] = await listOpenAlerts(db);
    expect(r!.title, "absent, not invented").toBeNull();
    expect(r!.count, "absent, not 1").toBeNull();
  });
});
