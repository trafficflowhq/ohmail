import { describe, it, expect } from "vitest";
import { planChange, commitChange, UNMETERED_STORAGE_CAP, type PlanDeps } from "../src/pipeline.js";
import { FakeRepo, FakeRouting } from "./fakes.js";
import type { Change } from "../src/ports.js";
import type { ClassifierPort, ClassifierInput, ClassifierResult } from "../src/ai/classify.js";
import type { Rule } from "../src/rules.js";

/**
 * A CORRESPONDENT IS NEVER FIRST CONTACT (owner defect, 2026-09-23): the account wrote to a
 * person, their reply was held as a stranger and a bought Spam verdict filed it. Two arms reach
 * ingest: the reply arm (their In-Reply-To names a Sent copy this account wrote) and the Sent
 * copy's own ingest teaching its recipients, so a later message with no reference is known. Both
 * only past the consent point. An answer from an address the copy does not name arrives and is not
 * remembered (owner ruling 2026-10-08). Every sender here is `.invalid`.
 */

const ME = "me@own.invalid";
const THEM = "them@corr.invalid";
const STRANGER = "someone@stranger.invalid";
const CUT = new Date("2026-09-01T00:00:00.000Z");
const AFTER = new Date("2026-09-22T15:12:00.000Z");
const BEFORE = new Date("2026-08-20T10:00:00.000Z");

function eml(o: {
  from: string; to: string; cc?: string; messageId: string; inReplyTo?: string;
  subject?: string; extra?: string[];
}): Buffer {
  return Buffer.from([
    `Message-ID: <${o.messageId}>`,
    `From: ${o.from}`,
    `To: ${o.to}`,
    ...(o.cc ? [`Cc: ${o.cc}`] : []),
    `Subject: ${o.subject ?? "the north elevation"}`,
    ...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}>`] : []),
    ...(o.extra ?? []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Thursday works for me.",
  ].join("\r\n"));
}

const sent = (raw: Buffer, at: Date, ref = "1:10"): Change =>
  ({ type: "create", locator: { folder: "Sent", ref }, raw, seen: true, ownAuthored: true, internalDate: at });
const inbox = (raw: Buffer, ref = "1:20"): Change =>
  ({ type: "create", locator: { folder: "INBOX", ref }, raw, seen: false, internalDate: AFTER });

/** A classifier that counts: the admission is asked BEFORE any AI question. */
class CountingClassifier implements ClassifierPort {
  calls = 0;
  async classify(_i: ClassifierInput): Promise<ClassifierResult> {
    this.calls++;
    return { destination: "ohmail/Quarantine", confidence: 0.99, rationale: "looks like spam", spam: true };
  }
}

function setup() {
  const repo = new FakeRepo();
  repo.correspondenceSince = CUT;
  const classifier = new CountingClassifier();
  const routing = new FakeRouting();
  return { repo, classifier, routing };
}

async function ingest(
  s: ReturnType<typeof setup>, change: Change, extra: Partial<PlanDeps> = {},
) {
  const plan = await planChange(change, {
    repo: s.repo, accountId: "acct-1", mailboxId: "mb-1", readerMode: false,
    classifier: s.classifier, routing: s.routing, ...extra,
  });
  return { plan, res: await commitChange(plan, {
    repo: s.repo, routing: s.routing, accountId: "acct-1", mailboxId: "mb-1",
    storageCap: UNMETERED_STORAGE_CAP,
  }) };
}

describe("the reply arm — their mail answers a message this account sent", () => {
  it("ACCEPTANCE: a reply naming our Sent copy is admitted, never held, never asked about", async () => {
    const s = setup();
    // The Sent copy, ingested WITHOUT a consent point, so it teaches nothing: only the reply arm
    // can admit here, which is what this case isolates.
    await ingest(s, sent(eml({ from: ME, to: THEM, messageId: "sent-1@own.invalid" }), AFTER));
    expect(s.repo.senders.has(THEM)).toBe(false);

    const { plan, res } = await ingest(s, inbox(eml({
      from: THEM, to: ME, messageId: "reply-1@corr.invalid", inReplyTo: "sent-1@own.invalid",
    })));
    expect(plan.new!.desired, "a correspondent is never held at the gate").toBe("INBOX");
    expect(res.action).toEqual({ type: "none" });
    expect(s.classifier.calls, "no suggestion is bought and no AI question asked").toBe(0);
    expect(s.routing.decisions).toHaveLength(0);
    // The admission is recorded with its reason, and the sender is known from here on.
    const audit = s.repo.audits.find((a) => a.action === "screener.correspondent_admitted");
    expect(audit?.payload).toMatchObject({ via: "replied", sentAt: AFTER.toISOString(), named: true });
    expect(s.repo.senders.has(THEM)).toBe(true);
  });

  it("CONTROL: a stranger's mail is held as today, and the question costs one lookup", async () => {
    const s = setup();
    await ingest(s, sent(eml({ from: ME, to: THEM, messageId: "sent-1@own.invalid" }), AFTER));
    const { plan } = await ingest(s, inbox(eml({
      from: STRANGER, to: ME, messageId: "x-1@stranger.invalid", inReplyTo: "nothing-we-sent@own.invalid",
    })));
    expect(plan.new!.desired).toBe("ohmail/Screener");
    expect(s.repo.correspondentCalls).toBe(1);
    expect(s.repo.audits.some((a) => a.action === "screener.correspondent_admitted")).toBe(false);
  });

  it("ACCEPTANCE: an answer from an address the copy does not name arrives, and is not remembered", async () => {
    const s = setup();
    // The copy went to THEM; the answer comes from another address (an assistant, an alias).
    await ingest(s, sent(eml({ from: ME, to: THEM, messageId: "sent-x@own.invalid" }), AFTER));
    const { plan } = await ingest(s, inbox(eml({
      from: STRANGER, to: ME, messageId: "x-9@stranger.invalid", inReplyTo: "sent-x@own.invalid",
    })));
    expect(plan.new!.desired, "an answer to mail this account sent is not first contact").toBe("INBOX");
    expect(plan.new!.correspondentAdmission).toMatchObject({ via: "replied", sentAt: AFTER, named: false });
    expect(s.repo.correspondentCalls).toBe(1);
    const audit = s.repo.audits.find((a) => a.action === "screener.correspondent_admitted");
    expect(audit?.payload).toMatchObject({ via: "replied", named: false });
    expect(s.repo.senders.has(STRANGER), "no contact, person or inferred, from that admission").toBe(false);
  });

  it("CONTROL: an answer from an unnamed address that FAILED authentication is held, and not remembered", async () => {
    const s = setup();
    await ingest(s, sent(eml({ from: ME, to: THEM, messageId: "sent-f@own.invalid" }), AFTER));
    const { plan } = await ingest(s, inbox(eml({
      from: STRANGER, to: ME, messageId: "x-10@stranger.invalid", inReplyTo: "sent-f@own.invalid",
      extra: ["Authentication-Results: mx.google.com; dmarc=fail header.from=stranger.invalid"],
    })), { trustedAuthservIds: new Set(["mx.google.com"]) });
    expect(plan.new!.desired).toBe("ohmail/Screener");
    expect(plan.new!.correspondentAdmission).toBeUndefined();
    expect(s.repo.senders.has(STRANGER)).toBe(false);
  });

  it("CONTROL: a reply from the copy's Cc is admitted — a Cc is somebody you wrote to", async () => {
    const s = setup();
    await ingest(s, sent(eml({ from: ME, to: THEM, cc: "copied@corr.invalid", messageId: "sent-cc@own.invalid" }), AFTER));
    const { plan } = await ingest(s, inbox(eml({
      from: "copied@corr.invalid", to: ME, messageId: "reply-cc@corr.invalid", inReplyTo: "sent-cc@own.invalid",
    })));
    expect(plan.new!.desired).toBe("INBOX");
    expect(plan.new!.correspondentAdmission).toMatchObject({ via: "replied", sentAt: AFTER, named: true });
    expect(s.repo.senders.has("copied@corr.invalid")).toBe(true);
    expect(s.repo.inferredSenders.has("copied@corr.invalid")).toBe(false);
  });

  it("a copy in the Sent folder the server names in its own words counts once the attach wrote it down", async () => {
    const s = setup();
    s.repo.sentFolders.set("mb-1", "Verzonden items");
    await ingest(s, {
      type: "create", locator: { folder: "Verzonden items", ref: "1:12" }, seen: true, ownAuthored: true,
      internalDate: AFTER, raw: eml({ from: ME, to: THEM, messageId: "sent-nl@own.invalid" }),
    });
    const { plan } = await ingest(s, inbox(eml({
      from: THEM, to: ME, messageId: "reply-nl@corr.invalid", inReplyTo: "sent-nl@own.invalid",
    })));
    expect(plan.new!.desired).toBe("INBOX");
    expect(plan.new!.correspondentAdmission).toMatchObject({ via: "replied", named: true });
  });

  it("an answer to our own automatic reply is not an answer to the person's writing", async () => {
    const s = setup();
    s.repo.own.add(ME);
    // The away responder's reply, on its ledger by the id it minted…
    await ingest(s, sent(eml({ from: ME, to: THEM, messageId: "away-1@own.invalid" }), AFTER, "1:13"));
    s.repo.awayReplyMintedIds.add("away-1@own.invalid");
    // …and another client's out-of-office copy, by its own headers.
    await ingest(s, sent(eml({
      from: ME, to: THEM, messageId: "ooo-2@own.invalid", extra: ["Auto-Submitted: auto-replied"],
    }), AFTER, "1:14"));
    for (const [n, cited] of [["1", "away-1@own.invalid"], ["2", "ooo-2@own.invalid"]] as const) {
      const { plan } = await ingest(s, inbox(eml({
        from: THEM, to: ME, messageId: `re-auto-${n}@corr.invalid`, inReplyTo: cited,
      }), `1:3${n}`));
      expect(plan.new!.desired, `citing ${cited}`).toBe("ohmail/Screener");
    }
  });

  it("CONTROL: naming a message we RECEIVED is not writing — only a Sent copy counts", async () => {
    const s = setup();
    await ingest(s, inbox(eml({ from: "other@else.invalid", to: ME, messageId: "got-1@else.invalid" }), "1:5"));
    const { plan } = await ingest(s, inbox(eml({
      from: STRANGER, to: ME, messageId: "x-2@stranger.invalid", inReplyTo: "got-1@else.invalid",
    })));
    expect(plan.new!.desired).toBe("ohmail/Screener");
  });

  it("CONTROL: a reply to a Sent copy from BEFORE the consent point is the seed's question", async () => {
    const s = setup();
    await ingest(s, sent(eml({ from: ME, to: THEM, messageId: "old-1@own.invalid" }), BEFORE));
    const { plan } = await ingest(s, inbox(eml({
      from: THEM, to: ME, messageId: "reply-2@corr.invalid", inReplyTo: "old-1@own.invalid",
    })));
    expect(plan.new!.desired).toBe("ohmail/Screener");
  });

  it("the person's own rule still wins — a correspondent they ruled out stays ruled out", async () => {
    const s = setup();
    const rule: Rule = {
      id: "r-1", kind: "sender", match: THEM, destination: "ohmail/Quarantine", effect: "deny",
      priority: 5, provenance: "manual", enabled: true, subjectContains: null, bodyContains: null,
    };
    s.repo.rules = [rule];
    await ingest(s, sent(eml({ from: ME, to: THEM, messageId: "sent-3@own.invalid" }), AFTER));
    const { plan } = await ingest(s, inbox(eml({
      from: THEM, to: ME, messageId: "reply-3@corr.invalid", inReplyTo: "sent-3@own.invalid",
    })));
    expect(plan.new!.desired).toBe("ohmail/Quarantine");
    expect(s.repo.correspondentCalls, "a rule's verdict is never re-asked").toBe(0);
  });
});

describe("the wrote arm — a Sent copy past the consent point teaches its recipients", () => {
  it("ACCEPTANCE: after writing to them, their mail with NO reference is admitted", async () => {
    const s = setup();
    await ingest(s, sent(eml({
      from: ME, to: THEM, cc: "copied@corr.invalid", messageId: "sent-4@own.invalid",
    }), AFTER), { correspondenceSince: CUT });
    expect(s.repo.senders.has(THEM)).toBe(true);
    expect(s.repo.senders.has("copied@corr.invalid"), "a Cc is somebody you wrote to").toBe(true);

    const { plan } = await ingest(s, inbox(eml({ from: THEM, to: ME, messageId: "fresh-1@corr.invalid" })));
    // Known now, so the gate admits them as it admits every contact: the Ohbox, where it arrived.
    expect(plan.new!.desired).toBe("INBOX");
    expect(s.repo.correspondentCalls, "a known sender is never asked about").toBe(0);
  });

  it("CONTROL: a Sent copy from before the consent point teaches nothing", async () => {
    const s = setup();
    await ingest(s, sent(eml({ from: ME, to: THEM, messageId: "sent-5@own.invalid" }), BEFORE),
      { correspondenceSince: CUT });
    expect(s.repo.senders.has(THEM)).toBe(false);
    const { plan } = await ingest(s, inbox(eml({ from: THEM, to: ME, messageId: "fresh-2@corr.invalid" })));
    expect(plan.new!.desired).toBe("ohmail/Screener");
  });

  it("CONTROL: no consent point, no teaching — consent is never read off a folder listing", async () => {
    const s = setup();
    await ingest(s, sent(eml({ from: ME, to: THEM, messageId: "sent-6@own.invalid" }), AFTER));
    expect(s.repo.senders.has(THEM)).toBe(false);
  });

  it("CONTROL: an automatic reply the account's client sent is not writing to them", async () => {
    const s = setup();
    await ingest(s, sent(eml({
      from: ME, to: THEM, messageId: "ooo-1@own.invalid", extra: ["Auto-Submitted: auto-replied"],
    }), AFTER), { correspondenceSince: CUT });
    expect(s.repo.senders.has(THEM)).toBe(false);
  });

  /** A Sent copy answering an invitation: its calendar part, and the type that names the method or not. */
  const answer = (messageId: string, typeMethod: boolean): Buffer => Buffer.from([
    `Message-ID: <${messageId}>`, `From: ${ME}`, `To: ${THEM}`, "Subject: Declined: Spring sale", "MIME-Version: 1.0",
    `Content-Type: text/calendar; charset=utf-8${typeMethod ? "; method=REPLY" : ""}`, "",
    "BEGIN:VCALENDAR", "METHOD:REPLY", "BEGIN:VEVENT", "UID:sale-1@corr.invalid", "DTSTAMP:20260922T151200Z",
    `ORGANIZER:mailto:${THEM}`, `ATTENDEE;PARTSTAT=DECLINED:mailto:${ME}`, "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n"));

  it("an answer to an invitation is not writing to them: a No to a stranger's invitation does not admit them", async () => {
    for (const [i, typeMethod] of [true, false].entries()) {
      const s = setup();
      const { plan } = await ingest(s, sent(answer(`reply-${i}@own.invalid`, typeMethod), AFTER), { correspondenceSince: CUT });
      expect(plan.new!.invitation?.method, "the copy is read as the answer it is").toBe("REPLY");
      expect(s.repo.senders.has(THEM), `method on the type: ${typeMethod}`).toBe(false);
      const next = await ingest(s, inbox(eml({ from: THEM, to: ME, messageId: `next-${i}@corr.invalid` })));
      expect(next.plan.new!.desired).toBe("ohmail/Screener");
    }
  });
});

describe("the invitation a letter carries reaches the commit", () => {
  const request = (messageId: string): Buffer => Buffer.from([
    `Message-ID: <${messageId}>`, `From: ${THEM}`, `To: ${ME}`, "Subject: Invitation: north elevation", "MIME-Version: 1.0",
    "Content-Type: text/calendar; charset=utf-8; method=REQUEST", "",
    "BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:elevation-1@corr.invalid", "SEQUENCE:1",
    "DTSTART:20261001T080000Z", `ORGANIZER:mailto:${THEM}`, `ATTENDEE:mailto:${ME}`, "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n"));

  it("the plan carries it, whose it is, and the commit writes it as the winner, the letters it changed owed a change", async () => {
    const s = setup();
    s.repo.invitationTouches = ["answered-elsewhere"];
    const { plan, res } = await ingest(s, inbox(request("inv-1@corr.invalid")));
    expect(plan.new!.invitation).toMatchObject({ method: "REQUEST", uid: "elevation-1@corr.invalid", sequence: 1, own: false });
    expect(s.repo.invitations.get(res.messageId)).toEqual(plan.new!.invitation);
    expect(s.repo.changes.filter((c) => c.entityId === "answered-elsewhere")).toEqual([
      expect.objectContaining({ entityType: "message", op: "update" }),
    ]);
    // From the person's own Sent folder, the plan says it is theirs.
    const own = await ingest(s, sent(request("inv-2@corr.invalid"), AFTER, "1:11"));
    expect(own.plan.new!.invitation?.own).toBe(true);
  });

  it("a letter without one plans none, and a loser of the insert writes none", async () => {
    const s = setup();
    const { plan } = await ingest(s, inbox(eml({ from: THEM, to: ME, messageId: "plain-1@corr.invalid" })));
    expect(plan.new!.invitation).toBeUndefined();
    const first = await ingest(s, inbox(request("inv-3@corr.invalid"), "1:30"));
    const before = s.repo.invitations.size;
    const again = await commitChange(first.plan, {
      repo: s.repo, routing: s.routing, accountId: "acct-1", mailboxId: "mb-1", storageCap: UNMETERED_STORAGE_CAP,
    });
    expect(again.outcome).toBe("duplicate");
    expect(s.repo.invitations.size).toBe(before);
  });
});

/* ══ THE REPLY ARM AND THE IDENTITY FACT (mail 0148), acceptance 5 ══ A reply citing a Sent copy
   proves the thread, not the name: a brand-claim reply is held, nothing is taught, no audit row. */
describe("the reply arm never admits an identity claim", () => {
  const GMAIL = "kartenservice@gmail.invalid";

  it("ACCEPTANCE: a brand-claim reply citing our Sent copy is held, and nothing is taught", async () => {
    const s = setup();
    await ingest(s, sent(eml({ from: ME, to: GMAIL, messageId: "sent-p@own.invalid" }), AFTER));
    const { plan } = await ingest(s, inbox(eml({
      from: `"PostFinance" <${GMAIL}>`, to: ME, messageId: "reply-p@gmail.invalid", inReplyTo: "sent-p@own.invalid",
    })));
    expect(plan.new!.desired).toBe("ohmail/Screener");
    expect(plan.new!.senderCheck?.brand).toBe("PostFinance");
    expect(plan.new!.correspondentAdmission).toBeUndefined();
    expect(s.repo.audits.some((a) => a.action === "screener.correspondent_admitted")).toBe(false);
    expect(s.repo.senders.has(GMAIL)).toBe(false);
  });

  it("CONTROL: the same reply without the claim is admitted and taught as a PERSON's contact", async () => {
    const s = setup();
    await ingest(s, sent(eml({ from: ME, to: GMAIL, messageId: "sent-q@own.invalid" }), AFTER));
    const { plan } = await ingest(s, inbox(eml({
      from: `"Hans Muster" <${GMAIL}>`, to: ME, messageId: "reply-q@gmail.invalid", inReplyTo: "sent-q@own.invalid",
    })));
    expect(plan.new!.desired).toBe("INBOX");
    expect(plan.new!.senderCheck).toBeNull();
    expect(s.repo.senders.has(GMAIL)).toBe(true);
    // The copy was written TO them: the same fact the Sent copy's own ingest teaches as a person's.
    expect(s.repo.inferredSenders.has(GMAIL), "a copy written to them is the person writing").toBe(false);
  });

  it("THE TWO-STEP LAUNDER: an unnamed citer's answer arrives untaught, so their next mail citing nothing is held", async () => {
    const s = setup();
    const OTHER = "karten.hilfe@gmail.invalid";
    await ingest(s, sent(eml({ from: ME, to: GMAIL, messageId: "sent-r@own.invalid" }), AFTER));
    const first = await ingest(s, inbox(eml({
      from: `"Hans Muster" <${OTHER}>`, to: ME, messageId: "reply-r@gmail.invalid", inReplyTo: "sent-r@own.invalid",
    }), "1:21"));
    expect(first.plan.new!.desired, "the answer arrives").toBe("INBOX");
    expect(s.repo.senders.has(OTHER), "and is not remembered").toBe(false);
    const second = await ingest(s, inbox(eml({
      from: `"Hans Muster" <${OTHER}>`, to: ME, messageId: "second-r@gmail.invalid", subject: "Noch etwas",
    }), "1:22"));
    expect(second.plan.new!.desired, "a correspondent for that message only").toBe("ohmail/Screener");
    const third = await ingest(s, inbox(eml({
      from: `"PostFinance" <${OTHER}>`, to: ME, messageId: "third-r@gmail.invalid", subject: "Ihre Karte",
    }), "1:23"));
    expect(third.plan.new!.desired).toBe("ohmail/Screener");
  });

  it("CONTROL: an unnamed citer's company claim is held, and nothing is taught", async () => {
    const s = setup();
    const OTHER = "karten.hilfe@gmail.invalid";
    await ingest(s, sent(eml({ from: ME, to: GMAIL, messageId: "sent-c@own.invalid" }), AFTER));
    const { plan } = await ingest(s, inbox(eml({
      from: `"PostFinance" <${OTHER}>`, to: ME, messageId: "reply-c@gmail.invalid", inReplyTo: "sent-c@own.invalid",
    })));
    expect(plan.new!.desired).toBe("ohmail/Screener");
    expect(plan.new!.correspondentAdmission).toBeUndefined();
    expect(s.repo.senders.has(OTHER)).toBe(false);
  });

  it("a Sent copy's recipients are taught as a PERSON's contacts", async () => {
    const s = setup();
    s.repo.correspondenceSince = CUT;
    await ingest(s, sent(eml({ from: ME, to: GMAIL, messageId: "sent-s@own.invalid" }), AFTER), {
      correspondenceSince: CUT,
    });
    expect(s.repo.senders.has(GMAIL)).toBe(true);
    expect(s.repo.inferredSenders.has(GMAIL)).toBe(false);
  });
});

/**
 * An answer the gate admits is decided for that letter, so a later letter from the
 * address waits at the gate without pulling it back. The stamp is `folder_state.decided_at`.
 */
describe("an answer the gate admits is decided for that letter", () => {
  const states = (s: ReturnType<typeof setup>) => [...s.repo.folder.values()];
  it("the reply arm writes the letter's placement as decided", async () => {
    const s = setup();
    await ingest(s, sent(eml({ from: ME, to: THEM, messageId: "sent-x@own.invalid" }), AFTER));
    await ingest(s, inbox(eml({
      from: STRANGER, to: ME, messageId: "x-9@stranger.invalid", inReplyTo: "sent-x@own.invalid",
    })));
    const answer = states(s).find((f) => f.desiredFolder === "INBOX");
    expect(answer?.decidedAt).toBeInstanceOf(Date);
  });

  it("CONTROL: a stranger the gate holds has no decided placement", async () => {
    const s = setup();
    await ingest(s, sent(eml({ from: ME, to: THEM, messageId: "sent-x@own.invalid" }), AFTER));
    await ingest(s, inbox(eml({
      from: STRANGER, to: ME, messageId: "x-1@stranger.invalid", inReplyTo: "nothing-we-sent@own.invalid",
    })));
    const held = states(s).find((f) => f.desiredFolder === "ohmail/Screener");
    expect(held).toBeDefined();
    expect(held?.decidedAt).toBeUndefined();
  });
});
