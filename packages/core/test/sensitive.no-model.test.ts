import { describe, it, expect } from "vitest";
import { planChange, commitChange , UNMETERED_STORAGE_CAP} from "../src/pipeline.js";
import { FakeRepo, FakeRouting } from "./fakes.js";
import type { Change } from "../src/ports.js";
import type { ClassifierResult } from "../src/ai/classify.js";
import { WITHHELD, type WithheldCase } from "./fixtures/sensitive-corpus.js";

/** Every From: this corpus uses. A KNOWN sender is what keeps the message in the unclear residue. */
const KNOWN = ["no-reply@atlas-identity.invalid", "no-reply@service.invalid", "friend@known.invalid"];

let midSeq = 0;

/**
 * Render a corpus case as a real RFC822 message.
 *
 * The `patch` cases are `NormalizedMessage` shapes, which `planChange` cannot take — it starts
 * from `change.raw`. Rendering them back to MIME is not a workaround; it is what makes this test
 * cover the same surface the review attacked, because the normalizer gets to disagree with the patch
 * and the assertion still has to hold.
 *
 * ── `alternative` vs `mixed` IS THE WHOLE POINT AND IT WAS FOUND HERE ─────────────────────────
 *
 * The first version of this helper wrapped everything in `multipart/mixed`, and the
 * alternatives-divergence case went green with `ordinary`. That is not a detector bug: in a MIXED
 * container the text part and the html part are two SEQUENTIAL body parts, and `simpleParser`
 * correctly concatenates both into `text` AND both into `html`. Nothing is hidden, so there is
 * nothing to be indeterminate about. Divergence is only possible in `multipart/alternative`,
 * where the two parts claim to be the same message — which is exactly the container the second finding used.
 * Attachments still need `mixed`.
 */
function toRaw(c: WithheldCase): Buffer {
  if (c.raw !== undefined) return Buffer.from(c.raw, "utf8");
  const p = c.patch ?? {};
  const head = [
    `Message-ID: <b10-${++midSeq}@service.invalid>`,
    "From: Atlas Identity <no-reply@atlas-identity.invalid>",
    "To: ohmail@lichtgrat.example",
    `Subject: =?UTF-8?B?${Buffer.from(p.subject ?? "", "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
  ];
  const attachments = p.attachments ?? [];
  const b = `b0und-${midSeq}`;

  // Single body part and nothing attached: a plain message, no multipart at all.
  if (attachments.length === 0 && !(p.textBody && p.htmlBody)) {
    const html = !p.textBody && p.htmlBody;
    return Buffer.from([
      ...head,
      `Content-Type: text/${html ? "html" : "plain"}; charset=utf-8`,
      "",
      (html ? p.htmlBody : p.textBody) ?? "",
      "",
    ].join("\r\n"), "utf8");
  }

  const parts: string[] = [];
  if (p.textBody) parts.push([`--${b}`, "Content-Type: text/plain; charset=utf-8", "", p.textBody].join("\r\n"));
  if (p.htmlBody) parts.push([`--${b}`, "Content-Type: text/html; charset=utf-8", "", p.htmlBody].join("\r\n"));
  for (const a of attachments) {
    parts.push([
      `--${b}`,
      `Content-Type: ${a.contentType}${a.filename ? `; name="${a.filename}"` : ""}`,
      `Content-Disposition: attachment${a.filename ? `; filename="${a.filename}"` : ""}`,
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("placeholder body of the attached part", "utf8").toString("base64"),
    ].join("\r\n"));
  }
  return Buffer.from([
    ...head,
    `Content-Type: multipart/${attachments.length > 0 ? "mixed" : "alternative"}; boundary="${b}"`,
    "",
    ...parts,
    `--${b}--`,
    "",
  ].join("\r\n"), "utf8");
}

function deps() {
  const repo = new FakeRepo();
  for (const s of KNOWN) repo.senders.add(s);
  return {
    repo, routing: new FakeRouting(),
    classifier: {
      calls: 0,
      async classify(): Promise<ClassifierResult> {
        this.calls++;
        return { destination: "ohmail/News", confidence: 0.9, rationale: "service notice", spam: false };
      },
    },
    credits: {
      calls: 0,
      async spend() {
        this.calls++;
        return { verdict: "ok", charged: true, attempt: "classification" } as const;
      },
    },
    accountId: "acct-1", mailboxId: "mb-1",
  };
}

const change = (raw: Buffer, ref: string): Change =>
  ({ type: "create", locator: { folder: "INBOX", ref }, raw });

describe("AI can process mail carrying any sensitivity flag", () => {
  it.each(WITHHELD.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const d = deps();
    const plan = await planChange(change(toRaw(c), `1:${++midSeq}`), {
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId,
      classifier: d.classifier, routing: d.routing, credits: d.credits,
    });

    expect(d.classifier.calls).toBe(1);
    expect(d.credits.calls).toBe(1);
    expect(plan.outcome).toBe("new");
    expect(plan.new!.sensitivity.flags.no_ai).toBe(true);
    expect(plan.new!.ai).toBeDefined();

    const res = await commitChange(plan, {
    storageCap: UNMETERED_STORAGE_CAP,
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, routing: d.routing,
    });
    expect(d.routing.decisions, `${c.id}: routing decision`).toHaveLength(1);
    expect(d.routing.approvals, `${c.id}: approval`).toHaveLength(1);
    expect(res.messageId).toBeTruthy();
  });

  it("classifies a verification message and stores its full body", async () => {
    const d = deps();
    const raw = Buffer.from([
      "Message-ID: <redact@service.invalid>",
      "From: Atlas Identity <no-reply@atlas-identity.invalid>",
      "To: ohmail@lichtgrat.example",
      "Subject: Your verification code",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Your one-time code is 900123. Or tap https://accounts.example.com/session?t=SECRET-LOGIN-TOKEN",
      "",
    ].join("\r\n"), "utf8");
    const plan = await planChange(change(raw, "1:8888"), {
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId,
      classifier: d.classifier, routing: d.routing, credits: d.credits,
    });
    const res = await commitChange(plan, {
    storageCap: UNMETERED_STORAGE_CAP,
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, routing: d.routing,
    });
    const body = d.repo.bodies.get(res.messageId)!;
    expect(body.text).toContain("900123");
    expect(body.text).toContain("SECRET-LOGIN-TOKEN");
    expect(body.text).not.toContain("[REDACTED]");
    expect(d.classifier.calls).toBe(1);
    expect(d.credits.calls).toBe(1);
  });
});
