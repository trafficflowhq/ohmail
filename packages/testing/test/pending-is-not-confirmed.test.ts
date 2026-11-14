import { describe, expect, it } from "vitest";
import {
  HttpAdapter,
  OhmailEngine,
  ORGANIZER_REQUEST_SLOW_MS,
  type EngineMessage,
  type Folder,
} from "@ohmail/client-engine";

/**
 * A 202 IS A REQUEST RECORDED, NOT A MOVE MADE.
 *
 * Press Move or Delete on a mailbox this install only READS: the service writes an
 * `organizer_requests` row for the install that organizes it and answers
 * `202 {pending:true, requestId, holder, dto}` — with `dto` the message STILL WHERE IT WAS. The
 * adapter used to read that body as an ordinary success, the drain that followed carried nothing
 * (a queued request emits no `change_log` row), and the engine settled the mutation as CONFIRMED:
 * the phone said "Moved" over a message nobody had moved.
 *
 * The double answers exactly what the service sends — `MoveRequestResult` in
 * `packages/services/src/message-service.ts`, whose type this file imports so a change on that
 * side breaks this fixture rather than silently passing it.
 */
import type { MoveRequestResult } from "@trafficflow/services";

const NOW = new Date("2026-09-15T09:00:00.000Z");
/**
 * The holder as the database defines it (`OrganizedBy` — kind, name, since), not as a fixture
 * imagines it. The first draft of this file invented an `installId`; the type-only import below
 * is what refused it, which is the whole reason a double borrows the production type.
 */
const HOLDER: MoveRequestResult["holder"] = {
  kind: "local", name: "Studio laptop", since: "2026-09-01T09:00:00.000Z",
};

const message = (over: Partial<EngineMessage> = {}): EngineMessage => ({
  id: "m1",
  accountId: "a1",
  mailboxId: "mb1",
  threadId: null,
  messageIdHeader: "<m1@example.test>",
  subject: "The invoice",
  from: { name: "Lena", address: "lena@atelier.example" },
  to: [],
  cc: [],
  date: "2026-09-15T08:00:00.000Z",
  folder: "INBOX" as Folder,
  snippet: "…",
  unread: true,
  hasAttachments: false,
  attachmentCount: 0,
  sensitivity: {} as EngineMessage["sensitivity"],
  triage: null,
  labels: [],
  remoteContent: "none",
  updatedAt: "2026-09-15T08:00:00.000Z",
  ...over,
});

type Answer = { status: number; body: unknown; seq?: number };

/**
 * The reader mailbox's server. One message, and a Move/Delete door that records a request
 * instead of writing — `mode` picks which door the next press meets, so one world drives the
 * queued arm, the organizer's own arm and a refusal without three fixtures.
 */
function readerWorld(mode: "request" | "organizer" | "refuse" = "request") {
  let seq = 10;
  let row = message();
  const pages: Array<{ changes: unknown[] }> = [];
  const requests: string[] = [];

  /** The organizer carried the request out: the change that confirms it arrives on the next drain. */
  const organizerApplies = (folder: Folder) => {
    seq += 1;
    row = { ...row, folder, updatedAt: NOW.toISOString() };
    pages.push({
      changes: [{ type: "message", op: "move", id: row.id, seq, updatedAt: row.updatedAt, entity: row, move: { from: "INBOX", to: folder } }],
    });
  };
  const organizerDeletes = () => {
    seq += 1;
    pages.push({ changes: [{ type: "message", op: "delete", id: row.id, seq, updatedAt: NOW.toISOString() }] });
  };

  const queued = (): MoveRequestResult => ({
    pending: true,
    requestId: "req-1",
    holder: HOLDER as MoveRequestResult["holder"],
    dto: row as unknown as MoveRequestResult["dto"],
  });

  const door = (): Answer => {
    if (mode === "refuse") {
      return { status: 403, body: { error: { code: "organizer_only", message: "This install does not organize this mailbox." } } };
    }
    if (mode === "organizer") {
      seq += 1;
      row = { ...row, folder: "ohmail/News" as Folder, updatedAt: NOW.toISOString() };
      return { status: 200, body: row, seq };
    }
    return { status: 202, body: queued() };
  };

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${href.replace(/^https:\/\/api\.test/, "")}`);

    let answer: Answer;
    if (href.includes("/sync?")) {
      const first = href.includes("since=0");
      const page = pages.shift();
      const changes = first && !page
        ? [{ type: "message", op: "create", id: row.id, seq, updatedAt: row.updatedAt, entity: row }]
        : (page?.changes ?? []);
      answer = {
        status: 200,
        body: {
          changes: {
            creates: changes.filter((c) => (c as { op: string }).op === "create"),
            updates: changes.filter((c) => (c as { op: string }).op === "update"),
            moves: changes.filter((c) => (c as { op: string }).op === "move"),
            deletes: changes.filter((c) => (c as { op: string }).op === "delete"),
          },
          cursor: String(seq),
          hasMore: false,
          serverTime: NOW.toISOString(),
        },
      };
    } else if (/\/messages\/[^/]+\/move$/.test(href) && method === "POST") {
      answer = door();
    } else if (/\/messages\/[^/]+$/.test(href) && method === "DELETE") {
      answer = mode === "request"
        ? { status: 202, body: queued() }
        : mode === "refuse"
          ? { status: 403, body: { error: { code: "organizer_only", message: "no" } } }
          : { status: 200, body: { ...row, folder: "Trash" }, seq: ++seq };
    } else {
      answer = { status: 200, body: {} };
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (answer.seq !== undefined) headers["x-sync-seq"] = String(answer.seq);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers });
  }) as unknown as typeof globalThis.fetch;

  const adapter = new HttpAdapter({ baseUrl: "https://api.test", fetch: fetchImpl });
  let clock = NOW;
  const engine = new OhmailEngine({ adapter, now: () => clock });
  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };
  return { engine, requests, organizerApplies, organizerDeletes, advance };
}

const folderOf = (engine: OhmailEngine, id = "m1"): string | undefined =>
  engine.read().get<EngineMessage>("message", id)?.folder;

describe("a 202 {pending:true} is a QUEUED mutation, and an unchanged sync never settles it", () => {
  /**
   * THE HEADLINE. A reader's Move answers 202; the press is waiting on the organizer; the drain
   * that follows carries nothing. Under the shipped code this returned `confirmed` — the phone's
   * "Moved." over a message still in INBOX.
   */
  it("a reader's Move answers 202 → the result is awaiting_organizer, and the drain does not settle it", async () => {
    const { engine } = readerWorld();
    await engine.start();

    const res = await engine.mutate({ kind: "move", messageId: "m1", folder: "ohmail/News" as Folder });

    expect(res.status, "a recorded request reported as a completed move").toBe("awaiting_organizer");
    expect(res.queuedWith).toEqual({ name: HOLDER.name });
    expect(engine.organizerRequests().map((r) => r.messageId)).toEqual(["m1"]);
    expect(folderOf(engine), "nothing moved, and the mirror must say so").toBe("INBOX");

    // AN UNCHANGED SYNC IS NOT NEWS. Absence of a change is not the organizer acting.
    await engine.syncOnce();
    expect(engine.organizerRequests(), "an unchanged sync settled a request nobody carried out").toHaveLength(1);
    expect(folderOf(engine)).toBe("INBOX");
  });

  /** THE POSITIVE CONTROL: the organizer's applied change arrives, and the request settles on it. */
  it("the organizer's applied change settles the request", async () => {
    const { engine, organizerApplies } = readerWorld();
    await engine.start();
    await engine.mutate({ kind: "move", messageId: "m1", folder: "ohmail/News" as Folder });
    expect(engine.organizerRequests()).toHaveLength(1);

    organizerApplies("ohmail/News" as Folder);
    await engine.syncOnce();

    expect(engine.organizerRequests(), "a confirming change did not settle the request").toHaveLength(0);
    expect(folderOf(engine)).toBe("ohmail/News");
  });

  /** DELETE TAKES THE SAME DOOR — the fix is the adapter's, so one verb cannot hold it alone. */
  it("a reader's Delete answers 202 → queued, and the organizer's tombstone settles it", async () => {
    const { engine, organizerDeletes } = readerWorld();
    await engine.start();

    const res = await engine.mutate({ kind: "message_delete", messageId: "m1" });
    expect(res.status).toBe("awaiting_organizer");
    expect(engine.organizerRequests()).toHaveLength(1);

    await engine.syncOnce();
    expect(engine.organizerRequests(), "an unchanged sync settled a queued delete").toHaveLength(1);

    organizerDeletes();
    await engine.syncOnce();
    expect(engine.organizerRequests()).toHaveLength(0);
  });

  /** AN ORGANIZER'S OWN MOVE IS UNCHANGED: 200 + echo settles at once and enters no waiting set. */
  it("an organizer's Move still confirms immediately", async () => {
    const { engine } = readerWorld("organizer");
    await engine.start();

    const res = await engine.mutate({ kind: "move", messageId: "m1", folder: "ohmail/News" as Folder });
    expect(res.status).toBe("confirmed");
    expect(res.queuedWith).toBeUndefined();
    expect(engine.organizerRequests()).toHaveLength(0);
    expect(folderOf(engine)).toBe("ohmail/News");
  });

  /** A REFUSAL STILL REFUSES — a queued state may not swallow the one answer that rolls back. */
  it("a refused Move still rolls back and enters no waiting set", async () => {
    const { engine } = readerWorld("refuse");
    await engine.start();

    const res = await engine.mutate({ kind: "move", messageId: "m1", folder: "ohmail/News" as Folder });
    expect(res.status).toBe("rolled_back");
    expect(engine.organizerRequests()).toHaveLength(0);
    expect(folderOf(engine)).toBe("INBOX");
  });

  /**
   * THE BOUND SAYS SO OUT LOUD AND CHANGES NOTHING ELSE. Past
   * {@link ORGANIZER_REQUEST_SLOW_MS} the surface has a second sentence to say ("Still waiting
   * for the organizer") and the request is still exactly as pending as it was — there is no
   * evidence either way, and manufacturing some at a clock tick is the same defect one timer
   * later.
   */
  it("a request past the stated bound reads slow and STAYS pending", async () => {
    const { engine, advance } = readerWorld();
    await engine.start();
    await engine.mutate({ kind: "move", messageId: "m1", folder: "ohmail/News" as Folder });
    expect(engine.organizerRequests()[0]!.slow).toBe(false);

    advance(ORGANIZER_REQUEST_SLOW_MS);
    await engine.syncOnce();

    const [waiting] = engine.organizerRequests();
    expect(waiting, "the bound dropped the request instead of renaming the wait").toBeDefined();
    expect(waiting!.slow).toBe(true);
    expect(waiting!.messageId).toBe("m1");
    expect(waiting!.queuedWith).toEqual({ name: HOLDER.name });
  });
});
