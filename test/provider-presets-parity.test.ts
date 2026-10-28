import { describe, expect, it } from "vitest";
import {
  CONNECT_PRESET_IMAP_HOSTS, DISCOVER_MX_PRESETS, DISCOVER_PROTON_MX, discoverMailHosting, presetOfImapHost,
  type MailDnsResolver,
} from "@trafficflow/api";
import { accounts } from "@trafficflow/db";
import { CONNECT_DOORS, CONNECT_PRESETS, CONNECT_REASONS, connectAttempts } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { PROTON, PROVIDERS, providerById, readDiscovery } from "@ohmail/client-engine";
import en from "../apps/webapp/messages/en.json";
import de from "../apps/webapp/messages/de.json";

/**
 * THE SERVER'S DOMAIN LOOKUP AND THE CLIENTS' PRESET TABLE NAME THE SAME PROVIDERS. The API cannot
 * import the client table, so `POST /mailboxes/discover` answers a preset id the browser maps back;
 * a row naming an id the table lacks would be read as "nothing found", silently. Proton is the one
 * provider both sides know and neither offers: it is a note, never a preset or a parity-list name.
 */

/** A resolver whose only record is one MX exchanger. */
const exchangerOnly = (exchange: string): MailDnsResolver => ({
  resolveMx: async () => [{ exchange, priority: 10 }],
  resolveSrv: async () => { throw new Error("no data"); },
  resolve: async () => { throw new Error("no data"); },
});

/** What the route sends for `exchange`, as the browser receives it. */
const wireFor = async (exchange: string): Promise<unknown> =>
  JSON.parse(JSON.stringify(await discoverMailHosting("praxis-sonnhalde.ch", exchangerOnly(exchange), 1_000)));

describe("the lookup and the preset table", () => {
  it("every preset the MX table names is a named preset", () => {
    const named = new Set(PROVIDERS.filter((p) => !p.manual).map((p) => p.id));
    expect(DISCOVER_MX_PRESETS.length).toBeGreaterThan(3);
    for (const row of DISCOVER_MX_PRESETS) expect(named.has(row.preset), row.preset).toBe(true);
  });

  it("each row's answer is read back as that preset", async () => {
    for (const row of DISCOVER_MX_PRESETS) {
      for (const suffix of row.suffixes) {
        expect(readDiscovery(await wireFor(`mx1.${suffix}`))?.preset, suffix).toBe(providerById(row.preset));
      }
    }
  });

  it("Proton is read as Proton, and is a preset on neither side", async () => {
    expect(readDiscovery(await wireFor(`mail.${DISCOVER_PROTON_MX[0]}`)))
      .toEqual({ preset: null, proton: true, imap: null, smtp: null });
    expect(PROVIDERS.some((p) => p.label === PROTON.label)).toBe(false);
    expect(DISCOVER_MX_PRESETS.some((row) => /proton/i.test(row.preset))).toBe(false);
  });
});

describe("the connect record's presets and words (cloud 0054)", () => {
  it("every preset's IMAP host is recorded as that preset, and any other host as imap", () => {
    const named = PROVIDERS.filter((p) => !p.manual);
    for (const p of named) {
      expect(presetOfImapHost(p.imap.host), p.id).toBe(p.id);
      expect(presetOfImapHost(` ${p.imap.host.toUpperCase()}. `), p.id).toBe(p.id);
    }
    expect(presetOfImapHost("imap.googlemail.com")).toBe("gmail");
    expect([...new Set(Object.values(CONNECT_PRESET_IMAP_HOSTS))].sort()).toEqual(named.map((p) => p.id).sort());
    for (const other of ["mail.praxis-sonnhalde.ch", "imap.gmail.com.example.net", "", undefined, 993]) {
      expect(presetOfImapHost(other), String(other)).toBe("imap");
    }
  });

  it("0054's CHECKs admit every word the recorder can write, and refuse anything a person typed", async () => {
    const db = await makeTestDb();
    const [account] = await db.insert(accounts).values({ name: "words" }).returning();
    const row = { accountId: account!.id, door: "test", preset: "imap", outcome: "ok" };
    for (const preset of CONNECT_PRESETS) await db.insert(connectAttempts).values({ ...row, preset });
    for (const door of CONNECT_DOORS) await db.insert(connectAttempts).values({ ...row, door });
    for (const reason of CONNECT_REASONS) {
      for (const transport of [null, "imap", "smtp"]) {
        await db.insert(connectAttempts).values({ ...row, outcome: "refused", reason, transport });
      }
    }
    expect(await db.select().from(connectAttempts)).toHaveLength(CONNECT_PRESETS.length + CONNECT_DOORS.length + CONNECT_REASONS.length * 3);
    for (const bad of [
      { preset: "mila@lichtgrat.example" }, { preset: "imap.gmail.com" }, { preset: "Gmail" },
      { outcome: "refused", reason: "The server said: invalid credentials" }, { outcome: "refused", reason: "a".repeat(33) },
      { reason: "auth" }, { outcome: "refused" }, { outcome: "failed", reason: "auth" },
      { door: "discover" }, { outcome: "refused", reason: "auth", transport: "pop3" },
    ]) {
      await expect(db.insert(connectAttempts).values({ ...row, ...bad }), JSON.stringify(bad)).rejects.toThrow();
    }
  });
});

describe("the providers.* parity list", () => {
  it("names the same brands in both languages", () => {
    expect(Object.keys(de.providers)).toEqual(Object.keys(en.providers));
    const names = (m: typeof en) => Object.entries(m.providers).filter(([k]) => !["title", "any", "note"].includes(k));
    expect(names(de)).toEqual(names(en));
    expect(names(en).map(([, label]) => label)).toEqual(PROVIDERS.filter((p) => !p.manual).map((p) => p.label));
  });
});
