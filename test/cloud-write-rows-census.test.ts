/**
 * THE WRITE-THROUGH CENSUS — every write the Cloud-paired sidecar forwards says what it changes
 * here (`apps/sidecar/src/cloud-write-rows.ts`), and every window verb it names is a key of the
 * engine's shadow registry. A relay route added without an entry is a write whose echo nobody
 * decided, so the census refuses it; the planted route below is the census watched failing.
 */
import { describe, expect, it } from "vitest";
import { RELAY_ALLOWLIST } from "@trafficflow/api/relay-allowlist";
import { WRITE_ROWS, writeCensus, writeRowsOf, type WriteRoute } from "../apps/sidecar/src/cloud-write-rows.js";
import { SHADOWED_ROWS } from "../packages/client-engine/src/shadow.js";

/** The one engine verb with no wire: an editor action on an AI draft, never forwarded. */
const LOCAL_ONLY_VERBS = new Set(["draft_accept"]);

describe("every forwarded write names what it changes on this install", () => {
  it("the table and the relay allowlist's writes are the same set", () => {
    const writes = RELAY_ALLOWLIST.filter((s) => s.method !== "GET" && s.method !== "HEAD");
    expect(writes.length, "the census read a relay with no writes").toBeGreaterThan(50);
    expect(writeCensus(RELAY_ALLOWLIST)).toEqual({ missing: [], stale: [] });
  });

  it("a relay route planted without an entry is refused by name", () => {
    const planted = [...RELAY_ALLOWLIST, { method: "POST", pattern: "/planted/:id" }];
    expect(writeCensus(planted).missing).toEqual(["POST /planted/:id"]);
    const { ["PUT /away-responder"]: _gone, ...short } = WRITE_ROWS;
    expect(writeCensus(RELAY_ALLOWLIST, short).missing).toEqual(["PUT /away-responder"]);
  });

  it("every window verb the table names is a shadow-registry key, and every wired verb is named", () => {
    const named = new Set<string>();
    for (const [route, entry] of Object.entries(WRITE_ROWS) as Array<[string, WriteRoute]>) {
      for (const v of entry.verbs ?? []) {
        expect(Object.keys(SHADOWED_ROWS), `${route} names ${v}`).toContain(v);
        named.add(v);
      }
      if (entry.rows === "none") expect(entry.verbs ?? [], `${route} changes nothing here`).toEqual([]);
    }
    const wired = Object.keys(SHADOWED_ROWS).filter((k) => !LOCAL_ONLY_VERBS.has(k));
    expect(wired.filter((k) => !named.has(k)), "verbs no forwarded route carries").toEqual([]);
  });

  it("a route whose body carries a typed sign-in is sent by no window verb: a verb is a queued, stored record", () => {
    // A mailbox's password, and a calendar's password or its subscription's whole address: each is a direct
    // call, sent once and kept nowhere. A verb named here would be that body written into the window's queue,
    // and the case above refuses a wired verb that no entry names.
    for (const route of ["POST /mailboxes", "PATCH /mailboxes/:id", "POST /calendar/connections", "POST /calendar/connections/:id/sign-in"]) {
      expect(Object.keys(WRITE_ROWS), route).toContain(route);
      expect(WRITE_ROWS[route]?.verbs ?? [], route).toEqual([]);
    }
  });

  it("a request finds its entry through the relay's own matching", () => {
    expect(writeRowsOf("POST", "/messages/abc/triage")?.verbs).toEqual(["triage_set"]);
    expect(writeRowsOf("PUT", "/away-responder")?.rows).toBe("none");
    expect(writeRowsOf("PATCH", "/mailboxes/abc")?.rows).toBe("mailboxes");
    expect(writeRowsOf("POST", "/not-a-route")).toBeNull();
  });
});
