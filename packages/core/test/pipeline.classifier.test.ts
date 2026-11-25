import { describe, it, expect } from "vitest";
import { planChange, commitChange, applyReconcileAction, AUTO_APPLY_CONFIDENCE_BAR , UNMETERED_STORAGE_CAP} from "../src/pipeline.js";
import { FakeRepo, FakeAdapter, FakeRouting, dedupKeyFor } from "./fakes.js";
import type { Change, PipelineDeps } from "../src/ports.js";
import type { ClassifierPort, ClassifierInput, ClassifierResult } from "../src/ai/classify.js";
import type { Rule } from "../src/rules.js";
import { makeHaikuClassifier, type AnthropicLike } from "../src/ai/classify.js";

class FakeClassifier implements ClassifierPort {
  calls = 0;
  lastInput?: ClassifierInput;
  constructor(private readonly result: ClassifierResult) {}
  async classify(input: ClassifierInput): Promise<ClassifierResult> {
    this.calls++;
    this.lastInput = input;
    return this.result;
  }
}

function eml(opts: { from?: string; subject?: string; body?: string } = {}): Buffer {
  const { from = "friend@known.example", subject = "hey", body = "just a normal note about lunch" } = opts;
  return Buffer.from([
    "Message-ID: <c-1@known.example>",
    `From: ${from}`,
    "To: mila@lichtgrat.example",
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n"));
}
const createChange = (folder: string, raw: Buffer, ref = "1:10"): Change => ({ type: "create", locator: { folder, ref }, raw });

function makeDeps(result: ClassifierResult): PipelineDeps & { repo: FakeRepo; adapter: FakeAdapter; routing: FakeRouting; classifier: FakeClassifier } {
  const repo = new FakeRepo();
  repo.senders.add("friend@known.example"); // KNOWN sender → not routed to Screener → the unclear residue
  return {
    repo, adapter: new FakeAdapter(), routing: new FakeRouting(),
    classifier: new FakeClassifier(result), accountId: "acct-1", mailboxId: "mb-1",
  };
}

async function run(change: Change, d: ReturnType<typeof makeDeps>) {
  const plan = await planChange(change, { repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, classifier: d.classifier, routing: d.routing });
  const res = await commitChange(plan, { repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, routing: d.routing, storageCap: UNMETERED_STORAGE_CAP });
  if (res.action.type === "move") {
    const stored = d.repo.rows.get(res.messageId)!.stored;
    const state = (await d.repo.getFolderState(res.messageId))!;
    await applyReconcileAction(d, { messageId: res.messageId, locator: stored.nativeLocator, state }, res.action);
  }
  return res;
}

const FEED: ClassifierResult = { destination: "ohmail/News", confidence: 0.9, rationale: "newsletter", spam: false };

describe("pipeline AI branch — gating", () => {
  it("does NOT classify a message a rule already routes (clear destination)", async () => {
    const d = makeDeps(FEED);
    const rule: Rule = { id: "r", kind: "sender", match: "friend@known.example", destination: "ohmail/Receipts", effect: "allow", priority: 5, provenance: "manual", enabled: true };
    d.repo.rules = [rule];
    const res = await run(createChange("INBOX", eml()), d);
    expect(d.classifier.calls).toBe(0);            // rule decided; AI never consulted
    expect(res.action).toEqual({ type: "move", to: "ohmail/Receipts" });
    expect(d.routing.decisions).toHaveLength(0);
  });

  it("does NOT classify an unknown first-contact sender (Screener short-circuits)", async () => {
    const d = makeDeps(FEED);
    d.repo.senders.clear(); // unknown → screener, destination is set (not the unclear null)
    const res = await run(createChange("INBOX", eml({ from: "stranger@nowhere-com.example" })), d);
    expect(d.classifier.calls).toBe(0);
    expect(res.action).toEqual({ type: "move", to: "ohmail/Screener" });
  });

  it("sends redacted routing input and retains the original mail", async () => {
    const d = makeDeps(FEED);
    const calls: unknown[] = [];
    const client: AnthropicLike = { messages: { async create(request) {
      calls.push(request);
      return { content: [{ type: "text", text: JSON.stringify(FEED) }] };
    } } };
    const subject = "Your sign-in code";
    const body = "Your sign-in code is 900123. Order 703821.";
    const raw = eml({ subject, body });
    const plan = await planChange(createChange("INBOX", raw), {
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId,
      classifier: makeHaikuClassifier({ client }), routing: d.routing,
    });
    const result = await commitChange(plan, {
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, routing: d.routing, storageCap: UNMETERED_STORAGE_CAP,
    });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).toContain("Your sign-in code is [code]. Order [code].");
    expect(JSON.stringify(calls)).not.toContain("703821");
    expect(JSON.stringify(calls)).not.toContain("900123");
    expect(d.repo.rows.get(result.messageId)?.input).toMatchObject({ subject, snippet: body });
    expect(d.repo.bodies.get(result.messageId)?.text.trim()).toBe(body);
  });

  it("preserves the routing preview when sign-in wording appears only in a footer", async () => {
    const d = makeDeps(FEED);
    const subject = "Your order 48291735 has shipped";
    const preview = "Order 48291735 shipped. Track: https://shop.example.test/orders/48291735/track.";
    const body = [preview, "Thank you for shopping with us. ".repeat(15),
      "Forgot your password? Visit our help center. We will never ask for your password or verification code by email."].join("\n");
    const calls: unknown[] = [];
    const classifier = makeHaikuClassifier({ client: { messages: { async create(request) {
      calls.push(request);
      return { content: [{ type: "text", text: JSON.stringify(FEED) }] };
    } } } });
    await planChange(createChange("INBOX", eml({ subject, body })), {
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, classifier, routing: d.routing,
      ohboxBar: "Security codes and sign-in mails always come to me.",
    });
    expect(calls).toHaveLength(1);
    const { messages: [user] } = calls[0] as { messages: [{ content: string }] };
    expect(JSON.parse(user.content)).toMatchObject({ subject, snippet: body.replace(/\s+/g, " ").slice(0, 200) });
  });

  it("redacts the subject and detects codes before shortening the routing preview", async () => {
    const d = makeDeps(FEED);
    const wire: string[] = [];
    const classifier = makeHaikuClassifier({ client: { messages: { async create(request) {
      wire.push(JSON.stringify(request));
      return { content: [{ type: "text", text: JSON.stringify(FEED) }] };
    } } } });
    const subject = "638194 Example Desk";
    const notice = "Enter the verification code below.";
    const intro = "A notice about your account. ".repeat(6).slice(0, 195 - notice.length) + ".";
    const body = [intro + " " + notice, "749382", "It expires soon."].join("\n");
    const snippet = body.replace(/\s+/g, " ").slice(0, 200);
    expect(snippet).toMatch(/below\. 74$/);
    const plan = await planChange(createChange("INBOX", eml({ subject, body })), {
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, classifier, routing: d.routing,
    });
    const result = await commitChange(plan, {
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, routing: d.routing, storageCap: UNMETERED_STORAGE_CAP,
    });
    expect(wire).toHaveLength(1);
    const { messages: [user] } = JSON.parse(wire[0]!) as { messages: [{ content: string }] };
    const outgoing = JSON.parse(user.content) as { subject: string; snippet: string };
    expect(outgoing.subject).toBe("[code] Example Desk");
    expect(outgoing.snippet).toContain("code below.");
    expect(outgoing.snippet).not.toContain("74");
    expect(wire[0]).not.toContain("638194");
    expect(d.repo.rows.get(result.messageId)?.input).toMatchObject({ subject, snippet });
    expect(d.repo.bodies.get(result.messageId)?.text.trim().replace(/\r\n/g, "\n")).toBe(body);
  });

  it("screens a stored flattened preview with its original subject redacted on the wire", async () => {
    const d = makeDeps(FEED);
    const subject = "638194 Example Desk";
    const body = ["Here is the verification code you need.", "638194", "It expires soon."].join("\n");
    const plan = await planChange(createChange("INBOX", eml({ subject, body })), {
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId,
    });
    const result = await commitChange(plan, {
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, routing: d.routing, storageCap: UNMETERED_STORAGE_CAP,
    });
    const stored = d.repo.rows.get(result.messageId)!.input;
    expect(stored.snippet).toBe("Here is the verification code you need. 638194 It expires soon.");
    const wire: string[] = [];
    const classifier = makeHaikuClassifier({ client: { messages: { async create(request) {
      wire.push(JSON.stringify(request));
      return { content: [{ type: "text", text: JSON.stringify(FEED) }] };
    } } } });
    await classifier.screen!({ subject: stored.subject, snippet: stored.snippet, from: { name: null, address: "" }, headersDigest: "" });
    expect(wire).toHaveLength(1);
    const { messages: [user] } = JSON.parse(wire[0]!) as { messages: [{ content: string }] };
    expect(JSON.parse(user.content)).toMatchObject({
      subject: "[code] Example Desk", snippet: "Here is the verification code you need. [code] It expires soon.",
    });
    expect(wire[0]).not.toContain("638194");
    expect(stored.subject).toBe(subject);
  });

  it("classifies sign-in mail and persists the original body without applying trained routing", async () => {
    const d = makeDeps({ ...FEED, confidence: 0.95 });
    d.routing.graduated.add("sender:friend@known.example→ohmail/News");
    const raw = eml({ subject: "Your verification code", body: "Your one-time code is 900123." });
    const res = await run(createChange("INBOX", raw), d);
    expect(d.classifier.calls).toBe(1);
    expect(d.routing.decisions).toHaveLength(1);
    expect(res.action).toEqual({ type: "none" });  // sensitive → stays in INBOX
    const stored = (await d.repo.findByDedupKey("mb-1", await dedupKeyFor(raw)))!;
    expect(d.repo.bodies.get(stored.id)!.text).toContain("900123");
    expect(d.repo.bodies.get(stored.id)!.text).not.toContain("[REDACTED]");
  });
});

describe("pipeline AI branch — routing decision + approval vs auto-apply", () => {
  it("unclear + not graduated → routing_decision(pending_approval) + approval, message left in place", async () => {
    const d = makeDeps(FEED);
    const res = await run(createChange("INBOX", eml()), d);
    expect(d.classifier.calls).toBe(1);
    expect(d.classifier.lastInput!.snippet).not.toContain("cache_control");
    expect(res.action).toEqual({ type: "none" });               // not moved until approved
    expect(d.adapter.moves).toEqual([]);
    expect(d.routing.decisions).toHaveLength(1);
    expect(d.routing.decisions[0]).toMatchObject({ inputProvenance: "ai", destination: "ohmail/News", status: "pending_approval" });
    expect(d.routing.approvals).toHaveLength(1);
    expect(d.routing.approvals[0]).toMatchObject({ kind: "routing", action: "move", payload: { folder: "ohmail/News" } });
    // change_log: thread create + message create + routing_decision create + approval create
    // (no move). The `thread` row is slice the NEW CONSUMER of this sequence and it leads
    // deliberately — a client applying the delta in seq order must never see a message
    // referencing a thread it has not been told about. Widened rather than loosened: the list
    // is still exact, so a fifth row appearing here still fails.
    const ops = d.repo.changes.map((c) => `${c.entityType}:${c.op}`);
    expect(ops).toEqual([
      "thread:create", "message:create", "routing_decision:create", "approval:create",
    ]);
  });

  it("graduated + confidence ≥ bar → auto-apply (auto_applied, no approval, move change emitted)", async () => {
    const d = makeDeps({ ...FEED, confidence: 0.95 });
    d.routing.graduated.add("sender:friend@known.example→ohmail/News");
    const res = await run(createChange("INBOX", eml()), d);
    expect(res.action).toEqual({ type: "move", to: "ohmail/News" });
    expect(d.adapter.moves).toEqual([{ from: { folder: "INBOX", ref: "1:10" }, to: "ohmail/News" }]);
    expect(d.routing.decisions[0].status).toBe("auto_applied");
    expect(d.routing.approvals).toHaveLength(0);
    const ops = d.repo.changes.map((c) => `${c.entityType}:${c.op}`);
    expect(ops).toContain("message:move");
    expect(ops).toContain("routing_decision:create");
    expect(ops).not.toContain("approval:create");
  });

  it("graduated but confidence < bar → NOT auto-applied (falls back to an approval)", async () => {
    const d = makeDeps({ ...FEED, confidence: AUTO_APPLY_CONFIDENCE_BAR - 0.01 });
    d.routing.graduated.add("sender:friend@known.example→ohmail/News");
    const res = await run(createChange("INBOX", eml()), d);
    expect(res.action).toEqual({ type: "none" });
    expect(d.routing.decisions[0].status).toBe("pending_approval");
    expect(d.routing.approvals).toHaveLength(1);
  });

  it("with NO classifier/routing injected the branch is inert (Phase-0 behavior)", async () => {
    const d = makeDeps(FEED);
    const plan = await planChange(createChange("INBOX", eml()), { repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId });
    const res = await commitChange(plan, { repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, storageCap: UNMETERED_STORAGE_CAP });
    expect(res.action).toEqual({ type: "none" }); // unclear residue left in place, no AI
    expect(d.routing.decisions).toHaveLength(0);
  });
});

/**
 * A DECLINE ANSWERS FOR THE ONE MESSAGE. Anthropic's documented refusal, through the real
 * classifier: the message is ingested exactly as with AI off. Rethrown, the sync retried the same
 * message, drew the same decline, and the mailbox's new mail and read state stalled behind it.
 * Mutation: restore `throw err` for every classifier throw in `pipeline.ts`'s catch.
 */
describe("pipeline AI branch — a decline answers for the one message", () => {
  /** Anthropic's refusals page, read 2026-10-12: HTTP 200, no content, the stop reason says why. */
  const REFUSAL = {
    id: "msg_refusal", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [],
    stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
    usage: { input_tokens: 900, output_tokens: 0 },
  };
  const CUT_OFF = {
    id: "msg_cut", type: "message", role: "assistant", model: "claude-haiku-5-5",
    content: [{ type: "text", text: '{"destination":"ohmail/Ne' }], stop_reason: "max_tokens",
    usage: { input_tokens: 900, output_tokens: 512 },
  };
  function answering(answer: () => Promise<unknown>): ClassifierPort & { calls: number } {
    let calls = 0;
    const client = { messages: { create: async () => { calls++; return answer(); } } } as AnthropicLike;
    const port = makeHaikuClassifier({ client });
    return { classify: (i, c) => port.classify(i, c), get calls() { return calls; } };
  }

  it.each([
    ["a refusal", REFUSAL],
    ["a cut-off answer", CUT_OFF],
  ] as const)("%s ingests the message as AI-off does: no decision, no approval, no throw", async (_label, answer) => {
    const d = makeDeps(FEED);
    const port = answering(async () => answer);
    const plan = await planChange(createChange("INBOX", eml()), {
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, readerMode: false, classifier: port, routing: d.routing,
    });
    const res = await commitChange(plan, {
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, routing: d.routing, storageCap: UNMETERED_STORAGE_CAP,
    });
    expect(port.calls).toBe(1);
    expect(res.action).toEqual({ type: "none" });   // the AI-off answer above: left in place
    expect(d.routing.decisions).toHaveLength(0);
    expect(d.routing.approvals).toHaveLength(0);
    expect(d.repo.changes.map((c) => `${c.entityType}:${c.op}`)).toEqual(["thread:create", "message:create"]);
  });

  it("CONTROL: a provider fault is still rethrown — a fault leaves the message for the retry", async () => {
    const d = makeDeps(FEED);
    await expect(planChange(createChange("INBOX", eml()), {
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, readerMode: false,
      classifier: answering(async () => { throw new Error("anthropic 529 overloaded"); }), routing: d.routing,
    })).rejects.toThrow("anthropic 529 overloaded");
  });
});
