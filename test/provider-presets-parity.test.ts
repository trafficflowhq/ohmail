import { describe, expect, it } from "vitest";
import {
  DISCOVER_MX_PRESETS, DISCOVER_PROTON_MX, discoverMailHosting, type MailDnsResolver,
} from "@trafficflow/api";
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

describe("the providers.* parity list", () => {
  it("names the same brands in both languages", () => {
    expect(Object.keys(de.providers)).toEqual(Object.keys(en.providers));
    const names = (m: typeof en) => Object.entries(m.providers).filter(([k]) => !["title", "any", "note"].includes(k));
    expect(names(de)).toEqual(names(en));
    expect(names(en).map(([, label]) => label)).toEqual(PROVIDERS.filter((p) => !p.manual).map((p) => p.label));
  });
});
