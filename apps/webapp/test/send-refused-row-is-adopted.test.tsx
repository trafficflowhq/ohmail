/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  HttpAdapter, MemoryMirrorStore, OhmailEngine, type EngineMutation, type HttpAdapterOptions, type MirrorStore,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { AUTOSAVE_DELAY_MS } from "../app/shell/compose-autosave";
import type { ComposeFields } from "../app/shell/compose";

/**
 * A SEND REFUSED FOR GOOD LEAVES ONE DRAFT, NOT TWO. A press with no row makes the adapter create
 * one; when the retry under the same key is refused (`409 {status:"failed"}`, the route's own
 * answer for a spent key) the refusal names that row, and the composer's next pause writes into
 * it instead of creating a second. The adapter is the real one over a fake route.
 * Mutation: the `refusedWithRow` fate made a no-op → cases 1 and 2 red on the row count.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const NOW = new Date("2026-09-27T09:00:00.000Z");
/** The real clock, taken before `beforeEach` fakes it. */
const realTimeout = globalThis.setTimeout;
const FAILED_SENTENCE = "A prior send under this key failed and was not delivered.";
let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** The account's side: its draft rows and the reservations its send route keeps per key. */
interface Route {
  rows: Map<string, { body: string; seq: number }>;
  reservations: Map<string, "failed">;
  minted: number;
  /** The first send under a key fails for good, and its answer is lost on the way back. */
  loseFirstAnswer: boolean;
  /** One-shot: the next `POST /drafts` is refused outright, before any row exists. */
  refuseNextCreate: boolean;
  creates: number;
  /** The change log's head, echoed on every write as `X-Sync-Seq`, as the route does. */
  seq: number;
}

const route = (): Route => ({
  rows: new Map(), reservations: new Map(), minted: 0,
  loseFirstAnswer: false, refuseNextCreate: false, creates: 0, seq: 0,
});

const json = (status: number, body: unknown, seq?: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(seq !== undefined ? { "x-sync-seq": String(seq) } : {}) },
  });

/** The draft DTO the route echoes, with the change-log seq the mirror applies it at. */
const dto = (id: string, row: { body: string }, rev: string) => ({
  id, status: "draft", mailboxId: "mb", subject: "Bis Montag", body: row.body,
  to: [{ name: null, address: "lena@atelier.example" }], cc: [], bcc: [],
  updatedAt: NOW.toISOString(), contentRevision: rev,
});

function fakeFetch(r: Route) {
  return async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    // The storage host, as a page whose policy refuses it sees it: the PUT never leaves.
    if (url.startsWith("https://storage.example/")) throw new TypeError("Failed to fetch");
    const path = new URL(url, "http://x").pathname;
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (method === "POST" && path === "/drafts") {
      if (r.refuseNextCreate) {
        r.refuseNextCreate = false;
        return json(403, { error: { code: "forbidden", message: "not allowed", retryable: false } });
      }
      r.creates += 1;
      const id = `d${++r.minted}`;
      r.rows.set(id, { body: String(body.body ?? ""), seq: ++r.seq });
      return json(201, dto(id, r.rows.get(id)!, `${id}-r1`), r.seq);
    }
    const put = /^\/drafts\/([^/]+)$/.exec(path);
    if (method === "PUT" && put) {
      const row = r.rows.get(put[1]!);
      if (!row) return json(404, { error: { code: "not_found", message: "no such draft", retryable: false } });
      row.body = String(body.body ?? row.body);
      row.seq = ++r.seq;
      return json(200, dto(put[1]!, row, `${put[1]}-r${row.seq}`), r.seq);
    }
    const send = /^\/drafts\/([^/]+)\/send$/.exec(path);
    if (method === "POST" && send) {
      const key = init.headers?.["idempotency-key"] ?? "";
      if (r.reservations.get(key) === "failed") return json(409, { status: "failed", message: FAILED_SENTENCE });
      r.reservations.set(key, "failed");
      if (r.loseFirstAnswer) throw new TypeError("Failed to fetch");
      return json(502, { error: { code: "send_rejected", message: "rejected", retryable: false } });
    }
    if (method === "POST" && path === "/attachments/staging") {
      return json(201, { id: "t1", uploadUrl: "https://storage.example/o/t1?token=t", uploadMethod: "PUT", uploadHeaders: {} });
    }
    return json(404, { error: { code: "not_found", message: path, retryable: false } });
  };
}

function engineOver(store: MirrorStore, r: Route, staging: Partial<HttpAdapterOptions> = {}): OhmailEngine {
  const http = new HttpAdapter({ baseUrl: "http://x", fetch: fakeFetch(r) as never, getCookie: () => null, ...staging });
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      /* THE DRAIN SERVES THE ACCOUNT'S ROWS — the change the create logged, which the wake after
         it brings into the mirror. A composer may write only to a row its mirror knows. */
      sync: async () => ({
        changes: {
          creates: [...r.rows].map(([id, row]) => ({
            type: "draft", op: "create", id, seq: row.seq, updatedAt: NOW.toISOString(),
            entity: dto(id, row, `${id}-r${row.seq}`),
          })),
          updates: [], moves: [], deletes: [],
        },
        cursor: String(r.seq), hasMore: false, serverTime: NOW.toISOString(),
      }),
      fetchBody: async () => null,
      mutate: (m: EngineMutation, opts: { idempotencyKey: string; createAttempted?: boolean }) => http.mutate(m, opts),
    } as never,
  });
}

const noToast = (): void => {};

const fieldsFor = (body: string): ComposeFields => ({
  to: "lena@atelier.example, ", cc: "", bcc: "", subject: "Bis Montag",
  body, html: "", fromMailboxId: "mb", sig: null,
} as never);

interface Surface {
  press: (attachments?: unknown[]) => Promise<void>;
  edit: (next: string) => Promise<void>;
  draftId: () => string | null;
  phase: () => string;
}

/** The compose surface's two hooks over one engine, wired the way `shell-compose.ts` wires them. */
async function surface(engine: OhmailEngine, body: string): Promise<Surface> {
  const { useMailSend, SEND_IN_FLIGHT_PHASES, sendPendingInOutbox } = await import("../app/shell/mail-send.js");
  const { useComposeAutosave } = await import("../app/shell/compose-autosave.js");
  const { writeComposeDraft } = await import("../app/shell/compose.js");
  writeComposeDraft(fieldsFor(body));
  let api!: Surface;
  const Probe = (): null => {
    const [fields, setF] = React.useState<ComposeFields>(fieldsFor(body));
    const fateRef = React.useRef<(fate: never) => void>(() => {});
    const mail = useMailSend(
      engine as never,
      // STABLE, as the shell's is: a toast re-made per render re-makes the retry driver, and its
      // effect's cleanup then cancels the retry timer for good.
      noToast as never,
      (() => {}) as never,
      ((key: string, _m: unknown, accepted: boolean, _phase: unknown, detail?: { left?: { rowId: string; aboutThisCompose: boolean } }) => {
        const left = detail?.left;
        if (!accepted && left && key === "compose") {
          fateRef.current({ kind: "refusedWithRow", rowId: left.rowId, aboutThisCompose: left.aboutThisCompose } as never);
        }
        return false;
      }) as never,
    );
    const autosave = useComposeAutosave({
      engine: engine as never, fields, mailboxId: "mb", active: true,
      sendInFlight: SEND_IN_FLIGHT_PHASES.has(mail.stateOf("compose").phase)
        || sendPendingInOutbox(engine as never, "compose")
        || mail.restoredPending("compose"),
      onCleared: () => {},
    });
    fateRef.current = autosave.settleCompose as never;
    api = {
      press: async (attachments?: unknown[]) => {
        await act(async () => {
          (mail.send as unknown as (m: Record<string, unknown>) => void)({
            kind: "mail_send", inReplyTo: null, body: fields.body, subject: fields.subject,
            to: [{ name: null, address: "lena@atelier.example" }], mailboxId: "mb",
            ...(autosave.draftId ? { draftId: autosave.draftId } : {}),
            ...(attachments ? { attachments } : {}),
          });
        });
      },
      edit: async (next: string) => {
        await act(async () => {
          setF((f) => {
            const n = { ...f, body: next };
            writeComposeDraft(n);
            return n;
          });
        });
      },
      draftId: () => autosave.draftId,
      phase: () => mail.stateOf("compose").phase,
    };
    return null;
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe),
    }));
  });
  return {
    press: (a) => api.press(a), edit: (n) => api.edit(n),
    draftId: () => api.draftId(), phase: () => api.phase(),
  };
}

async function killTab(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
}

const drain = async (n = 24): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1); });
};
const pause = async (): Promise<void> => {
  await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 200); });
  await drain();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  window.localStorage.clear();
});
afterEach(async () => {
  await killTab();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("a send the server refused for good", () => {
  it("1 — the retry refused under its key: the composer writes into the row the send made", async () => {
    const r = route();
    r.loseFirstAnswer = true;
    const store = new MemoryMirrorStore();
    await store.load();
    const engine = engineOver(store, r);
    const s = await surface(engine, "Kommst du noch?");
    await act(async () => { await engine.start(); });
    await s.press();
    await drain();
    expect(s.phase(), "the lost answer did not leave the send queued").toBe("queued");
    expect([...r.rows.keys()], "the press carried no row, so the adapter makes one").toEqual(["d1"]);

    // The retry driver's first beat: the same key, answered by the route's own refusal.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    await drain();
    expect(s.phase(), "the replay under the spent key was not refused").toBe("failed");
    await act(async () => { await engine.syncOnce(); });

    await s.edit("Kommst du noch? Bis 18 Uhr.");
    await pause();
    expect(
      [...r.rows.keys()],
      "the composer saved a second draft beside the one the refused send left",
    ).toEqual(["d1"]);
    expect(s.draftId(), "the composer is not bound to the row the refusal named").toBe("d1");
    expect(r.rows.get("d1")?.body, "the edit did not reach the adopted row").toBe("Kommst du noch? Bis 18 Uhr.");
  });

  it("2 — the send restored at the next open is refused: no row is created after the refusal", async () => {
    const r = route();
    r.loseFirstAnswer = true;
    const store = new MemoryMirrorStore();
    await store.load();
    const first = engineOver(store, r);
    const s1 = await surface(first, "Kommst du noch?");
    await act(async () => { await first.start(); });
    await s1.press();
    await drain();
    expect(s1.phase()).toBe("queued");
    await killTab();

    // The reload: the queued send carries the row its create made (RESTORED-ROWLESS-SEND-REPLAY-
    // MAKES-ANOTHER-ROW, closed), so the replay sends that row and makes no second one.
    const second = engineOver(store, r);
    const s2 = await surface(second, "Kommst du noch?");
    await act(async () => { await second.start(); });
    await drain();
    const before = r.creates;
    expect(before, "the boot replay made a second row for one message").toBe(1);
    await act(async () => { await second.syncOnce(); });

    await s2.edit("Kommst du noch? Bis 18 Uhr.");
    await pause();
    expect(r.creates - before, "the composer created a row beside the one the refused replay named").toBe(0);
    expect(s2.draftId(), "the composer is not bound to the row the refusal named").toBe("d1");
  });

  it("3 — an upload this page may not make ends the send: the composer takes its row and makes none", async () => {
    // Tester round 46: a 5 MB send whose PUT the page's policy refused stayed queued for ever,
    // and Compose held it. The adapter is told what the page admits, and storage is not it.
    const r = route();
    const store = new MemoryMirrorStore();
    await store.load();
    const engine = engineOver(store, r, { stageAttachments: true, uploadAdmits: () => false });
    const s = await surface(engine, "Die Pläne im Anhang.");
    await act(async () => { await engine.start(); });
    const plans = { filename: "plans.pdf", contentType: "application/pdf", contentBase64: Buffer.alloc(4 * 1024 * 1024, 7).toString("base64") };
    await s.press([plans]);
    // The file's digest is the platform's own work, done on the real clock.
    for (let i = 0; i < 200 && s.phase() === "sending"; i++) {
      await act(async () => { await new Promise((ok) => { realTimeout(ok, 10); }); await vi.advanceTimersByTimeAsync(1); });
    }
    expect(s.phase(), "the refused upload left the send waiting, holding the composer").toBe("failed");
    await act(async () => { await engine.syncOnce(); });

    await s.edit("Die Pläne im Anhang, kleiner.");
    await pause();
    expect(r.creates, "the composer made a second row beside the one the send left").toBe(1);
    expect(s.draftId(), "the composer is not bound to the row the refusal named").toBe("d1");
  });

  it("CONTROL: a refusal that names no row leaves the composer making its own", async () => {
    const r = route();
    r.refuseNextCreate = true;
    const store = new MemoryMirrorStore();
    await store.load();
    const engine = engineOver(store, r);
    const s = await surface(engine, "Kommst du noch?");
    await act(async () => { await engine.start(); });
    await s.press();
    await drain();
    expect(s.phase(), "the refused create did not end the press").toBe("failed");
    expect(r.rows.size, "a refused create made a row").toBe(0);

    await s.edit("Kommst du noch? Bis 18 Uhr.");
    await pause();
    expect([...r.rows.keys()], "the composer did not save the message it is holding").toEqual(["d1"]);
    expect(s.draftId()).toBe("d1");
  });
});
