import { describe, expect, it } from "vitest";
import {
  screenModelInput, screenOutboundText, MODEL_SINK_REFUSAL_SENTENCE,
} from "../src/sensitive.js";

/**
 * THE DOOR EVERY MODEL SINK PASSES THROUGH — and the defect it closes.
 *
 * The per-field ingest flags screen each column on its own. A credential written across two of
 * them satisfies every one of those flags and is a credential again the moment the sink joins the
 * columns into a payload. Each fixture below is checked FIELD BY FIELD first, so a case cannot
 * quietly become one the old per-field screen would also have caught.
 */

/** Invented, in the shape providers use. Nothing here is anybody's real credential. */
const SPLIT = { subject: "Your passphrase", snippet: "It is 481920, on the label." };
const ORDINARY = {
  subject: "Lunch on Thursday",
  snippet: "Can we move it to 1pm at the usual place? I will book the table.",
  from: "lena@example.test",
};

describe("the split a per-field screen cannot see", () => {
  it("passes every field on its own and refuses the join", () => {
    expect(screenOutboundText(SPLIT.subject).safe, "the subject alone").toBe(true);
    expect(screenOutboundText(SPLIT.snippet).safe, "the snippet alone").toBe(true);

    const v = screenModelInput([{ label: "incoming", fields: [SPLIT.subject, SPLIT.snippet] }]);
    expect(v.admitted).toBe(false);
    expect(v.reason).toBe("credential_shape");
    expect(v.where).toBe("incoming");
  });

  it("refuses a split that lands in the vocabulary class, and names that class", () => {
    const subject = "Your verification";
    const snippet = "code is ready, tap the button below to continue.";
    expect(screenOutboundText(subject).safe).toBe(true);
    expect(screenOutboundText(snippet).safe).toBe(true);

    const v = screenModelInput([{ label: "incoming", fields: [subject, snippet] }]);
    expect(v.admitted).toBe(false);
    expect(v.reason).toBe("vocabulary");
    expect(v.category).toBe("otp");
  });

  it("admits an ordinary message — the control without which every case above passes for a door that refuses everything", () => {
    const v = screenModelInput([
      { label: "incoming", fields: [ORDINARY.subject, ORDINARY.snippet, ORDINARY.from] },
      { label: "kb", fields: ["Refund policy", "We refund within 30 days of delivery."] },
      { label: "thread", fields: ["Sounds good, see you then.", "sam@example.test"] },
    ]);
    expect(v).toEqual({ admitted: true, reason: null, category: null, where: null });
  });
});

describe("a field between the two halves does not hide the split", () => {
  /**
   * The screen's cue-to-code window is 40 characters. A field set BETWEEN the subject and the
   * snippet pushed the two halves out of each other's window and the join answered safe; the door
   * now also reads every pair of a document's fields in their order.
   */
  const from = "no-reply@notifications.vendor.example";

  it("catches the split when the prose halves are adjacent", () => {
    const v = screenModelInput([{ label: "incoming", fields: [SPLIT.subject, SPLIT.snippet, from] }]);
    expect(v.admitted).toBe(false);
  });

  it("catches it when an address is wedged between them", () => {
    const v = screenModelInput([{ label: "incoming", fields: [SPLIT.subject, from, SPLIT.snippet] }]);
    expect(v.admitted, "an address between the halves pushed them out of the window").toBe(false);
    expect(v.reason).toBe("credential_shape");
  });

  it("catches it when a long prose field sits between them", () => {
    const prose = "Thanks for your patience while we moved your account to its new home.";
    expect(screenOutboundText(prose).safe).toBe(true);
    const v = screenModelInput([{ label: "incoming", fields: [SPLIT.subject, prose, SPLIT.snippet] }]);
    expect(v.admitted, "a long field between the halves pushed them out of the window").toBe(false);
  });

  it("reads a pair in the document's order, never reversed: a notice ending in a reference number passes", () => {
    const v = screenModelInput([{ label: "incoming", fields: [
      "Password changed",
      "Hi, this confirms the change on your account. If this was not you, call us. Reference 552211",
      "no-reply@service.example",
    ] }]);
    expect(v.admitted, "a reversed pair set the body's number beside the subject's cue").toBe(true);
  });

  it("pairs prose only: the sender's address never meets the subject unless the letter sets them side by side", () => {
    const note = "Thanks again for your time on Monday. Let me know which afternoon suits you, and I will send the rest.";
    for (const [subject, sender] of [
      ["Angebot 2024117 für das Projekt", "lea.meier@codefabrik.example"],
      ["Re: PO 4815162", "max@kodiak.example"],
      ["Meeting in room 4410 tomorrow", "jana@codeworks.example"],
      ["Re: code review for the parser", "84719265@mail.example"],
      ["Question about the codebase", "5813472@mail.example"],
    ] as const) {
      expect(screenOutboundText(subject, note).safe, subject).toBe(true);
      expect(screenOutboundText(subject, sender).safe, `${subject}: a pair the letter never had`).toBe(false);
      const v = screenModelInput([{ label: "incoming", fields: [subject, note, sender] }]);
      expect(v.admitted, `${subject} from ${sender}`).toBe(true);
    }
  });
});

describe("the unit is the document, not the whole payload", () => {
  it("does not refuse a code in one document and a credential word in an unrelated other", () => {
    const v = screenModelInput([
      { label: "incoming", fields: ["Order shipped", "Your parcel 481920 is on its way."] },
      { label: "kb", fields: ["Passphrase policy", "Everyone picks their own; we never store one."] },
    ]);
    expect(v.admitted, "joining two documents would refuse ordinary mail").toBe(true);
  });

  it("refuses when one document carries both halves, and names WHICH", () => {
    const v = screenModelInput([
      { label: "incoming", fields: [ORDINARY.subject, ORDINARY.snippet] },
      { label: "kb", fields: [SPLIT.subject, SPLIT.snippet] },
    ]);
    expect(v.admitted).toBe(false);
    expect(v.where).toBe("kb");
  });

  it("skips empty and absent fields without taking them for a document", () => {
    expect(screenModelInput([{ label: "incoming", fields: [null, undefined, ""] }]).admitted).toBe(true);
  });
});

describe("the reason class is a sentence a person can read", () => {
  it("has one plain sentence per class, and none of them is jargon or a field name", () => {
    const classes = ["vocabulary", "credential_shape", "auth_url_token"] as const;
    expect(Object.keys(MODEL_SINK_REFUSAL_SENTENCE).sort()).toEqual([...classes].sort());
    for (const c of classes) {
      const s = MODEL_SINK_REFUSAL_SENTENCE[c];
      expect(s.length).toBeGreaterThan(20);
      expect(s, "a class name in the sentence is the class leaking, not an explanation").not.toContain("_");
      expect(s.startsWith("this message"), s).toBe(true);
    }
  });

  it("every refusal names a class the sentence map answers", () => {
    for (const fields of [
      [SPLIT.subject, SPLIT.snippet],
      ["Your verification", "code is ready, tap the button below to continue."],
      ["Finish signing in", "https://accounts.example.test/auth/verify?token=Hh3kQ2mZ8vA1pR7xTt0wLcNbYe4Uf6Sj"],
    ]) {
      const v = screenModelInput([{ label: "incoming", fields }]);
      expect(v.admitted, fields[0]).toBe(false);
      expect(MODEL_SINK_REFUSAL_SENTENCE[v.reason!], fields[0]).toBeTruthy();
    }
  });
});
