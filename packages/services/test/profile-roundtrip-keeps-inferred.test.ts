import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { accountSettings, contacts } from "@trafficflow/db";
import { carryDialect } from "@trafficflow/db/dialect";
import { makeProfileDoc, profileFingerprint, type OrganizerProfilePayload } from "@trafficflow/core/adapters/organizer-profile";
import { applyOrganizerProfile, serializeOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { claimedIdentity, evaluateRules, DEFAULT_OHBOX_POLICY, normalizeMime } from "@trafficflow/core/mail";
import { makeCtx } from "./helpers.js";

/**
 * A PROFILE ROUND TRIP KEEPS WHO MADE A CONTACT (mail 0148). An inferred contact —
 * what the act's admission and the reply arm leave behind — travels unstated and comes back
 * inferred, so a name claiming a company from that address is still held; a person's contact
 * travels as one. A document with no source (an older ohmail's) imports as inferred, and a
 * document never upgrades a contact this install already holds as inferred.
 */
const NOW = new Date("2026-10-07T12:00:00Z");
const X = "kundendienst@karten-service.test";
const P = "ines.aebersold@example.test";

type World = Awaited<ReturnType<typeof makeCtx>>;

async function apply(w: World, payload: OrganizerProfilePayload): Promise<void> {
  const doc = makeProfileDoc(payload, { updatedAt: NOW, producer: { kind: "local", version: "0.25.18" } });
  await w.db.transaction((tx) => applyOrganizerProfile(carryDialect(w.db, tx) as never, {
    accountId: w.accountId, mailboxId: w.mailboxId, doc, fingerprint: profileFingerprint(doc), now: NOW,
  }));
}

async function sourceOf(w: World, address: string): Promise<string | null> {
  const [row] = await w.db.select({ source: contacts.source }).from(contacts)
    .where(and(eq(contacts.accountId, w.accountId), eq(contacts.address, address)));
  return row?.source ?? null;
}

async function gateOn(w: World, from: string) {
  const known = await makeDrizzleRepo(w.db as never).knownSenders(w.accountId);
  const raw = Buffer.from([`Message-ID: <p-1@karten-service.test>`, `From: "PostFinance" <${from}>`, "To: me@own.invalid",
    "Subject: Ihre Karte wird gesperrt", "Content-Type: text/plain", "", "x"].join("\r\n"));
  const msg = await normalizeMime(raw);
  const identity = claimedIdentity({ fromName: msg.from.name, fromAddress: msg.from.address, subject: msg.subject }) ?? null;
  return evaluateRules({
    msg, rules: [], knownSenders: known, auth: "unavailable", ohboxPolicy: DEFAULT_OHBOX_POLICY,
    ownAddresses: new Set(), identity,
  });
}

describe("the profile round trip and who made a contact", () => {
  it("an inferred contact travels unstated and comes back inferred; a claim from it is still held", async () => {
    const w = await makeCtx(NOW);
    await w.db.insert(contacts).values({ accountId: w.accountId, address: X, source: "inferred" });
    const payload = await serializeOrganizerProfile(w.db as never, w.accountId, w.mailboxId);
    expect(payload.screener.find((s) => s.address === X)).toEqual({ address: X });
    await apply(w, payload);
    expect(await sourceOf(w, X)).toBe("inferred");
    const d = await gateOn(w, X);
    expect(d.destination).toBe("ohmail/Screener");
    expect(d.identity?.brand).toBe("PostFinance");
  });

  it("a person's contact travels as one, and a fresh install takes each source as stated", async () => {
    const a = await makeCtx(NOW);
    await a.db.insert(contacts).values([
      { accountId: a.accountId, address: X, source: "inferred" },
      { accountId: a.accountId, address: P, source: "person" },
    ]);
    const payload = await serializeOrganizerProfile(a.db as never, a.accountId, a.mailboxId);
    expect(payload.screener.find((s) => s.address === P)).toEqual({ address: P, source: "person" });
    const b = await makeCtx(NOW);
    await apply(b, payload);
    expect(await sourceOf(b, X)).toBe("inferred");
    expect(await sourceOf(b, P)).toBe("person");
  });

  it("an older document, with no source, imports as inferred", async () => {
    const w = await makeCtx(NOW);
    await apply(w, {
      screener: [{ address: X }], rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null,
    });
    expect(await sourceOf(w, X)).toBe("inferred");
  });

  it("the impersonation filing's off choice travels with the copy; a copy that says nothing changes nothing", async () => {
    const offAt = async (w: World) => (await w.db.select({ at: accountSettings.impersonationFilingOffAt }).from(accountSettings)
      .where(eq(accountSettings.accountId, w.accountId)))[0]?.at ?? null;
    const a = await makeCtx(NOW);
    await a.db.insert(accountSettings).values({ accountId: a.accountId, impersonationFilingOffAt: NOW })
      .onConflictDoUpdate({ target: accountSettings.accountId, set: { impersonationFilingOffAt: NOW } });
    const payload = await serializeOrganizerProfile(a.db as never, a.accountId, a.mailboxId);
    expect(payload.impersonationFiling).toBe(false);
    const b = await makeCtx(NOW);
    await apply(b, payload);
    expect(await offAt(b), "the next organizer keeps the person's off").not.toBeNull();
    const { impersonationFiling: _off, ...unstated } = payload;
    await apply(b, unstated);
    expect(await offAt(b), "a copy without the key never turns it back on").not.toBeNull();
    const c = await makeCtx(NOW);
    await apply(c, unstated);
    expect(await offAt(c), "nor turns it off").toBeNull();
    const on = await serializeOrganizerProfile(c.db as never, c.accountId, c.mailboxId);
    expect(Object.hasOwn(on, "impersonationFiling"), "on is never stated").toBe(false);
  });

  it("a document never upgrades an inferred contact this install holds", async () => {
    const w = await makeCtx(NOW);
    await w.db.insert(contacts).values({ accountId: w.accountId, address: X, source: "inferred" });
    await apply(w, {
      screener: [{ address: X, source: "person" }], rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null,
    });
    expect(await sourceOf(w, X)).toBe("inferred");
  });
});
