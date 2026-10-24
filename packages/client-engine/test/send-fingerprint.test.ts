/**
 * THE SEND FINGERPRINT SEES EVERY FIELD THE WIRE CARRIES — the one census, moved here with the
 * function from the web's send lock. It decides whether a stored key may be resumed for the content
 * in hand (web) and whether a resumed key must write its words before sending (adapter); a field left
 * out is two messages that hash alike. The field list is TYPED as every key of `mail_send`, so a field
 * added to the mutation and not listed here is a type error the test-dir ratchet refuses.
 */
import { describe, expect, it } from "vitest";
import { withSignature, type EngineMutation } from "@ohmail/client-engine";
import { sendFingerprint } from "@ohmail/client-engine/send-fingerprint";

type MailSend = Extract<EngineMutation, { kind: "mail_send" }>;

/** Every key of the type, each with one changed value; `draftId` is the container and must NOT move it. */
const MOVED: { [K in keyof Required<MailSend>]: MailSend[K] | null } = {
  kind: "mail_send",
  inReplyTo: "petra", forwardOf: "flurina", forwardParts: ["p-1"], forwardConfirmed: true,
  forwardClock: { zone: "Europe/Zurich", locale: "de" }, draftId: "d-2",
  body: "a different plain text half", html: "<p>a different rich half</p>",
  mailboxId: "mb-2", threadId: "th-2", subject: "Re: something else",
  to: [{ name: null, address: "someone@atelier.example" }], cc: [], bcc: [],
  attachments: [{ filename: "b.pdf", contentType: "application/pdf", contentBase64: "AAAABBBB" }],
  sendAt: "2026-09-09T09:00:00.000Z",
};

const FULL: MailSend = {
  kind: "mail_send", inReplyTo: "giulia", forwardOf: null, draftId: "d-1",
  body: "the plain text half", html: "<p>the rich half</p>", mailboxId: "mb-1", threadId: "th-1",
  subject: "Re: glaze order",
  to: [{ name: null, address: "lena@atelier.example" }],
  cc: [{ name: null, address: "cc@atelier.example" }],
  bcc: [{ name: null, address: "bcc@atelier.example" }],
  attachments: [{ filename: "a.pdf", contentType: "application/pdf", contentBase64: "AAAA" }],
  sendAt: "2026-09-08T09:00:00.000Z",
};

const NOT_IN_THE_IDENTITY: Record<string, string> = {
  kind: "the discriminant; every message here is a send",
  draftId: "the row is the container, not the content: one message in two rows is one message",
  forwardClock: "stamped by every forward press, and every shipped lock was hashed without it: in, it moves every forward's identity at the upgrade",
  forwardConfirmed: "the answer to a question, not content; absent from every shipped lock, and in, it moves a confirmed forward's identity",
};

const fp = (m: Partial<MailSend>): string => sendFingerprint({ ...FULL, ...m } as MailSend);
/** FULL as a forward, hashed before `forwardParts` existed: a lock stored then must still resume. */
const FWD_LOCK = "9rkpgp";

describe("sendFingerprint", () => {
  it("every key of the mail_send type moves it, and the named exclusions do not", () => {
    const base = fp({});
    const blind: string[] = [];
    const wronglyCovered: string[] = [];
    for (const field of Object.keys(MOVED) as Array<keyof MailSend>) {
      const changed = fp({ [field]: MOVED[field] } as Partial<MailSend>) !== base;
      if (field in NOT_IN_THE_IDENTITY) { if (changed) wronglyCovered.push(field); continue; }
      if (!changed) blind.push(field);
    }
    expect(blind, "fields the wire carries that the fingerprint cannot see").toEqual([]);
    expect(wronglyCovered, "the container is back inside the identity").toEqual([]);
  });

  it("forwardParts: absent keeps every stored lock; the selection moves it, its order does not", () => {
    const fwd = { inReplyTo: null, forwardOf: "flurina" };
    expect(fp({ ...fwd, forwardParts: undefined })).toBe(fp(fwd));
    expect(fp(fwd)).toBe(FWD_LOCK);
    expect(fp({ ...fwd, forwardParts: ["a"] })).not.toBe(fp({ ...fwd, forwardParts: ["b"] }));
    expect(fp({ ...fwd, forwardParts: [] })).not.toBe(fp(fwd));
    expect(fp({ ...fwd, forwardParts: ["a", "b"] })).toBe(fp({ ...fwd, forwardParts: ["b", "a"] }));
  });

  it("one message in two rows, and in none, is one fingerprint; the content still decides", () => {
    expect(fp({ draftId: "row-a" })).toBe(fp({ draftId: "row-b" }));
    expect(fp({ draftId: "row-a" })).toBe(fp({ draftId: undefined }));
    expect(fp({ draftId: "row-a", subject: "something else" })).not.toBe(fp({ draftId: "row-a" }));
  });

  it("the signature is inside it on a plain send and on a rich one", () => {
    const plain = { ...FULL, html: undefined } as MailSend;
    expect(sendFingerprint(withSignature(plain, "-- \nMila") as MailSend)).not.toBe(sendFingerprint(plain));
    expect(sendFingerprint(withSignature(FULL, "-- \nMila") as MailSend)).not.toBe(sendFingerprint(FULL));
  });

  it("an html-only edit moves it", () => {
    expect(fp({ html: "<p>the rich half, <b>corrected</b></p>" })).not.toBe(fp({}));
  });

  it("an attachment with the same name, type and length but other bytes moves it", () => {
    const file = (contentBase64: string) => ({ filename: "glaze.jpg", contentType: "image/jpeg", contentBase64 });
    expect(file("AAAA").contentBase64.length).toBe(file("BBBB").contentBase64.length);
    expect(fp({ attachments: [file("AAAA")] })).not.toBe(fp({ attachments: [file("BBBB")] }));
  });

  it("a recipient's display name moves it, on To, Cc and Bcc alike", () => {
    const blind = (["to", "cc", "bcc"] as const).filter((field) => {
      const one = FULL[field]![0]!;
      return fp({ [field]: [{ name: "Lena Brunner", address: one.address }] }) === fp({});
    });
    expect(blind).toEqual([]);
  });

  it("an unchanged message keeps its identity, rebuilt from its own values too", () => {
    expect(fp({})).toBe(fp({}));
    expect(sendFingerprint(JSON.parse(JSON.stringify(FULL)) as MailSend)).toBe(fp({}));
  });

  /**
   * EVERY STORED LOCK KEEPS ITS IDENTITY ACROSS THE UPGRADE: the hashes the shipped build (the web
   * send lock at this lane's base) gave the same reply and the same forward, measured there and
   * pinned. A changed hash is a stored key that stops resuming — a fresh key, and past the server's
   * one-hour duplicate window a second delivery.
   */
  it("the same reply and the same forward hash as the shipped build hashed them", () => {
    const forward = {
      kind: "mail_send", inReplyTo: null, forwardOf: "msg-1", forwardClock: { zone: "Europe/Zurich", locale: "de" },
      subject: "Fwd: x", body: "", mailboxId: "mb-1", to: [{ name: null, address: "b@x-ch.example" }], cc: [], bcc: [],
    } as MailSend;
    const reply = { ...forward, forwardOf: null, forwardClock: undefined, inReplyTo: "msg-1" } as MailSend;
    expect({ reply: sendFingerprint(reply), forward: sendFingerprint(forward), confirmed: sendFingerprint({ ...forward, forwardConfirmed: true }) })
      .toEqual({ reply: "1eht4hv", forward: "mlsw5t", confirmed: "mlsw5t" });
  });
});
