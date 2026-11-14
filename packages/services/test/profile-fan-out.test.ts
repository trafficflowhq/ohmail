import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { accountSettings, awayResponders, mailboxes, organizerRequests } from "@trafficflow/db";
import {
  AwayResponderService, setDormancyDays, setMailboxSignature, setScreeningPreference,
  MAILBOX_SIGNATURE_MAX_CHARS,
} from "../src/index.js";
import { TRAVELLING_SIGNATURE_MAX_CHARS } from "../src/profile-request.js";
import { makeCtx } from "./helpers.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE PROFILE FAMILY — the ruling's CRITICAL, and it is a Critical because nothing failed
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Four doors edit configuration that the install ORGANIZING a mailbox applies: the away responder
 * (it sends the replies), the screening preference (it files new mail and re-routes the backlog),
 * the dormancy window (it does arithmetic on the cutline), and the mailbox signature (it appends
 * the sign-off to outgoing mail). All four are read from the organizer's PUBLISHED DOCUMENT.
 *
 * Before mail 0094 none of them had an organizer gate of any kind. On a mailbox this install only
 * reads, each wrote the reader's own row and the pane showed the edit as done — so somebody set an
 * out-of-office and no out-of-office was ever sent. Not "stopped at the organizer": silently
 * ineffective, with every guard green, which is why ruling 6 grades it Critical rather than rough.
 *
 * THE CONTROL THE RULING NAMES is the second half of every case here: the request exists AND the
 * local row is UNCHANGED. Keeping the local write beside the request is what made the old
 * behaviour a false state rather than a delay, so "never both" is the property, and the mutation
 * that restores the local write has to redden these.
 */

const away = new AwayResponderService();
type World = Awaited<ReturnType<typeof makeCtx>>;

async function demoteOwn(w: World, capabilities = "requests,profile"): Promise<void> {
  await w.db.update(mailboxes).set({
    organizerRole: "reader", organizerState: "held",
    organizedByCapabilities: capabilities,
    organizedByKind: "cloud", organizedByName: "ohmail Cloud",
  }).where(eq(mailboxes.id, w.mailboxId));
}

async function addReader(w: World, capabilities = "requests,profile"): Promise<string> {
  const [mb] = await w.db.insert(mailboxes).values({
    accountId: w.accountId, provider: "imap",
    address: `pf-${Math.random().toString(36).slice(2, 10)}@lichtgrat.example`,
    organizerRole: "reader", organizerState: "held",
    organizedByCapabilities: capabilities,
    organizedByKind: "local", organizedByName: "mila-thinkpad",
  }).returning();
  return mb!.id;
}

async function requests(w: World) {
  return w.db.select().from(organizerRequests)
    .where(eq(organizerRequests.accountId, w.accountId));
}

const RESPONDER = { enabled: true, body: "Away until Monday.", audience: "everyone" };

describe("the away responder", () => {
  it("a reader's edit becomes ONE profile.update AND leaves away_responders UNCHANGED", async () => {
    const w = await makeCtx();
    // A row that already exists, so "unchanged" is a positive fact rather than an absence.
    await away.put(w.ctx, { enabled: false, body: "old text", audience: "screened_in" });
    await demoteOwn(w);

    const result = await away.put(w.ctx, RESPONDER);
    expect(result.pending).toBe(true);

    const rows = await requests(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "profile.update", mailboxId: w.mailboxId, state: "pending" });
    expect(rows[0]!.payload).toEqual({
      awayResponder: {
        enabled: true, body: "Away until Monday.", startsAt: null, endsAt: null,
        audience: "everyone", throttle: "per_day",
        // The scope travels too (ruling of 2026-09-10). `RESPONDER` names no piles, so this is
        // the value `validPiles` infers for an omitted list — the Ohbox alone, the narrow member.
        piles: ["INBOX"],
      },
    });

    // ── THE RULING'S CONTROL: the local row did not move ────────────────────────────────────
    const [row] = await w.db.select().from(awayResponders)
      .where(eq(awayResponders.accountId, w.accountId));
    expect(row).toMatchObject({ enabled: false, body: "old text", audience: "screened_in" });
    // …and the answer hands back what this install still holds, not what was typed.
    expect(result.responder).toMatchObject({ enabled: false, body: "old text" });
  });

  it("a reader opting Reads IN sends that scope, and the local row keeps the one it had", async () => {
    /* ══ THE RULING OF 2026-09-10, at the door that produces the request ══════════════════════
     *
     * The scope (`piles`, mail 0096) is the field this whole fan-out was built without: the patch
     * carried six members, so a save on a MIXED or READER account sent everything EXCEPT the
     * thing the person had just changed. Nothing failed — the request was valid, the organizer
     * acked it `applied`, and the scope came back as it was.
     *
     * Both halves are asserted, because either alone is satisfied by a defect. The payload
     * carrying the WIDE value proves the field travels; the local row still holding the NARROW
     * one proves the reader arm did not start writing locally to make it look like it did.
     */
    const w = await makeCtx();
    // A row that already exists, at the narrow scope, so "unchanged" is a positive fact.
    await away.put(w.ctx, { enabled: true, body: "old text", piles: ["INBOX"] });
    await demoteOwn(w);

    const result = await away.put(w.ctx, { ...RESPONDER, piles: ["INBOX", "ohmail/News"] });
    expect(result.pending).toBe(true);

    const rows = await requests(w);
    expect(rows).toHaveLength(1);
    const sent = (rows[0]!.payload as { awayResponder: { piles: string[] } }).awayResponder;
    expect(sent.piles, "the scope did not travel — the pane will show the old value back")
      .toEqual(["INBOX", "ohmail/News"]);

    // ── THE RULING'S CONTROL: the local row did not move, scope included ────────────────────
    const [row] = await w.db.select().from(awayResponders)
      .where(eq(awayResponders.accountId, w.accountId));
    expect(row!.piles).toEqual(["INBOX"]);
    expect(result.responder.piles, "the answer showed the typed scope rather than the stored one")
      .toEqual(["INBOX"]);
  });

  it("a mixed account writes the row AND sends one request per held mailbox", async () => {
    const w = await makeCtx();                 // own mailbox stays the organizer
    const held = await addReader(w);

    const result = await away.put(w.ctx, { ...RESPONDER, piles: ["INBOX", "ohmail/News"] });
    expect(result.pending).toBeUndefined();
    expect(result.responder.enabled).toBe(true);

    const [row] = await w.db.select().from(awayResponders)
      .where(eq(awayResponders.accountId, w.accountId));
    expect(row!.body).toBe("Away until Monday.");

    expect(result.travel!.appliedLocally).toEqual([w.mailboxId]);
    expect(result.travel!.pending.map((p) => p.mailboxId)).toEqual([held]);
    const queued = await requests(w);
    expect(queued).toHaveLength(1);

    /* THE TWO ARMS AGREE ON THE SCOPE. A mixed account writes one row here and asks another
     * install about the mailboxes it holds; the request carrying a different scope from the one
     * written locally would make the same account answer two different sets of mail depending on
     * which install holds which mailbox — and both would be reported as one save. */
    const sent = (queued[0]!.payload as { awayResponder: { piles: string[] } }).awayResponder;
    expect(sent.piles).toEqual(["INBOX", "ohmail/News"]);
    expect(sent.piles).toEqual(row!.piles);
  });

  it("against a `requests`-only holder it is 409, and nothing is written or queued", async () => {
    const w = await makeCtx();
    await away.put(w.ctx, { enabled: false, body: "old text" });
    await demoteOwn(w, "requests");

    await expect(away.put(w.ctx, RESPONDER)).rejects.toMatchObject({
      code: "organized_elsewhere", httpStatus: 409,
      details: { reason: "organizer_outdated", by: { name: "ohmail Cloud" } },
    });
    expect(await requests(w)).toEqual([]);
    const [row] = await w.db.select().from(awayResponders)
      .where(eq(awayResponders.accountId, w.accountId));
    expect(row!.body).toBe("old text");
  });
});

describe("the mailbox signature — PER MAILBOX, not per account", () => {
  it("a reader's signature travels and the column is untouched", async () => {
    const w = await makeCtx();
    await setMailboxSignature(w.ctx, w.mailboxId, "— Mila");
    await demoteOwn(w);

    const result = await setMailboxSignature(w.ctx, w.mailboxId, "— G, sent from the laptop");
    expect(result.pending).toBe(true);
    expect(result.holder).toMatchObject({ name: "ohmail Cloud" });
    expect(result.signature).toBe("— Mila");          // the column, unchanged

    const [mb] = await w.db.select({ signature: mailboxes.signature })
      .from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(mb!.signature).toBe("— Mila");
    /* BOTH SHAPES on the wire (ruling of 2026-09-10), and the `null` is the load-bearing half: a
       plain save clears the markup locally, so it has to say so across the wire too. An ABSENT
       key would leave the holder's markup standing over the words just saved. */
    const plain = (await requests(w))[0]!.payload as Record<string, unknown>;
    expect(plain).toEqual({ signature: "— G, sent from the laptop", signatureHtml: null });
    expect("signatureHtml" in plain, "a plain save sent no instruction to clear the markup").toBe(true);
  });

  it("goes to the mailbox's OWN holder, and a second mailbox's holder is not asked", async () => {
    /* The account-wide question would publish one mailbox's sign-off into the other's document —
     * `serializeOrganizerProfile` takes a mailbox id for exactly this reason. */
    const w = await makeCtx();
    await demoteOwn(w);
    const other = await addReader(w);

    const result = await setMailboxSignature(w.ctx, other, "— from the other address");
    expect(result.pending).toBe(true);
    expect(result.holder).toMatchObject({ name: "mila-thinkpad" });
    const rows = await requests(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mailboxId).toBe(other);
  });

  it("a TRAVELLING signature is bounded at 2 000 characters; a LOCAL one still allows 10 000", async () => {
    /* Two bounds, and both are needed. The local one has no wire to cross. The travelling one is
     * the sentence a person reads instead of a refusal about encoded bytes — and the byte ceiling
     * behind it stays the guarantee, since the maximum count of multi-byte glyphs can still exceed the record's
     * cap and are refused there rather than truncated. */
    expect(TRAVELLING_SIGNATURE_MAX_CHARS).toBeLessThan(MAILBOX_SIGNATURE_MAX_CHARS);

    const w = await makeCtx();
    // LOCAL, as an organizer: well past the travelling bound and accepted, as it always was.
    const long = "x".repeat(TRAVELLING_SIGNATURE_MAX_CHARS + 500);
    const local = await setMailboxSignature(w.ctx, w.mailboxId, long);
    expect(local.signature).toBe(long);
    expect(local.pending).toBeUndefined();

    // TRAVELLING: the same text is refused, in words about the signature.
    await demoteOwn(w);
    await expect(setMailboxSignature(w.ctx, w.mailboxId, long))
      .rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
    expect(await requests(w)).toEqual([]);

    // …and one character under the bound travels.
    const fits = "y".repeat(TRAVELLING_SIGNATURE_MAX_CHARS);
    const sent = await setMailboxSignature(w.ctx, w.mailboxId, fits);
    expect(sent.pending).toBe(true);
    expect(await requests(w)).toHaveLength(1);
  });

  it("a travelling markup save echoes the column's PREVIOUS html, never the typed one", async () => {
    /* The markup does not travel: the request carries the derived TEXT, so the holder's markup is
       untouched. The answer therefore has to READ BOTH COLUMNS BACK — echoing what was typed would
       report a value this install did not write. */
    const w = await makeCtx();
    const first = await setMailboxSignature(
      w.ctx, w.mailboxId, null, "<p>\u2014 <strong>Mila</strong></p>",
    );
    expect(first.signatureHtml).not.toBeNull();
    await demoteOwn(w);

    const typed = "<p>\u2014 <em>G, sent from the laptop</em></p>";
    const result = await setMailboxSignature(w.ctx, w.mailboxId, null, typed);
    expect(result.pending).toBe(true);
    expect(result.signatureHtml).toBe(first.signatureHtml);   // the column, unchanged
    expect(result.signature).toBe(first.signature);
    expect(result.signatureHtml).not.toBe(typed);

    const [mb] = await w.db
      .select({ signature: mailboxes.signature, signatureHtml: mailboxes.signatureHtml })
      .from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(mb!.signatureHtml).toBe(first.signatureHtml);

    /* BOTH HALVES on the wire (ruling of 2026-09-10). Before it the payload had one signature
       slot and it was the derived TEXT, so the formatting was dropped at the holder with nothing
       reporting a partial result. The text half is still text — the holder stores the pair the
       local write would have stored, and neither shape is derived on the far side. */
    const [req] = await requests(w);
    const payload = req!.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["signature", "signatureHtml"]);
    expect(String(payload.signature), "the text half carried markup").not.toContain("<");
    expect(String(payload.signatureHtml), "the markup half did not travel").toContain("<em>");
  });
});

describe("the dormancy window and the screening preference", () => {
  it("a reader's window edit travels, and account_settings.dormancy_days is untouched", async () => {
    const w = await makeCtx();
    await setDormancyDays(w.ctx, 90);
    await demoteOwn(w);

    const result = await setDormancyDays(w.ctx, 30);
    expect(result.pending).toBe(true);
    expect(result.dormancyDays).toBe(90);              // the stored value, not the typed one

    const [row] = await w.db.select({ d: accountSettings.dormancyDays })
      .from(accountSettings).where(eq(accountSettings.accountId, w.accountId));
    expect(row!.d).toBe(90);
    expect((await requests(w))[0]!.payload).toEqual({ dormancyDays: 30 });
  });

  it("the payload carries ONLY the fields the request named — absence is load-bearing", async () => {
    /* A full-document payload cannot tell "the person edited their bar" from "the person cleared
     * their policy", so a door that knew about one setting would send nulls for the others and
     * wipe them on the machine that applies them. */
    const w = await makeCtx();
    await demoteOwn(w);

    await setScreeningPreference(w.ctx, { ohboxBar: "only people I know" });
    const [only] = await requests(w);
    expect(only!.payload).toEqual({ screeningPreference: { ohboxBar: "only people I know" } });
    // `ohboxPolicy` and `impersonationFiling` are ABSENT, not null.
    const sp = (only!.payload as { screeningPreference: Record<string, unknown> }).screeningPreference;
    expect("ohboxPolicy" in sp).toBe(false);
    expect("impersonationFiling" in sp).toBe(false);
  });

  it("a screening edit naming no setting sends nothing — the holder refuses an empty object", async () => {
    const w = await makeCtx();
    await demoteOwn(w);
    const result = await setScreeningPreference(w.ctx, {});
    expect(result.pending).toBeUndefined();
    expect(await requests(w)).toEqual([]);
  });

  it("a screening-preference edit on a reader leaves account_settings alone", async () => {
    const w = await makeCtx();
    await setScreeningPreference(w.ctx, { ohboxPolicy: "people_only" });
    await demoteOwn(w);

    const result = await setScreeningPreference(w.ctx, { ohboxPolicy: null });
    expect(result.pending).toBe(true);
    expect(result.ohboxPolicy).toBe("people_only");    // unchanged here
    const [row] = await w.db.select({ p: accountSettings.ohboxPolicy })
      .from(accountSettings).where(eq(accountSettings.accountId, w.accountId));
    expect(row!.p).toBe("people_only");
  });
});

describe("onboarding: nothing held and nothing organized is ADMITTED", () => {
  it("every settings door writes locally when the account has no live mailbox", async () => {
    /* THE HALF OF THE OLD CENSUS EXEMPTION THAT WAS RIGHT, now enforced rather than argued. At
     * consent time nothing is organized yet; refusing here would mean a person could not choose a
     * window or a sign-off until after they had finished setting up. */
    const w = await makeCtx();
    await w.db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, w.mailboxId));

    const window = await setDormancyDays(w.ctx, 45);
    expect(window.dormancyDays).toBe(45);
    expect(window.pending).toBeUndefined();

    const responder = await away.put(w.ctx, RESPONDER);
    expect(responder.pending).toBeUndefined();
    expect(responder.responder.enabled).toBe(true);

    const pref = await setScreeningPreference(w.ctx, { ohboxPolicy: "people_only" });
    expect(pref.pending).toBeUndefined();
    expect(pref.ohboxPolicy).toBe("people_only");

    expect(await requests(w)).toEqual([]);
  });
});
