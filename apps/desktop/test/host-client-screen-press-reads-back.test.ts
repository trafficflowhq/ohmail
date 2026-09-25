/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  HttpAdapter, OhmailEngine, encodeSeqCursor, type EngineMessage, type RuleDTO, type SyncChange,
} from "@ohmail/client-engine";
import { BearerManager } from "../src/host-client/bearer";
import { screeningVerdict } from "../../webapp/app/shell/press-verdict";
import { dispatchScreeningChange, planScreeningChange, senderScreening } from "../../webapp/app/shell/sender-screening";

/**
 * THE PAIRED DESKTOP'S SCREENING PRESS, THROUGH THE HOST-CLIENT DOOR. The
 * window's engine is built as `HostGate` builds it — an `HttpAdapter` over the bearer's fetch — and
 * the press is the shared shell's. The reported shape pressed to the Ohbox is read back from the
 * list with the subject rule named; a higher-priority domain rule no longer keeps the address.
 */
const ADDR = "sender@fake.test";
const TERM = "[Weekly-Digest]";
const AT = "2026-08-19T07:00:00.000Z";

function rule(o: Partial<RuleDTO> & Pick<RuleDTO, "id" | "destination">): RuleDTO {
  return {
    kind: "sender", match: ADDR, priority: 0, provenance: "manual", enabled: true, subjectContains: null,
    bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: AT, updatedAt: AT, ...o,
  } as RuleDTO;
}

function message(id: string, subject: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject,
    from: { name: null, address: ADDR }, to: [], cc: [], date: AT, folder: "INBOX", snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: AT,
  } as EngineMessage;
}

/** The host's API at the fetch seam: a change log, `/sync`, and the rule routes a press uses. */
function host(rules: RuleDTO[]) {
  const log: SyncChange[] = [];
  const posts: Record<string, unknown>[] = [];
  const push = (type: string, op: "create" | "update", id: string, entity: unknown) =>
    log.push({ type, op, id, seq: log.length + 1, updatedAt: AT, entity } as SyncChange);
  for (const r of rules) push("rule", "create", r.id, r);
  push("message", "create", "m1", message("m1", "Order fulfilled"));
  push("message", "create", "m2", message("m2", `${TERM} week 38`));
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", "x-sync-seq": String(log.length) },
  });
  const fetchImpl = async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(url, "http://host.test");
    const method = init?.method ?? "GET";
    if (u.pathname === "/sync") {
      const since = u.searchParams.get("since");
      const from = since ? Number(Buffer.from(since, "base64url").toString("utf8").replace(/^seq:/, "")) : 0;
      const changes = log.filter((c) => c.seq > from);
      return answer(200, { changes: { creates: changes, updates: [], moves: [], deletes: [] }, cursor: encodeSeqCursor(log.length), hasMore: false, serverTime: AT });
    }
    if (method === "POST" && u.pathname === "/rules") {
      const p = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push(p);
      const r = rule({ id: `srv-${log.length + 1}`, kind: p.kind as RuleDTO["kind"], match: String(p.match), destination: p.destination as RuleDTO["destination"], priority: Number(p.priority ?? 0) });
      push("rule", "create", r.id, r);
      return answer(201, r);
    }
    return answer(200, {});
  };
  return { fetchImpl, posts };
}

async function pairedWindow(rules: RuleDTO[]) {
  const h = host(rules);
  const bearer = new BearerManager({ storage: null, fetchImpl: h.fetchImpl as never });
  const engine = new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "", headers: () => bearer.headers(), fetch: bearer.fetch }) });
  await engine.start();
  const press = async () => {
    const plan = planScreeningChange(senderScreening(engine.verbRead(), "m1")!, "ohbox");
    await dispatchScreeningChange(plan, (m) => engine.mutate(m));
    return screeningVerdict(engine.verbRead(), "m1", undefined, "ohbox", "sender", {
      consent: { known: true, standalone: false, dormancyDays: 60, screeningBaselineAt: null, screeningScope: "window", foldersEnabled: false },
      now: new Date("2026-08-19T10:00:00.000Z"), ownAddresses: [], retro: plan.retro,
    });
  };
  return { press, posts: h.posts };
}

describe("the paired desktop's sender sheet reads its press back from the list", () => {
  it.each(["ohmail/Reads", "ohmail/News"])("the reported shape, News spelled %s", async (news) => {
    const w = await pairedWindow([
      rule({ id: "r-bare", destination: "INBOX", provenance: "seeded-from-sent" }),
      rule({ id: "r-split", destination: news as RuleDTO["destination"], subjectContains: TERM, createdAt: "2026-08-19T08:00:00.000Z" }),
    ]);
    expect(await w.press()).toMatchObject({ key: "kept", count: 1, kept: 1, keptPlace: "ohmail/News", term: TERM });
  });

  it("a higher-priority domain rule into News: the press's rule carries its priority", async () => {
    const w = await pairedWindow([rule({ id: "r-dom", kind: "domain", match: "fake.test", destination: "ohmail/News", priority: 5 })]);
    expect(await w.press()).toEqual({ key: "none" });
    expect(w.posts).toMatchObject([{ kind: "sender", match: ADDR, destination: "INBOX", priority: 5 }]);
  });
});
