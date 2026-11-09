/**
 * "FILED AUTOMATICALLY" ON THE PHONE (row 140) — the web Settings row's route pair. The read
 * narrows the page and answers `null` for a read it could not make, never an empty list (which
 * would say nothing was filed); Put back sends exactly the ids pressed and reads the answer's two
 * lists; the sentence after it says where the mail goes, in both languages.
 */
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { putBackAutoFiled, readAutoFiled, readImpersonationFiling, saveImpersonationFiling } from "../src/net/auto-filed";
import type { ConnectedSession } from "../src/net/pairing";
import { autoFiledSaid } from "../src/ui/auto-filed-said";
import { impersonationWhy, newestSeen, unseenImpersonations } from "../src/ui/impersonation-notice";
import { impersonationSeenStore, IMPERSONATION_SEEN_KEY } from "../src/state/impersonation-seen-store";
import { DECKS } from "../src/copy";

function server(answer: { get: number; getBody: unknown }) {
  const posts: unknown[] = [];
  const s = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(answer.get, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.getBody));
      return;
    }
    let raw = "";
    req.on("data", (c) => { raw += String(c); });
    req.on("end", () => {
      const body = JSON.parse(raw) as { messageIds: string[] };
      posts.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ putBack: body.messageIds, requested: [] }));
    });
  });
  return { s, posts };
}
const listen = (s: Server): Promise<string> => new Promise((resolve) => {
  s.listen(0, "127.0.0.1", () => {
    const a = s.address();
    resolve(`http://127.0.0.1:${typeof a === "object" && a !== null ? a.port : 0}`);
  });
});
const sessionFor = (origin: string): ConnectedSession => ({
  profile: { origin, apiBase: null },
  fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
}) as unknown as ConnectedSession;

describe("the route pair", () => {
  it("reads the page, drops a row with no id, and Put back sends exactly the ids pressed", async () => {
    const { s, posts } = server({ get: 200, getBody: { items: [
      { messageId: "m1", from: "news@shop.test", subject: "Deals", to: "ohmail/News" },
      { from: "x@shop.test", to: "ohmail/News" },
    ], more: false } });
    const origin = await listen(s);
    try {
      const session = sessionFor(origin);
      expect(await readAutoFiled(session)).toEqual({
        items: [{
          messageId: "m1", from: "news@shop.test", subject: "Deals", to: "ohmail/News", filedAt: null, why: null, brand: null,
        }], more: false,
      });
      expect(await putBackAutoFiled(session, ["m1"])).toEqual({ putBack: ["m1"], requested: [] });
      expect(posts).toEqual([{ messageIds: ["m1"] }]);
    } finally { s.close(); }
  });

  it("a read that could not be made is null, never an empty list (the control)", async () => {
    const { s } = server({ get: 404, getBody: { error: { code: "not_found" } } });
    const origin = await listen(s);
    try {
      expect(await readAutoFiled(sessionFor(origin))).toBeNull();
    } finally { s.close(); }
  });
});

describe("the sentence after a press", () => {
  it("says where the mail goes, and names a request as a request", () => {
    expect(autoFiledSaid({ k: "done", n: 2 })).toContain("2 messages go back to your Screener");
    expect(autoFiledSaid({ k: "requested" })).toContain("install that organizes");
    expect(autoFiledSaid(null)).toBeNull();
    expect(DECKS.de.autoFiledPutBackDone(1)).toContain("1 Nachricht kommt");
  });
});

/* A HELD IMPERSONATION FILED TO SPAM (owner, 2026-11-09): the Screener tab's line and the Settings switch. */
describe("the impersonation filings and their switch", () => {
  const PHISH = {
    messageId: "p1", from: "billing@hosting-renewals.example", subject: "Zahlung", to: "ohmail/Quarantine",
    filedAt: "2026-11-09T11:00:00.000Z", why: "impersonation" as const, brand: "Metanet",
  };

  it("a filing carries its reason and company; any other reason reads as none", async () => {
    const { s } = server({ get: 200, getBody: { items: [
      { ...PHISH },
      { messageId: "a1", from: "deals@shop.test", subject: "Sale", to: "ohmail/Quarantine", filedAt: "x", why: "crowd", brand: "Shop" },
    ], more: false } });
    const origin = await listen(s);
    try {
      const page = await readAutoFiled(sessionFor(origin));
      expect(page!.items).toEqual([
        PHISH,
        { messageId: "a1", from: "deals@shop.test", subject: "Sale", to: "ohmail/Quarantine", filedAt: "x", why: null, brand: null },
      ]);
    } finally { s.close(); }
  });

  it("the line counts impersonations newer than this phone's mark, and OK records the newest", () => {
    const older = { ...PHISH, messageId: "p0", filedAt: "2026-11-09T09:00:00.000Z" };
    const other = { ...PHISH, messageId: "a1", why: null, brand: null };
    expect(unseenImpersonations([PHISH, older, other], "").map((i) => i.messageId)).toEqual(["p1", "p0"]);
    expect(unseenImpersonations([PHISH, older, other], older.filedAt).map((i) => i.messageId)).toEqual(["p1"]);
    expect(newestSeen([older, PHISH], "")).toBe(PHISH.filedAt);
    expect(newestSeen([], older.filedAt)).toBe(older.filedAt);
    expect(impersonationWhy(PHISH)).toBe(
      "This message claims to be from Metanet, but hosting-renewals.example isn't one of Metanet's addresses.");
    expect(DECKS.de.impersonationFiled(2)).toBe("2 Nachrichten, die sich als Firma ausgaben, sind in Spam");
    expect(DECKS.en.impersonationFiled(1)).toBe("1 letter that claimed to be a company went to Spam");
  });

  it("the mark is kept on this phone, and a late boot read never takes back a newer OK", async () => {
    const kept = new Map<string, string>();
    let release: (v: string | null) => void = () => {};
    const kv = {
      get: (k: string) => (k === IMPERSONATION_SEEN_KEY ? new Promise<string | null>((r) => { release = r; }) : Promise.resolve(null)),
      set: async (k: string, v: string) => { kept.set(k, v); },
      remove: async () => {},
    };
    const seen: string[] = [];
    const store = impersonationSeenStore(kv, (iso) => seen.push(iso));
    const boot = store.boot();
    store.set(PHISH.filedAt);
    release("2026-11-01T00:00:00.000Z");
    await boot;
    expect(seen).toEqual([PHISH.filedAt]);
    expect(kept.get(IMPERSONATION_SEEN_KEY)).toBe(PHISH.filedAt);
  });

  it("the switch reads and writes /account/screening, and a server without it answers null", async () => {
    let stored: boolean | undefined = true;
    const bodies: unknown[] = [];
    const sv = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += String(c); });
      req.on("end", () => {
        if (req.method === "PATCH") {
          const body = JSON.parse(raw) as { impersonationFiling: boolean };
          bodies.push(body);
          stored = body.impersonationFiling;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(stored === undefined ? { ohboxPolicy: null } : { impersonationFiling: stored }));
      });
    });
    const origin = await listen(sv);
    try {
      const session = sessionFor(origin);
      expect(await readImpersonationFiling(session)).toBe(true);
      expect(await saveImpersonationFiling(session, false)).toBe(false);
      expect(bodies).toEqual([{ impersonationFiling: false }]);
      stored = undefined;
      expect(await readImpersonationFiling(session), "an older server draws no switch").toBeNull();
    } finally { sv.close(); }
  });
});
