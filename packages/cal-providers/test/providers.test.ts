/**
 * The providers as a composing program gets them: none unless it names it, Microsoft only with the
 * base of its API named beside the word, and each reached through a request port made here from the
 * program's own lookup and its policy on addresses.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { intlZones } from "@ohmail/cal-core";
import type { HostResolver } from "@trafficflow/core/net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompositionFault, MS_GRAPH_BASE, makeCalendarProviders, type ProviderDeps } from "../src/index.js";
import type { Connection, ProviderWord } from "../src/port.js";

const WORDS: readonly ProviderWord[] = ["google", "caldav", "microsoft", "ics"];
const zones = intlZones();
const never = new AbortController().signal;

/** What a composing program hands in, with a lookup that counts what it was asked. */
function composed(over: Partial<ProviderDeps>): { deps: ProviderDeps; looked: string[] } {
  const looked: string[] = [];
  const resolver: HostResolver = {
    resolve: async (name) => {
      looked.push(name);
      return name === "localhost" ? ["127.0.0.1"] : [];
    },
  };
  return { deps: { clock: { now: () => Date.parse("2026-11-14T08:00:00Z") }, zones, resolver, policy: { kind: "cloud" }, enabled: new Set(), microsoft: null, ...over }, looked };
}
const served = (deps: ProviderDeps): (ProviderWord | null)[] => {
  const providers = makeCalendarProviders(deps);
  return WORDS.map((word) => (providers.get(word) === null ? null : word));
};

let feeds: Server;
let port = 0;
let connections = 0;
beforeAll(async () => {
  feeds = createServer((_req, res) => res.writeHead(200, { "content-type": "text/calendar" }).end("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:stall@bench.example.test\r\nDTSTART;VALUE=DATE:20261123\r\nSUMMARY:Stall planning\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"));
  feeds.on("connection", () => connections++);
  await new Promise<void>((done) => feeds.listen(0, "127.0.0.1", done));
  port = (feeds.address() as AddressInfo).port;
});
afterAll(() => {
  feeds.closeAllConnections();
  feeds.close();
});

describe("the calendar's providers", () => {
  it("serve nothing that the composing program does not name", () => {
    const { deps, looked } = composed({ enabled: new Set(), microsoft: { graphBase: MS_GRAPH_BASE } });
    expect(served(deps)).toEqual([null, null, null, null]);
    expect(looked).toEqual([]);
  });

  it("serve the ones it names and no other, each the reader of its own word", () => {
    expect(served(composed({ enabled: new Set<ProviderWord>(["google"]) }).deps)).toEqual(["google", null, null, null]);
    expect(served(composed({ enabled: new Set<ProviderWord>(["ics", "caldav"]) }).deps)).toEqual([null, "caldav", null, "ics"]);
    const all = composed({ enabled: new Set<ProviderWord>(WORDS), microsoft: { graphBase: MS_GRAPH_BASE } }).deps;
    expect(served(all)).toEqual(WORDS);
    const providers = makeCalendarProviders(all);
    expect(WORDS.map((word) => providers.get(word)!.reader.provider)).toEqual(WORDS);
  });

  it("serve Microsoft only when both of its switches are named: the word, and the base of its API", () => {
    // The base alone switches nothing on.
    expect(served(composed({ enabled: new Set<ProviderWord>(["google"]), microsoft: { graphBase: MS_GRAPH_BASE } }).deps)).toEqual(["google", null, null, null]);
    // The word alone is a fault of the composing program, said at once: there is no base to fall back to.
    expect(() => makeCalendarProviders(composed({ enabled: new Set<ProviderWord>(["microsoft"]), microsoft: null }).deps)).toThrow(CompositionFault);
    expect(served(composed({ enabled: new Set<ProviderWord>(["microsoft"]), microsoft: { graphBase: MS_GRAPH_BASE } }).deps)).toEqual([null, null, "microsoft", null]);
    // Microsoft's own address is a constant of the package, read here without a dial.
    expect(MS_GRAPH_BASE).toBe("https://graph.microsoft.com/v1.0");
  });

  it("take no base for Microsoft on a hosted server that is not a public https address; a person's own computer may name one on this machine", () => {
    for (const graphBase of ["http://127.0.0.1:8822/v1.0", "http://graph.microsoft.com/v1.0", "https://127.0.0.1/v1.0", "https://graph.microsoft.com:8443/v1.0", "https://graph.internal/v1.0", "not an address"]) {
      expect(() => makeCalendarProviders(composed({ enabled: new Set<ProviderWord>(["microsoft"]), microsoft: { graphBase } }).deps), graphBase).toThrow(CompositionFault);
    }
    expect(served(composed({ policy: { kind: "own-network" }, enabled: new Set<ProviderWord>(["microsoft"]), microsoft: { graphBase: "http://127.0.0.1:8822/v1.0" } }).deps)).toEqual([null, null, "microsoft", null]);
  });

  it("reach Microsoft at the base that was named and at its sign-in's host, and nowhere else", async () => {
    const { deps, looked } = composed({ enabled: new Set<ProviderWord>(["microsoft"]), microsoft: { graphBase: MS_GRAPH_BASE } });
    const microsoft = makeCalendarProviders(deps).get("microsoft")!;
    const get = { method: "GET" as const, headers: {}, body: null, auth: null, validators: null, signal: never };
    expect(await microsoft.http.request("https://www.googleapis.com/calendar/v3/users/me/calendarList", get)).toEqual({ arrived: false, reason: "address_not_allowed" });
    expect(looked).toEqual([]);
    expect(await microsoft.http.request("https://graph.microsoft.com/v1.0/me/calendars", get)).toEqual({ arrived: false, reason: "host_unresolved" });
    expect(await microsoft.http.request("https://login.microsoftonline.com/common/oauth2/v2.0/token", get)).toEqual({ arrived: false, reason: "host_unresolved" });
    expect(looked).toEqual(["graph.microsoft.com", "login.microsoftonline.com"]);
  });

  it("refuse a word that is none of the four", () => {
    expect(() => makeCalendarProviders(composed({ enabled: new Set(["exchange" as ProviderWord]) }).deps)).toThrow(CompositionFault);
  });

  it("reach a host a person named through the program's own lookup and its policy: the same address, read at home and refused when hosted", async () => {
    const subscription: Connection = { provider: "ics", credential: { kind: "address", url: () => `http://localhost:${port}/stall.ics` }, start: null };
    const page = { limit: 250, cursor: null, window: null };

    const home = composed({ policy: { kind: "own-network" }, enabled: new Set<ProviderWord>(["ics"]) });
    const read = await makeCalendarProviders(home.deps).get("ics")!.reader.readChanges(subscription, { id: "subscription" }, null, page, never);
    expect(read.ok && read.value.items.map((item) => item.kind === "upsert" && item.event.summary)).toEqual(["Stall planning"]);
    expect([home.looked, connections]).toEqual([["localhost"], 1]);

    const hosted = composed({ policy: { kind: "cloud" }, enabled: new Set<ProviderWord>(["ics"]) });
    expect(await makeCalendarProviders(hosted.deps).get("ics")!.reader.readChanges(subscription, { id: "subscription" }, null, page, never)).toEqual({ ok: false, reason: "address_not_allowed", retryAfterMs: null });
    expect([hosted.looked, connections]).toEqual([[], 1]);
  });

  it("hand out each provider's own request port, which dials that provider's hosts and no other", async () => {
    const { deps, looked } = composed({ enabled: new Set<ProviderWord>(["google"]) });
    const google = makeCalendarProviders(deps).get("google")!;
    const get = { method: "GET" as const, headers: {}, body: null, auth: null, validators: null, signal: never };
    expect(await google.http.request(`http://localhost:${port}/calendar/v3/users/me/calendarList`, get)).toEqual({ arrived: false, reason: "address_not_allowed" });
    expect(await google.http.request("https://evil.example.test/calendar/v3/users/me/calendarList", get)).toEqual({ arrived: false, reason: "address_not_allowed" });
    expect(looked).toEqual([]);
    // One of Google's own hosts passes the list and reaches the lookup, which here knows nobody.
    expect(await google.http.request("https://www.googleapis.com/calendar/v3/users/me/calendarList", get)).toEqual({ arrived: false, reason: "host_unresolved" });
    expect(looked).toEqual(["www.googleapis.com"]);
  });
});

describe("who may hold the providers", () => {
  // The manifests of the programs, not their source: only a server, a worker or a desktop's engine composes a provider.
  const APPS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps");
  const MAY: ReadonlySet<string> = new Set(["server", "worker", "sidecar"]);

  it("is no program a person holds in the hand or opens in a browser: none of their manifests names this package", () => {
    const apps = readdirSync(APPS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    expect(apps).toEqual(expect.arrayContaining(["webapp", "desktop", "mobile"]));
    const naming = apps.filter((app) => {
      const manifest = JSON.parse(readFileSync(join(APPS, app, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
      return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some((kind) => manifest[kind]?.["@ohmail/cal-providers"] !== undefined);
    });
    expect(naming.filter((app) => !MAY.has(app))).toEqual([]);
  });
});
