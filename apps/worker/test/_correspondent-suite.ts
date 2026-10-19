import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  accountSettings, accounts, auditLog, contacts, folderState, learningSignals, mailboxFolders,
  mailboxes, messageBodies, messageInstances, messages, routingDecisions, rules,
  SCREENER_SUGGESTION_PROVENANCE, SCREENER_SUGGESTION_STATUS, type Tx,
} from "@trafficflow/db";
import { correspondentsAmong, makeDrizzleRepo, recordSpecialFolders } from "@trafficflow/core/adapters/drizzle-repo";
import type { ImapCapabilities } from "@trafficflow/core/adapters/imap-types";
import type { Logger } from "@trafficflow/core/mail";
import type { ClassifierInput, ClassifierPort, ClassifierResult } from "@trafficflow/core/mail";
import { screenerAutoActPass } from "../src/screener-auto-act.js";
import { screenerAutoSuggestPass } from "../src/screener-auto-suggest.js";
import { screenerCorrespondentRetroPass } from "../src/screener-correspondent-retro.js";

/**
 * A CORRESPONDENT IS NEVER FIRST CONTACT — the predicate and the two passes that read it, over a
 * real store (PGlite or the device's SQLite by `makeTestDb`; real Postgres by the `.pg` twin).
 * The world: an account connected on CONNECT, a Sent folder, and Sent copies written after, before
 * and by a machine. Every address is `.invalid`; every read is scoped to the world's own account.
 */

const SCREENER = "ohmail/Screener";
const SPAM = "ohmail/Quarantine";
const CONNECT = new Date("2026-09-01T08:00:00.000Z");
const WROTE = new Date("2026-09-22T15:12:00.000Z");
const HISTORY = new Date("2026-08-15T10:00:00.000Z");

/** Sent by the server's own word: a name no Sent-shaped path matches (Outlook's Dutch Sent). */
const NAMED_SENT = "Verzonden items";

interface World { accountId: string; mailboxId: string; me: string; sent: string }

/**
 * `act: false` leaves out the auto-act arm — the device store's run, where the act's own filing
 * refuses for a reason older than this change (a bind in `applyScreenerDecision`, filed as a gap
 * row), so its stranger control could not be read there.
 */
export function defineCorrespondentSuite(
  label: string, openDb: () => Promise<Tx>, opts: { act: boolean } = { act: true },
): void {
  describe(`${label} — a correspondent is never first contact`, () => {
    let db: Tx;
    beforeAll(async () => { db = await openDb(); }, 120_000);

    async function newWorld(opts: { seedAt?: Date; sent?: string } = {}): Promise<World> {
      const accountId = randomUUID();
      const me = `me-${accountId.slice(0, 8)}@own.invalid`;
      await db.insert(accounts).values({ id: accountId, name: `corr-${accountId.slice(0, 8)}` });
      const [mb] = await db.insert(mailboxes).values({
        accountId, provider: "imap", address: me, status: "connected", createdAt: CONNECT,
      }).returning();
      const sent = opts.sent ?? "Sent";
      await db.insert(mailboxFolders).values({ mailboxId: mb!.id, folder: sent, uidvalidity: 7n, uidnext: 100n });
      await db.insert(accountSettings).values({
        accountId, screeningScope: "all_time",
        ...(opts.seedAt ? { seedConfirmedAt: opts.seedAt } : {}),
      });
      return { accountId, mailboxId: mb!.id, me, sent };
    }

    let uid = 1;
    /**
     * One of the account's own Sent copies, in the Sent folder, as ingest stores one. `toAddresses`
     * stores the column verbatim — `[]`, or a group's empty address — while `headers` may still name
     * somebody: the predicate reads the column, never the header.
     */
    async function sentCopy(w: World, o: {
      to: string | readonly string[]; cc?: readonly string[]; at: Date; messageId: string; machine?: boolean;
      toAddresses?: Array<{ name: string | null; address: string }>; headers?: Record<string, string[]>;
    }): Promise<string> {
      const [m] = await db.insert(messages).values({
        accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: `sent:${randomUUID()}`,
        subject: "the north elevation", fromAddress: w.me, messageIdHeader: o.messageId,
        date: o.at, arrivedAt: o.at,
        toAddresses: o.toAddresses ?? [o.to].flat().map((address) => ({ name: null, address })),
        ccAddresses: (o.cc ?? []).map((address) => ({ name: null, address })),
        nativeLocator: { folder: w.sent, ref: `7:${uid}` },
      }).returning();
      await db.insert(messageInstances).values({
        accountId: w.accountId, mailboxId: w.mailboxId, messageId: m!.id, folder: w.sent,
        uidvalidity: 7n, uid: uid++, isPrimary: true,
      });
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: w.sent, observedFolder: w.sent, lastSetBy: "us",
        reconcileStatus: "reconciled", conflict: false,
      });
      await db.insert(messageBodies).values({
        messageId: m!.id, text: "Thursday?",
        headers: { ...(o.machine ? { "auto-submitted": ["auto-replied"] } : {}), ...(o.headers ?? {}) },
      });
      return m!.id;
    }

    /**
     * One message held at the gate from `from`, optionally naming a message id it answers; its sender
     * confirmed by the provider (`pass`), as a Gmail-held mailbox's would be.
     */
    async function held(w: World, from: string, inReplyTo?: string): Promise<string> {
      const [m] = await db.insert(messages).values({
        accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: `held:${randomUUID()}`,
        subject: "Re: the north elevation", fromAddress: from, date: WROTE, authVerdict: "pass",
        nativeLocator: { folder: SCREENER, ref: `9:${uid++}` },
      }).returning();
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER, lastSetBy: "us",
        reconcileStatus: "reconciled", conflict: false,
      });
      await db.insert(messageBodies).values({
        messageId: m!.id, text: "Thursday works.",
        headers: inReplyTo ? { "in-reply-to": [`<${inReplyTo}>`] } : {},
      });
      return m!.id;
    }

    async function suggest(w: World, messageId: string, destination: string, confidence: number): Promise<void> {
      await db.insert(routingDecisions).values({
        accountId: w.accountId, messageId, inputProvenance: SCREENER_SUGGESTION_PROVENANCE,
        destination, confidence, rationale: "", spam: destination === SPAM, status: SCREENER_SUGGESTION_STATUS,
      });
    }

    const desiredOf = async (id: string): Promise<string> =>
      (await db.select().from(folderState).where(eq(folderState.messageId, id)).limit(1))[0]!.desiredFolder;
    const known = async (w: World): Promise<Set<string>> =>
      new Set((await db.select({ a: contacts.address }).from(contacts).where(eq(contacts.accountId, w.accountId))).map((r) => r.a));
    const logger = (): Logger & { lines: Array<{ event: string; fields: Record<string, unknown> }> } => {
      const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
      const put = (event: string, fields?: Record<string, unknown>) => { lines.push({ event, fields: fields ?? {} }); };
      return { lines, info: put, warn: put, error: put, debug: put } as never;
    };

    it("the predicate: written to after the consent point, or answering such a copy — and nobody else", async () => {
      const w = await newWorld({ seedAt: new Date("2026-09-10T00:00:00.000Z") });
      await sentCopy(w, { to: "wrote@corr.invalid", at: WROTE, messageId: "s-1@own.invalid" });
      await sentCopy(w, { to: "list@corr.invalid", at: WROTE, messageId: "s-2@own.invalid" });
      await sentCopy(w, { to: "history@corr.invalid", at: HISTORY, messageId: "s-3@own.invalid" });
      await sentCopy(w, { to: "seeded@corr.invalid", at: new Date("2026-09-05T00:00:00.000Z"), messageId: "s-4@own.invalid" });
      await sentCopy(w, { to: "ooo@corr.invalid", at: WROTE, messageId: "s-5@own.invalid", machine: true });
      await sentCopy(w, { to: "answerer@corr.invalid", at: WROTE, messageId: "s-15@own.invalid" });
      await held(w, "replier@corr.invalid", "s-2@own.invalid");
      await held(w, "answerer@corr.invalid", "s-15@own.invalid");
      await held(w, "late@corr.invalid", "s-3@own.invalid");
      await held(w, "auto@corr.invalid", "s-5@own.invalid");

      const found = await correspondentsAmong(db, {
        accountId: w.accountId, references: "held",
        senders: ["wrote@corr.invalid", "replier@corr.invalid", "answerer@corr.invalid", "history@corr.invalid",
          "late@corr.invalid", "seeded@corr.invalid", "ooo@corr.invalid", "auto@corr.invalid", "nobody@stranger.invalid"],
      });
      expect(found.get("wrote@corr.invalid")).toMatchObject({ via: "wrote", named: true });
      expect(found.get("wrote@corr.invalid")!.sentAt.getTime()).toBe(WROTE.getTime());
      expect(found.get("answerer@corr.invalid"), "answering mail this account sent TO THEM").toMatchObject({ via: "replied", named: true });
      // The archive shape: a copy written to a list is cited by everybody who reads the list. They
      // answer mail this account sent, so they are a correspondent for that message, never taught.
      expect(found.get("replier@corr.invalid"), "citing a copy written to somebody else").toMatchObject({ via: "replied", named: false });
      expect(found.has("auto@corr.invalid"), "an answer to an automatic reply answers no writing").toBe(false);
      expect(found.has("history@corr.invalid"), "before the connect is the seed's question").toBe(false);
      expect(found.has("late@corr.invalid"), "a reply to history is history").toBe(false);
      expect(found.has("seeded@corr.invalid"), "before the seed's answer is the seed's question").toBe(false);
      expect(found.has("ooo@corr.invalid"), "an automatic reply is not writing").toBe(false);
      expect(found.has("nobody@stranger.invalid")).toBe(false);
    });

    it("the reply arm reads 70,000 ids in statements of 1,000, and the answer in the last one is found", async () => {
      // No statement grows with what senders wrote: hundreds of senders naming 100 ids each, and the one id
      // that answers this account's Sent copy is the last of the last sender, so the last statement.
      const w = await newWorld();
      await sentCopy(w, { to: "p699@flood.invalid", at: WROTE, messageId: "s-flood@own.invalid" });
      const references = new Map<string, string[]>();
      for (let n = 0; n < 700; n++) {
        references.set(`p${n}@flood.invalid`, Array.from({ length: 100 }, (_, i) => `f${n}-${i}@flood.invalid`));
      }
      references.get("p699@flood.invalid")![99] = "s-flood@own.invalid";
      // A sender the copy was NOT written to cites it too, in the same last statement.
      references.get("p698@flood.invalid")![99] = "s-flood@own.invalid";
      const found = await correspondentsAmong(db, {
        accountId: w.accountId, senders: [...references.keys()], references, arms: "reply",
      });
      expect([...found.keys()].sort()).toEqual(["p698@flood.invalid", "p699@flood.invalid"]);
      expect(found.get("p699@flood.invalid")).toMatchObject({ via: "replied", named: true });
      expect(found.get("p698@flood.invalid")).toMatchObject({ via: "replied", named: false });
    });

    it("a caller's list for one sender is read to the bound, in the caller's order", async () => {
      const w = await newWorld();
      await sentCopy(w, { to: ["near@belt.invalid", "far@belt.invalid"], at: WROTE, messageId: "s-belt@own.invalid" });
      const list = (at: number) => Array.from({ length: 150 }, (_, i) => i === at ? "s-belt@own.invalid" : `b${at}-${i}@belt.invalid`);
      const references = new Map([
        ["near@belt.invalid", list(50)], ["far@belt.invalid", list(120)],
        // Inside the bound, but the copy was not written to them.
        ["unnamed@belt.invalid", list(10)],
      ]);
      const found = await correspondentsAmong(db, {
        accountId: w.accountId, senders: [...references.keys()], references, arms: "reply",
      });
      expect([...found.keys()].sort()).toEqual(["near@belt.invalid", "unnamed@belt.invalid"]);
      expect(found.get("near@belt.invalid")).toMatchObject({ named: true });
      expect(found.get("unnamed@belt.invalid")).toMatchObject({ named: false });
    });

    it("a held message naming 70,000 ids is read to the bound: In-Reply-To and the root still answer", async () => {
      const w = await newWorld();
      for (const id of ["irt", "root", "middle"]) {
        await sentCopy(w, { to: `${id}@flood.invalid`, at: WROTE, messageId: `s-${id}@own.invalid` });
      }
      const flood = Array.from({ length: 70_000 }, (_, i) => `<g${i}@flood.invalid>`);
      const heldWith = async (from: string, headers: Record<string, string[]>): Promise<void> => {
        const [m] = await db.insert(messages).values({
          accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: `held:${randomUUID()}`,
          subject: "Re: the north elevation", fromAddress: from, date: WROTE,
          nativeLocator: { folder: SCREENER, ref: `9:${uid++}` },
        }).returning();
        await db.insert(folderState).values({
          messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER, lastSetBy: "us",
          reconcileStatus: "reconciled", conflict: false,
        });
        await db.insert(messageBodies).values({ messageId: m!.id, text: "Thursday works.", headers });
      };
      await heldWith("irt@flood.invalid", { "in-reply-to": ["<s-irt@own.invalid>"], references: [flood.join(" ")] });
      await heldWith("root@flood.invalid", { references: [["<s-root@own.invalid>", ...flood].join(" ")] });
      const middle = [...flood];
      middle[35_000] = "<s-middle@own.invalid>";
      await heldWith("middle@flood.invalid", { references: [middle.join(" ")] });
      await heldWith("other@flood.invalid", { "in-reply-to": ["<s-irt@own.invalid>"] });
      // The reply arm alone: the copies are written to these senders, so the scan would find them.
      const found = await correspondentsAmong(db, {
        accountId: w.accountId, references: "held", arms: "reply",
        senders: ["irt@flood.invalid", "root@flood.invalid", "middle@flood.invalid", "other@flood.invalid"],
      });
      expect(found.get("irt@flood.invalid")).toMatchObject({ via: "replied" });
      expect(found.get("root@flood.invalid")).toMatchObject({ via: "replied" });
      expect(found.has("middle@flood.invalid"), "an id 35,000 back is past the bound").toBe(false);
      expect(found.get("other@flood.invalid"), "citing a copy written to somebody else").toMatchObject({ named: false });
    });

    it("with no seed answered, the connect alone is the consent point", async () => {
      const w = await newWorld();
      await sentCopy(w, { to: "before@corr.invalid", at: HISTORY, messageId: "s-11@own.invalid" });
      await sentCopy(w, { to: "after@corr.invalid", at: new Date("2026-09-05T00:00:00.000Z"), messageId: "s-12@own.invalid" });
      const found = await correspondentsAmong(db, {
        accountId: w.accountId, senders: ["before@corr.invalid", "after@corr.invalid"],
      });
      expect(found.has("before@corr.invalid"), "written before this mailbox was connected").toBe(false);
      expect(found.has("after@corr.invalid"), "written after it, and no seed to ask").toBe(true);
    });

    it("a Sent folder the server names in its own words is own writing once the attach wrote it down", async () => {
      const w = await newWorld({ sent: NAMED_SENT });
      await sentCopy(w, { to: "named@corr.invalid", cc: ["answered@corr.invalid"], at: WROTE, messageId: "s-13@own.invalid" });
      await held(w, "answered@corr.invalid", "s-13@own.invalid");
      await held(w, "unnamed@corr.invalid", "s-13@own.invalid");
      const ask = () => correspondentsAmong(db, {
        accountId: w.accountId, references: "held",
        senders: ["named@corr.invalid", "answered@corr.invalid", "unnamed@corr.invalid"],
      });
      expect((await ask()).size, "CONTROL: a folder nothing names Sent is not own writing").toBe(0);

      // The attach's write: the special folders, the Sent path beside Junk and Trash.
      await makeDrizzleRepo(db as never).setMailboxSpecialFolders(w.mailboxId, {
        junkFolder: null, trashFolder: null, sentFolder: NAMED_SENT,
      });
      const found = await ask();
      expect(found.get("named@corr.invalid"), "written to from the named Sent folder").toMatchObject({ via: "wrote" });
      expect(found.get("answered@corr.invalid"), "answering a copy in it").toMatchObject({ via: "replied", named: true });
      expect(found.get("unnamed@corr.invalid"), "citing it, never written to").toMatchObject({ via: "replied", named: false });
    });

    it("a sender citing a copy written to them and a newer one written to somebody else is named", async () => {
      const w = await newWorld();
      await sentCopy(w, { to: "both@corr.invalid", at: new Date("2026-09-21T15:12:00.000Z"), messageId: "s-older@own.invalid" });
      await sentCopy(w, { to: "someone@corr.invalid", at: WROTE, messageId: "s-newer@own.invalid" });
      const found = await correspondentsAmong(db, {
        accountId: w.accountId, senders: ["both@corr.invalid"], arms: "reply",
        references: new Map([["both@corr.invalid", ["s-newer@own.invalid", "s-older@own.invalid"]]]),
      });
      expect(found.get("both@corr.invalid"), "a named reading outranks a newer unnamed one").toMatchObject({ named: true });
    });

    it("CONTROL: a reply from the copy's Cc answers mail written to them", async () => {
      const w = await newWorld();
      await sentCopy(w, { to: "to@corr.invalid", cc: ["cc@corr.invalid"], at: WROTE, messageId: "s-cc@own.invalid" });
      await held(w, "cc@corr.invalid", "s-cc@own.invalid");
      const found = await correspondentsAmong(db, {
        accountId: w.accountId, references: "held", arms: "reply", senders: ["cc@corr.invalid"],
      });
      expect(found.get("cc@corr.invalid")).toMatchObject({ via: "replied", named: true });
      expect(found.get("cc@corr.invalid")!.sentAt.getTime()).toBe(WROTE.getTime());
    });

    it("a copy whose recipients were stored empty names nobody: its citers are never named, its headers never read", async () => {
      const w = await newWorld();
      // A row from before the recipient columns were written, and a group's empty address.
      await sentCopy(w, {
        to: [], toAddresses: [], at: WROTE, messageId: "s-empty@own.invalid",
        headers: { to: ["citer@corr.invalid"] },
      });
      await sentCopy(w, {
        to: [], toAddresses: [{ name: "undisclosed-recipients", address: "" }], at: WROTE,
        messageId: "s-group@own.invalid", headers: { to: ["undisclosed-recipients:;, grouped@corr.invalid"] },
      });
      await held(w, "citer@corr.invalid", "s-empty@own.invalid");
      await held(w, "grouped@corr.invalid", "s-group@own.invalid");
      const found = await correspondentsAmong(db, {
        accountId: w.accountId, references: "held", arms: "reply",
        senders: ["citer@corr.invalid", "grouped@corr.invalid"],
      });
      // They answer mail this account sent, so each is a correspondent for that message; an unknown
      // recipient list never makes one NAMED, which is what teaches a contact.
      expect(found.get("citer@corr.invalid")).toMatchObject({ via: "replied", named: false });
      expect(found.get("grouped@corr.invalid")).toMatchObject({ via: "replied", named: false });
    });

    it("a held row that FAILED authentication is never the one whose references answer", async () => {
      const w = await newWorld();
      await sentCopy(w, { to: "forged@corr.invalid", at: WROTE, messageId: "s-auth@own.invalid" });
      const id = await held(w, "forged@corr.invalid", "s-auth@own.invalid");
      await db.update(messages).set({ authVerdict: "fail" }).where(eq(messages.id, id));
      const found = await correspondentsAmong(db, {
        accountId: w.accountId, references: "held", arms: "reply", senders: ["forged@corr.invalid"],
      });
      expect(found.has("forged@corr.invalid"), "the provider said this mail is not theirs").toBe(false);
    });

    it("CONTROL: the same held row with the provider's pass answers", async () => {
      const w = await newWorld();
      await sentCopy(w, { to: "genuine@corr.invalid", at: WROTE, messageId: "s-pass@own.invalid" });
      const id = await held(w, "genuine@corr.invalid", "s-pass@own.invalid");
      await db.update(messages).set({ authVerdict: "pass" }).where(eq(messages.id, id));
      const found = await correspondentsAmong(db, {
        accountId: w.accountId, references: "held", arms: "reply", senders: ["genuine@corr.invalid"],
      });
      expect(found.get("genuine@corr.invalid")).toMatchObject({ via: "replied" });
    });

    it("the attach writes the Sent path the scan watches beside Junk and Trash, on both arms", async () => {
      const columns = async (caps: Partial<ImapCapabilities>) => {
        const w = await newWorld();
        const adapter = {
          findSpecialFolders: async () => ({ junk: "Junk", trash: "Trash" }),
          capabilities: async () => ({ ...caps }) as ImapCapabilities,
        };
        expect(await recordSpecialFolders(adapter, makeDrizzleRepo(db as never), w.mailboxId)).toBe(true);
        const [row] = await db.select({ junk: mailboxes.junkFolder, trash: mailboxes.trashFolder, sent: mailboxes.sentFolder })
          .from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
        return row;
      };
      // No SPECIAL-USE: the Sent the scan resolved by name lives only in `watchedSentFolder`.
      expect(await columns({ sentFolder: null, watchedSentFolder: NAMED_SENT }))
        .toEqual({ junk: "Junk", trash: "Trash", sent: NAMED_SENT });
      expect(await columns({ sentFolder: NAMED_SENT }), "an adapter naming no watch path").toMatchObject({ sent: NAMED_SENT });
      expect(await columns({ sentFolder: null }), "none resolved").toMatchObject({ sent: null });
    });

    it.skipIf(!opts.act)("ACCEPTANCE: auto-act ON and a 0.99 Spam suggestion — the correspondent is NOT filed, the stranger is", async () => {
      const w = await newWorld();
      await sentCopy(w, { to: "friend@corr.invalid", at: WROTE, messageId: "s-6@own.invalid" });
      const theirs = await held(w, "friend@corr.invalid", "s-6@own.invalid");
      const strangers = await held(w, "stranger@spam.invalid");
      await suggest(w, theirs, SPAM, 0.99);
      await suggest(w, strangers, SPAM, 0.99);

      const log = logger();
      const r = await screenerAutoActPass(db, {
        accountId: w.accountId, log, consent: { stillGiven: async () => true },
      });
      expect(await desiredOf(theirs), "the model's 0.99 outranked having written to them").toBe(SCREENER);
      expect(await desiredOf(strangers), "CONTROL: a stranger's confident Spam is filed").toBe(SPAM);
      expect(r).toMatchObject({ filed: 1, correspondents: 1 });
      const line = log.lines.find((l) => l.event === "screener_auto_act_correspondent");
      expect(line?.fields.reason).toContain("this account wrote to them");
    });

    it.skipIf(!opts.act)("ACCEPTANCE: suggestions on — nothing is bought about a correspondent, a stranger is asked", async () => {
      const w = await newWorld();
      await db.update(accountSettings).set({ autoSuggestAt: CONNECT }).where(eq(accountSettings.accountId, w.accountId));
      await sentCopy(w, { to: "friend@corr.invalid", at: WROTE, messageId: "s-10@own.invalid" });
      await held(w, "friend@corr.invalid", "s-10@own.invalid");
      await held(w, "stranger@spam.invalid");
      const asked: string[] = [];
      const answer = async (i: ClassifierInput): Promise<ClassifierResult> => {
        asked.push(i.from.address);
        return { destination: SPAM, confidence: 0.99, rationale: "spam", spam: true };
      };
      const classifier = { classify: answer, screen: answer } as unknown as ClassifierPort;
      const log = logger();
      await screenerAutoSuggestPass(db, { accountId: w.accountId, classifier, unmetered: true, log });
      expect(asked, "the classifier port saw the stranger and nobody else").toEqual(["stranger@spam.invalid"]);
      expect(log.lines.some((l) => l.event === "screener_auto_suggest_correspondent")).toBe(true);
    });

    /* AN ANSWER FROM AN ADDRESS THE COPY DOES NOT NAME is a correspondent for the message that cites
       it (owner ruling 2026-10-08): the act and the suggestions read the sender's newest held message,
       the one the Screener shows, and while that one answers mail this account sent, neither files
       nor prices the sender. */
    it.skipIf(!opts.act)("the act does not file an answer from an address the copy does not name", async () => {
      const w = await newWorld();
      await sentCopy(w, { to: "friend@corr.invalid", at: WROTE, messageId: "s-16@own.invalid" });
      const assistants = await held(w, "assistant@else.invalid", "s-16@own.invalid");
      const strangers = await held(w, "stranger@spam.invalid");
      await suggest(w, assistants, SPAM, 0.99);
      await suggest(w, strangers, SPAM, 0.99);
      const r = await screenerAutoActPass(db, {
        accountId: w.accountId, log: logger(), consent: { stillGiven: async () => true },
      });
      expect(await desiredOf(assistants), "the model's 0.99 does not file an answer to this account's mail").toBe(SCREENER);
      expect(await desiredOf(strangers), "CONTROL: a stranger's confident Spam is filed").toBe(SPAM);
      expect(r).toMatchObject({ filed: 1, correspondents: 1 });
    });

    it.skipIf(!opts.act)("the act keeps a sender whose OLDER held message answers this account's mail", async () => {
      // Held before the copy was synced, then a newer message citing nothing: the act decides about
      // the sender and all their held mail, so any held answer keeps its hands off them.
      const w = await newWorld();
      await sentCopy(w, { to: "friend@corr.invalid", at: WROTE, messageId: "s-18@own.invalid" });
      const answer = await held(w, "assistant@else.invalid", "s-18@own.invalid");
      const newer = await held(w, "assistant@else.invalid");
      await db.update(messages).set({ date: new Date("2026-09-21T09:00:00.000Z") }).where(eq(messages.id, answer));
      await db.update(messages).set({ date: new Date("2026-09-23T09:00:00.000Z") }).where(eq(messages.id, newer));
      const strangers = await held(w, "stranger@spam.invalid");
      await suggest(w, newer, SPAM, 0.99);
      await suggest(w, strangers, SPAM, 0.99);
      const r = await screenerAutoActPass(db, {
        accountId: w.accountId, log: logger(), consent: { stillGiven: async () => true },
      });
      expect(await desiredOf(answer), "the answer is not filed with the sender").toBe(SCREENER);
      expect(await desiredOf(newer)).toBe(SCREENER);
      expect(await desiredOf(strangers), "CONTROL: a stranger's confident Spam is filed").toBe(SPAM);
      expect(r).toMatchObject({ filed: 1, correspondents: 1 });
    });

    it.skipIf(!opts.act)("a flood of held mail from one address buries no other sender's older answer", async () => {
      const w = await newWorld();
      await sentCopy(w, { to: "friend@corr.invalid", at: WROTE, messageId: "s-20@own.invalid" });
      const answer = await held(w, "assistant@else.invalid", "s-20@own.invalid");
      const newer = await held(w, "assistant@else.invalid");
      await db.update(messages).set({ date: new Date("2026-09-21T09:00:00.000Z") }).where(eq(messages.id, answer));
      await db.update(messages).set({ date: new Date("2026-09-23T09:00:00.000Z") }).where(eq(messages.id, newer));
      // More held mail from one address than the read takes per sender, all of it newer.
      for (let i = 0; i < 25; i++) {
        const id = await held(w, "flood@spam.invalid");
        await db.update(messages).set({ date: new Date(Date.UTC(2026, 8, 24, 9, i)) }).where(eq(messages.id, id));
      }
      await suggest(w, newer, SPAM, 0.99);
      const r = await screenerAutoActPass(db, {
        accountId: w.accountId, log: logger(), consent: { stillGiven: async () => true },
      });
      expect(await desiredOf(answer), "the flood does not bury the answer").toBe(SCREENER);
      expect(await desiredOf(newer)).toBe(SCREENER);
      expect(r).toMatchObject({ filed: 0, correspondents: 1 });
    });

    it.skipIf(!opts.act)("CONTROL: an older held answer that FAILED authentication does not keep the act off", async () => {
      const w = await newWorld();
      await sentCopy(w, { to: "friend@corr.invalid", at: WROTE, messageId: "s-19@own.invalid" });
      const forged = await held(w, "assistant@else.invalid", "s-19@own.invalid");
      const newer = await held(w, "assistant@else.invalid");
      await db.update(messages).set({ authVerdict: "fail", date: new Date("2026-09-21T09:00:00.000Z") })
        .where(eq(messages.id, forged));
      await db.update(messages).set({ date: new Date("2026-09-23T09:00:00.000Z") }).where(eq(messages.id, newer));
      await suggest(w, newer, SPAM, 0.99);
      const pass = () => screenerAutoActPass(db, {
        accountId: w.accountId, log: logger(), consent: { stillGiven: async () => true },
      });
      // The act acts: a deny that meets a letter its provider did not confirm files that letter
      // alone first and writes no rule; with every held letter confirmed, the next pass files the sender.
      expect(await pass()).toMatchObject({ filed: 0, correspondents: 0, unconfirmedDenies: 1 });
      expect(await desiredOf(forged)).toBe(SPAM);
      expect(await desiredOf(newer)).toBe(SCREENER);
      const r = await pass();
      expect(await desiredOf(newer), "the provider said the answer is not theirs").toBe(SPAM);
      expect(r).toMatchObject({ filed: 1, correspondents: 0 });
    });

    it.skipIf(!opts.act)("no advice is bought about an answer from an address the copy does not name", async () => {
      const w = await newWorld();
      await db.update(accountSettings).set({ autoSuggestAt: CONNECT }).where(eq(accountSettings.accountId, w.accountId));
      await sentCopy(w, { to: "friend@corr.invalid", at: WROTE, messageId: "s-17@own.invalid" });
      await held(w, "assistant@else.invalid", "s-17@own.invalid");
      await held(w, "stranger@spam.invalid");
      const asked: string[] = [];
      const answer = async (i: ClassifierInput): Promise<ClassifierResult> => {
        asked.push(i.from.address);
        return { destination: SPAM, confidence: 0.99, rationale: "spam", spam: true };
      };
      const classifier = { classify: answer, screen: answer } as unknown as ClassifierPort;
      await screenerAutoSuggestPass(db, { accountId: w.accountId, classifier, unmetered: true, log: logger() });
      expect(asked, "the classifier port saw the stranger and nobody else").toEqual(["stranger@spam.invalid"]);
    });

    /* AN ANSWER FROM AN ADDRESS THE COPY DOES NOT NAME, UNDER A COMPANY'S NAME, is no correspondent
       anywhere, as the gate and the retro already read it: the act keeps it for the claim, never as
       somebody the account wrote to, and the suggestions ask about it. */
    const claim = async (id: string, checked = true): Promise<void> => {
      await db.update(messages).set({ fromName: "PayPal", ...(checked ? { senderCheck: "impersonation", senderCheckBrand: "PayPal" } : {}) })
        .where(eq(messages.id, id));
    };
    const act = (w: World) => screenerAutoActPass(db, {
      accountId: w.accountId, log: logger(), consent: { stillGiven: async () => true },
    });

    it.skipIf(!opts.act)("the act keeps such an answer for its claim, not as a correspondent", async () => {
      const w = await newWorld();
      await sentCopy(w, { to: "friend@corr.invalid", at: WROTE, messageId: "s-21@own.invalid" });
      const answer = await held(w, "assistant@else.invalid", "s-21@own.invalid");
      await claim(answer);
      await suggest(w, answer, "INBOX", 0.99);
      const r = await act(w);
      expect(await desiredOf(answer)).toBe(SCREENER);
      expect(r).toMatchObject({ correspondents: 0, identity: 1 });
    });

    it.skipIf(!opts.act)("an OLDER held answer under a company's name keeps no act off its sender", async () => {
      const w = await newWorld();
      await sentCopy(w, { to: "friend@corr.invalid", at: WROTE, messageId: "s-22@own.invalid" });
      const answer = await held(w, "assistant@else.invalid", "s-22@own.invalid");
      const newer = await held(w, "assistant@else.invalid");
      await claim(answer);
      await db.update(messages).set({ date: new Date("2026-09-21T09:00:00.000Z") }).where(eq(messages.id, answer));
      await db.update(messages).set({ date: new Date("2026-09-23T09:00:00.000Z") }).where(eq(messages.id, newer));
      await suggest(w, newer, SPAM, 0.99);
      const r = await act(w);
      expect(await desiredOf(newer), "a confident Spam over a claimant is filed").toBe(SPAM);
      expect(r).toMatchObject({ filed: 1, correspondents: 0 });
    });

    it.skipIf(!opts.act)("a held answer the backfill has not checked yet is checked before the act asks who it is", async () => {
      const w = await newWorld();
      await sentCopy(w, { to: "friend@corr.invalid", at: WROTE, messageId: "s-23@own.invalid" });
      const answer = await held(w, "assistant@else.invalid", "s-23@own.invalid");
      await claim(answer, false);
      await suggest(w, answer, "INBOX", 0.99);
      const r = await act(w);
      expect(await desiredOf(answer)).toBe(SCREENER);
      expect(r).toMatchObject({ correspondents: 0, identity: 1 });
      const [row] = await db.select({ check: messages.senderCheck }).from(messages).where(eq(messages.id, answer));
      expect(row!.check).toBe("impersonation");
    });

    it.skipIf(!opts.act)("advice IS bought about such an answer under a company's name", async () => {
      const w = await newWorld();
      await db.update(accountSettings).set({ autoSuggestAt: CONNECT }).where(eq(accountSettings.accountId, w.accountId));
      await sentCopy(w, { to: "friend@corr.invalid", at: WROTE, messageId: "s-24@own.invalid" });
      await claim(await held(w, "assistant@else.invalid", "s-24@own.invalid"));
      const asked: string[] = [];
      const answer = async (i: ClassifierInput): Promise<ClassifierResult> => {
        asked.push(i.from.address);
        return { destination: SPAM, confidence: 0.99, rationale: "spam", spam: true };
      };
      const classifier = { classify: answer, screen: answer } as unknown as ClassifierPort;
      await screenerAutoSuggestPass(db, { accountId: w.accountId, classifier, unmetered: true, log: logger() });
      expect(asked).toEqual(["assistant@else.invalid"]);
    });

    it("ACCEPTANCE: the retro releases a held correspondent once, teaches contacts, and leaves a stranger", async () => {
      const w = await newWorld();
      await sentCopy(w, { to: "friend@corr.invalid", at: WROTE, messageId: "s-7@own.invalid" });
      const theirs = await held(w, "friend@corr.invalid");
      const strangers = await held(w, "stranger@spam.invalid");

      const first = await screenerCorrespondentRetroPass(db, { accountId: w.accountId });
      expect(await desiredOf(theirs)).toBe("INBOX");
      expect(await desiredOf(strangers), "CONTROL: a stranger stays at the gate").toBe(SCREENER);
      expect(first).toMatchObject({ released: 1 });
      expect((await known(w)).has("friend@corr.invalid")).toBe(true);
      const audits = await db.select().from(auditLog).where(and(
        eq(auditLog.accountId, w.accountId), eq(auditLog.action, "screener.correspondent_admitted")));
      expect(audits).toHaveLength(1);
      expect(audits[0]!.inverse).toMatchObject({ messageId: theirs, to: SCREENER });

      const second = await screenerCorrespondentRetroPass(db, { accountId: w.accountId });
      expect(second, "once: a released sender leaves the candidates").toMatchObject({ released: 0, learned: 0 });
    });

    it("the retro retires the auto-act's own spam rule over a correspondent — never the person's", async () => {
      const w = await newWorld();
      await sentCopy(w, { to: "friend@corr.invalid", at: WROTE, messageId: "s-8@own.invalid" });
      await sentCopy(w, { to: "chosen@corr.invalid", at: WROTE, messageId: "s-9@own.invalid" });
      const rule = async (match: string) => (await db.insert(rules).values({
        accountId: w.accountId, kind: "sender", match, destination: SPAM, provenance: "promoted", enabled: true,
      }).returning())[0]!.id;
      const byAct = await rule("friend@corr.invalid");
      const byPerson = await rule("chosen@corr.invalid");
      await db.insert(learningSignals).values([
        { accountId: w.accountId, triggeringActionId: `screener:auto:${randomUUID()}`, kind: "screener",
          senderAddress: "friend@corr.invalid", destination: SPAM, label: "positive" },
        // The act filed them once AND the person pressed Spam on them themselves: the rule is theirs.
        { accountId: w.accountId, triggeringActionId: `screener:auto:${randomUUID()}`, kind: "screener",
          senderAddress: "chosen@corr.invalid", destination: SPAM, label: "positive" },
        { accountId: w.accountId, triggeringActionId: `screener:${randomUUID()}`, kind: "screener",
          senderAddress: "chosen@corr.invalid", destination: SPAM, label: "positive" },
      ]);

      const r = await screenerCorrespondentRetroPass(db, { accountId: w.accountId });
      const enabled = async (id: string) =>
        (await db.select({ e: rules.enabled }).from(rules).where(eq(rules.id, id)))[0]!.e;
      expect(await enabled(byAct), "the act's own verdict over somebody this account wrote to").toBe(false);
      expect(await enabled(byPerson), "CONTROL: a rule the person pressed is theirs").toBe(true);
      expect(r.retired).toBe(1);
    });

    it("the retro keys a padded rule as the router does: spaces name the correspondent, a tab nobody", async () => {
      const w = await newWorld();
      await sentCopy(w, { to: "friend@corr.invalid", at: WROTE, messageId: "s-14@own.invalid" });
      // The act's own record carries the rule's spelling: the candidate read compares the two as stored.
      const rule = async (match: string) => {
        await db.insert(learningSignals).values({
          accountId: w.accountId, triggeringActionId: `screener:auto:${randomUUID()}`, kind: "screener",
          senderAddress: match, destination: SPAM, label: "positive",
        });
        return (await db.insert(rules).values({
          accountId: w.accountId, kind: "sender", match, destination: SPAM, provenance: "promoted", enabled: true,
        }).returning())[0]!.id;
      };
      const spaced = await rule("  friend@corr.invalid ");
      const tabbed = await rule("\tfriend@corr.invalid");
      await screenerCorrespondentRetroPass(db, { accountId: w.accountId });
      const enabled = async (id: string) =>
        (await db.select({ e: rules.enabled }).from(rules).where(eq(rules.id, id)))[0]!.e;
      expect(await enabled(spaced), "CONTROL: a space-padded act rule over a correspondent retires").toBe(false);
      expect(await enabled(tabbed), "a tab-padded rule names nobody, so nothing is retired for it").toBe(true);
    });
  });
}
