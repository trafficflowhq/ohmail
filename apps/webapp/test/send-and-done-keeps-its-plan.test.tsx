/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  DEMO_NOW, FixturesAdapter, MutationRejectedError, OhmailEngine, OUTBOX_BACKOFF_CAP_MS,
  OUTBOX_MAX_SERVER_FAILURES, intentOf, ohboxView, sendAndDonePlanFor,
  type EngineMessage, type EngineMutation, type MutationResult, type SendAndDonePlan,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { UnsavedChangesList } from "../app/shell/UnsavedChanges";
import { releaseSendAndDone, SendReleaseProvider, type SendRelease } from "../app/shell/send-release";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * SEND + DONE KEEPS ITS PLAN ON THE WEB. Rows: SEND-AND-DONE-LATE-RELEASE-APPLIES-THE-PRESS-TIME-PLAN
 * (the web half) and WEB-STRIP-RETRY-DROPS-THE-SEND-AND-DONE-RELEASE. The demo fixtures are the
 * mirror; only the send route is faked, unreachable or answering 500 by `mode`. The door is the
 * shell's own (`releaseSendAndDone`), read at the release.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ROOT = process.cwd();

type Mode = "offline" | "fail500" | "ok";
function scene() {
  const inner = new FixturesAdapter({ now: () => DEMO_NOW });
  const net: { mode: Mode } = { mode: "ok" };
  const clock = { t: DEMO_NOW.getTime() };
  const wire: EngineMutation[] = [];
  const engine = new OhmailEngine({
    now: () => new Date(clock.t),
    adapter: {
      sync: inner.sync.bind(inner),
      fetchBody: inner.fetchBody.bind(inner),
      mutate: async (m: EngineMutation, o: { idempotencyKey: string }) => {
        if (m.kind === "mail_send" && net.mode === "offline") {
          throw new MutationRejectedError("network failure", { code: "network", retryable: true });
        }
        if (m.kind === "mail_send" && net.mode === "fail500") {
          throw new MutationRejectedError("internal error", { status: 500, code: "internal", retryable: true });
        }
        wire.push(m);
        return inner.mutate(m, o);
      },
    } as never,
  });
  return { engine, net, clock, wire, inner };
}
type Scene = ReturnType<typeof scene>;

const reply = (inReplyTo: string): EngineMutation =>
  ({ kind: "mail_send", inReplyTo, body: "Donnerstag passt." }) as unknown as EngineMutation;
const unreadOf = (engine: OhmailEngine, id: string): boolean | undefined =>
  engine.read().get<EngineMessage>("message", id)?.unread;
const marks = (s: Scene) => s.wire.filter((m) => m.kind === "mark_seen");
const sends = (s: Scene) => s.wire.filter((m) => m.kind === "mail_send");
const intentFor = (s: Scene, src: string): SendAndDonePlan => intentOf(sendAndDonePlanFor(s.engine.read(), src)!, src);
const applied = async (s: Scene, m: EngineMutation) => (await s.engine.mutate(m)).status !== "rolled_back";

/** The shell's door over a confirmed result, as `shell-compose.ts` `releaseConfirmed` reaches it. */
function door(s: Scene, said: EngineMutation[][]): SendRelease {
  return (res) => {
    if (res.status !== "confirmed" || res.andDone === undefined) return;
    releaseSendAndDone({ presented: s.engine.read(), intent: res.andDone, dispatch: (m) => applied(s, m), say: (u) => said.push(u) });
  };
}
const settleAll = async () => { for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); }); };

async function sourceIn(engine: OhmailEngine): Promise<string> {
  await engine.start();
  const src = ohboxView(engine.read()).newForYou.find((m) => sendAndDonePlanFor(engine.read(), m.id) !== null);
  if (!src) throw new Error("no New row offers Send + Done in the fixtures");
  return src.id;
}

/** A Send + Done that went queued, and the change the person made before it went. */
async function lateRelease(after: (s: Scene, src: string) => Promise<void>) {
  const s = scene();
  const src = await sourceIn(s.engine);
  s.net.mode = "offline";
  const queued = await s.engine.mutate(reply(src), { andDone: intentFor(s, src) });
  expect(queued.status).toBe("queued");
  await after(s, src);
  s.net.mode = "ok";
  const [r] = (await s.engine.flushPending()).filter((x) => x.key === queued.key);
  expect(r?.status).toBe("confirmed");
  const said: EngineMutation[][] = [];
  const released = releaseSendAndDone({ presented: s.engine.read(), intent: r!.andDone!, dispatch: (m) => applied(s, m), say: (u) => said.push(u) });
  await settleAll();
  return { s, src, released, said };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  host?.remove();
  host = null;
});

describe("a Send + Done released later reads the mirror at the release", () => {
  it("a source filed elsewhere after the press is not marked read, and no Undo is offered", async () => {
    const { s, src, released, said } = await lateRelease(async (s, src) => {
      expect((await s.engine.mutate({ kind: "move", messageId: src, folder: "ohmail/Receipts" } as EngineMutation)).status).toBe("confirmed");
      expect(sendAndDonePlanFor(s.engine.read(), src), "premise: the filed source left the Ohbox").toBeNull();
    });
    expect(marks(s), "the press-time plan marked read a message filed elsewhere after the press").toEqual([]);
    expect(released, "the door said it released over nothing").toBe(false);
    expect(said).toEqual([]);
    expect(unreadOf(s.engine, src)).toBe(true);
    expect(sends(s)).toHaveLength(1);
  });

  it("a source read elsewhere after the press is not released again, and no Undo is offered", async () => {
    const { s, released, said } = await lateRelease(async (s, src) => {
      await s.engine.mutate({ kind: "mark_seen", messageIds: intentFor(s, src).messageIds, unread: false } as EngineMutation);
      expect(sendAndDonePlanFor(s.engine.read(), src), "premise: the source reads as done").toBeNull();
    });
    expect(marks(s), "a release ran over a row already read").toHaveLength(1);
    expect(released).toBe(false);
    expect(said).toEqual([]);
  });

  it("a source pinned after the press is released with the pin spent, and Undo pins it again", async () => {
    const { s, src, released, said } = await lateRelease(async (s, src) => {
      await s.engine.mutate({ kind: "triage_set", messageId: src, state: "resurfaced" } as EngineMutation);
      expect(sendAndDonePlanFor(s.engine.read(), src)?.section, "premise: the source is pinned").toBe("resurfaced");
    });
    expect(released).toBe(true);
    expect(marks(s)).toHaveLength(1);
    expect(sendAndDonePlanFor(s.engine.read(), src), "the pin was not spent").toBeNull();
    expect(said).toHaveLength(1);
    for (const m of said[0]!) await s.engine.mutate(m);
    expect(sendAndDonePlanFor(s.engine.read(), src)?.section, "Undo did not put the pin back").toBe("resurfaced");
  });

  it("CONTROL: an unchanged source is filed once, and its Undo puts it back unread in New", async () => {
    const { s, src, released, said } = await lateRelease(async () => undefined);
    expect(released).toBe(true);
    expect(sends(s)).toHaveLength(1);
    expect(marks(s)).toHaveLength(1);
    expect(unreadOf(s.engine, src)).toBe(false);
    expect(said).toHaveLength(1);
    for (const m of said[0]!) await s.engine.mutate(m);
    expect(unreadOf(s.engine, src)).toBe(true);
    expect(sendAndDonePlanFor(s.engine.read(), src)?.section).toBe("new");
  });
});

describe("the reply's own discharge and the release, over one source", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(DEMO_NOW); window.localStorage.clear(); });
  afterEach(() => { vi.useRealTimers(); });

  async function lane(s: Scene, said: EngineMutation[][], toasts: string[]) {
    const { useMailSend } = await import("../app/shell/mail-send.js");
    let api!: { send: (m: unknown, o?: unknown) => void };
    const Probe = (): null => {
      const mail = useMailSend(
        s.engine as never, ((m: string) => toasts.push(m)) as never, (() => {}) as never,
        ((_k: string, _m: unknown, accepted: boolean, _p: unknown, detail?: { andDone?: SendAndDonePlan }) => {
          if (detail?.andDone === undefined || !accepted) return false;
          return releaseSendAndDone({ presented: s.engine.read(), intent: detail.andDone, dispatch: (m) => applied(s, m), say: (u) => said.push(u) });
        }) as never,
      );
      api = { send: (m, o) => (mail.send as unknown as (a: unknown, b?: unknown) => void)(m, o) };
      return null;
    };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC" now={DEMO_NOW}><Probe /></NextIntlClientProvider>);
    });
    return (m: unknown, o?: unknown) => api.send(m, o);
  }
  const drain = async (n = 40) => { for (let i = 0; i < n; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1); }); };

  it("a pinned source is read once, by the release, which says its Undo", async () => {
    const s = scene();
    const src = await sourceIn(s.engine);
    await s.engine.mutate({ kind: "triage_set", messageId: src, state: "resurfaced" } as EngineMutation);
    expect(sendAndDonePlanFor(s.engine.read(), src)?.section).toBe("resurfaced");
    const said: EngineMutation[][] = [];
    const toasts: string[] = [];
    const send = await lane(s, said, toasts);
    const before = marks(s).length;
    await act(async () => { send(reply(src), { andDone: intentFor(s, src) }); });
    await drain();
    expect(sends(s)).toHaveLength(1);
    expect(marks(s).length - before, "the discharge and the release both read the source").toBe(1);
    expect(said, "the release found the source already read by the discharge, and said no Undo").toHaveLength(1);
    expect(toasts, "Reply sent. was raised over Sent · marked done").toEqual([]);
  });

  /**
   * The guard alone decides here: the release's FIRST step clears the other member's booking, so
   * the pin on the source is still standing when `settle` would discharge it. With the discharge
   * not standing down, the source is read twice.
   */
  it("a pinned row whose release clears a booking first is still read once", async () => {
    const iso = DEMO_NOW.toISOString();
    const msg = (id: string, date: string, state: string) => ({
      id, accountId: "a", mailboxId: "mb", threadId: "thread-9", messageIdHeader: `<${id}@x>`, subject: "Plan",
      from: { name: "Ada", address: "ada@fake.test" }, to: [], cc: [], date, arrivedAt: date, folder: "INBOX",
      snippet: "", unread: true, hasAttachments: false, attachmentCount: 0, labels: [], remoteContent: "none",
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: { messageId: id, state, bubbleUpAt: state === "bubbled_up" ? "2026-01-01T00:00:00.000Z" : null, setAt: iso, updatedAt: iso },
      updatedAt: iso,
    });
    const rows = [msg("p1", "2026-08-01T09:00:00.000Z", "resurfaced"), msg("p2", "2026-08-02T09:00:00.000Z", "bubbled_up")];
    let n = 0;
    const change = (type: string, id: string, entity: unknown) => ({ type, op: "create", id, seq: ++n, updatedAt: iso, entity });
    let served = false;
    const wire: EngineMutation[] = [];
    const engine = new OhmailEngine({
      now: () => DEMO_NOW,
      adapter: {
        sync: async () => {
          const creates = served ? [] : [
            ...rows.map((m) => change("message", m.id, m)),
            ...rows.map((m) => change("message_state", m.id, m.triage)),
          ];
          served = true;
          return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: String(n), hasMore: false, serverTime: iso };
        },
        fetchBody: async () => null,
        mutate: async (m: EngineMutation) => {
          wire.push(m);
          return m.kind === "mail_send"
            ? { changes: [], seq: null, entityId: "d1", providerMessageId: "<d1@x>" }
            : { changes: [], seq: null };
        },
      } as never,
    });
    await engine.start();
    const offered = sendAndDonePlanFor(engine.read(), "p1");
    expect(offered?.section, "premise: the source stands in a pinned row").toBe("resurfaced");
    expect(offered?.mutations[0]?.kind, "premise: the release clears a booking before it reads").toBe("triage_set");
    const s = { engine, wire } as unknown as Scene;
    const said: EngineMutation[][] = [];
    const toasts: string[] = [];
    const send = await lane(s, said, toasts);
    await act(async () => { send(reply("p1"), { andDone: intentOf(offered!, "p1") }); });
    await drain();
    expect(wire.filter((m) => m.kind === "mail_send")).toHaveLength(1);
    expect(wire.filter((m) => m.kind === "mark_seen"), "the discharge and the release both read the source").toHaveLength(1);
    expect(said).toHaveLength(1);
  });

  it("a reply clears its whole conversation from Answer later, and leaves Parked alone", async () => {
    const s = scene();
    const src = await sourceIn(s.engine);
    const m = s.engine.read().get<EngineMessage>("message", src)!;
    const emit = (s.inner as unknown as { emit: (t: string, id: string, e: unknown) => void }).emit.bind(s.inner);
    emit("message", src, { ...m, threadId: "TQ" });
    for (const id of ["q2", "q3"]) emit("message", id, { ...m, id, threadId: "TQ", unread: false });
    await s.engine.syncOnce();
    for (const [id, state] of [[src, "reply_later"], ["q2", "reply_later"], ["q3", "set_aside"]] as const) {
      await s.engine.mutate({ kind: "triage_set", messageId: id, state } as EngineMutation);
    }
    const send = await lane(s, [], []);
    await act(async () => { send(reply(src)); });
    await drain();
    expect(sends(s)).toHaveLength(1);
    const cleared = s.wire.filter((x) => x.kind === "triage_set" && (x as { state?: string }).state === "none")
      .map((x) => (x as { messageId: string }).messageId).sort();
    expect(cleared, "every message of the Answer later row, nothing parked").toEqual([src, "q2"].sort());
  });

  it("a source parked after the press gets the discharge, and no Done", async () => {
    const s = scene();
    const src = await sourceIn(s.engine);
    const said: EngineMutation[][] = [];
    const toasts: string[] = [];
    const send = await lane(s, said, toasts);
    s.net.mode = "offline";
    await act(async () => { send(reply(src), { andDone: intentFor(s, src) }); });
    await drain();
    await s.engine.mutate({ kind: "triage_set", messageId: src, state: "reply_later" } as EngineMutation);
    expect(sendAndDonePlanFor(s.engine.read(), src), "premise: the parked source left the Ohbox").toBeNull();
    s.net.mode = "ok";
    // Coming back online is the lane's own flush road.
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await drain();
    expect(sends(s)).toHaveLength(1);
    expect(s.wire.filter((m) => m.kind === "triage_set" && (m as { state?: string }).state === "none"), "the reply's debt was not discharged").toHaveLength(1);
    expect(marks(s)).toEqual([]);
    expect(said).toEqual([]);
    expect(toasts).toEqual(["Reply sent."]);
  });
});

describe("Try again on the strip", () => {
  async function abandoned() {
    const s = scene();
    const src = await sourceIn(s.engine);
    s.net.mode = "fail500";
    await s.engine.mutate(reply(src), { andDone: intentFor(s, src) });
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 2 && s.engine.abandoned().length === 0; i++) {
      s.clock.t += OUTBOX_BACKOFF_CAP_MS + 1;
      await s.engine.flushPending();
    }
    const rows = s.engine.abandoned();
    expect(rows[0]?.mutation.kind, "the send was not given up on").toBe("mail_send");
    s.net.mode = "ok";
    return { s, src, rows };
  }
  async function pressTryAgain(rows: ReturnType<OhmailEngine["abandoned"]>, s: Scene, release: SendRelease | null) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const results: MutationResult[] = [];
    // Wired as `UnsavedChanges` wires it (asserted below).
    const onRetry = async (id: string) => { const r = await s.engine.retryAbandoned(id); results.push(r); return r; };
    const list = <UnsavedChangesList abandoned={rows} onRetry={onRetry} onDiscard={async () => {}} />;
    act(() => {
      root!.render(
        <NextIntlClientProvider locale="en" messages={messages}>
          {release === null ? list : <SendReleaseProvider value={release}>{list}</SendReleaseProvider>}
        </NextIntlClientProvider>,
      );
    });
    const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]");
    if (toggle && toggle.getAttribute("aria-expanded") === "false") act(() => { toggle.click(); });
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Try again");
    expect(retry, "no Try again on the strip").toBeTruthy();
    await act(async () => { retry!.click(); });
    await settleAll();
    return results;
  }

  it("files the source of a Send + Done it confirms, once, and says its Undo", async () => {
    const { s, src, rows } = await abandoned();
    const said: EngineMutation[][] = [];
    const results = await pressTryAgain(rows, s, door(s, said));
    expect(results[0]?.status, "Try again did not confirm the send").toBe("confirmed");
    expect(sends(s), "the retry did not deliver exactly once").toHaveLength(1);
    expect(unreadOf(s.engine, src), "Try again confirmed the Send + Done and filed nothing").toBe(false);
    expect(marks(s)).toHaveLength(1);
    expect(said).toHaveLength(1);
    for (const m of said[0]!) await s.engine.mutate(m);
    expect(unreadOf(s.engine, src), "the strip's Undo did not put the source back").toBe(true);
  });

  it("CONTROL: with no shell above it, the strip delivers once and releases nothing", async () => {
    const { s, src, rows } = await abandoned();
    const results = await pressTryAgain(rows, s, null);
    expect(results[0]?.status).toBe("confirmed");
    expect(sends(s)).toHaveLength(1);
    expect(unreadOf(s.engine, src)).toBe(true);
  });

  it("is wired to the engine's retry, with nothing between", () => {
    const src = readFileSync(`${ROOT}/apps/webapp/app/shell/UnsavedChanges.tsx`, "utf8");
    expect(src).toContain("onRetry={(id) => engine.retryAbandoned(id)}");
  });
});

describe("one door on the web", () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []);

  it("the release is applied in send-release.tsx alone, and no carried plan is applied anywhere", () => {
    const calls: string[] = [];
    for (const f of walk(`${ROOT}/apps/webapp/app`)) {
      const text = withoutComments(readFileSync(f, "utf8"));
      for (const m of text.matchAll(/\bapplySendAndDone\(|(?<![A-Za-z.])sendAndDone\(/g)) calls.push(`${f.slice(ROOT.length)}:${m.index}`);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("app/shell/send-release.tsx");
  });

  it("both strip mounts sit under the shell's release provider, which the compose hook's door feeds", () => {
    const shell = readFileSync(`${ROOT}/apps/webapp/app/shell/AppShell.tsx`, "utf8");
    const open = shell.indexOf("<SendReleaseProvider value={releaseConfirmed}>");
    const close = shell.indexOf("</SendReleaseProvider>");
    const mounts = [...shell.matchAll(/<UnsavedChanges variant=/g)].map((m) => m.index!);
    expect(open).toBeGreaterThan(0);
    expect(mounts).toHaveLength(2);
    for (const at of mounts) expect(at > open && at < close, "a strip mount is outside the release provider").toBe(true);
    const compose = withoutComments(readFileSync(`${ROOT}/apps/webapp/app/shell/shell-compose.ts`, "utf8"));
    expect(compose).toContain("return releaseSendAndDone({");
    expect(compose).toContain("onSendOutcome(res.key,");
  });
});
