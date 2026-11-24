/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import {
  MutationRejectedError, OhmailEngine, OUTBOX_BACKOFF_CAP_MS,
  OUTBOX_MAX_SERVER_FAILURES, intentOf, ohboxView, sendAndDonePlanFor,
  type MutationResult, type SendAndDonePlan,
} from "@ohmail/client-engine";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";
import {
  releaseSendAndDone, SendReleaseProvider, useSendRelease, type SendRelease,
} from "@ohmail/app-logic/writing/send-release";
import { UnsavedListOf } from "../../../packages/app/src/mail/ground/UnsavedList.js";
import { TextProvider, type Messages } from "../../../packages/app/src/text/index.js";
import frameEn from "../../../packages/app/messages/frame.en.json" with { type: "json" };
import mailboxesEn from "../../../packages/app/messages/mailboxes.en.json" with { type: "json" };
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

// Try again in the frame's unsaved list must complete the action originally requested, including filing a letter after its send is confirmed.
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

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  host?.remove();
  host = null;
});

/** The list's words: the sync namespace of the frame's file, and the mailboxes' one sentence it borrows. */
const LIST_WORDS = { sync: frameEn.sync, mailboxes: mailboxesEn.mailboxes } as unknown as Messages;

/** The ground's list as `UnsavedList` binds it: the composer's release from the provider above, the case's rows. */
function ListUnderTheShell({ rows, onRetry }: {
  rows: ReturnType<OhmailEngine["abandoned"]>;
  onRetry: (id: string) => Promise<MutationResult>;
}) {
  const release = useSendRelease();
  return (
    <UnsavedListOf
      open
      onClose={() => {}}
      title=""
      abandoned={rows}
      queued={[]}
      onRetry={onRetry}
      onDiscard={async () => {}}
      onRetryQueued={async () => null}
      onDiscardQueued={async () => {}}
      release={release}
    />
  );
}

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
    // Open the unsaved list from the notice. Its retry reads the release provider above it.
    const list = <ListUnderTheShell rows={rows} onRetry={onRetry} />;
    act(() => {
      root!.render(
        <TextProvider locale="en" messages={LIST_WORDS} timeZone="UTC">
          {release === null ? list : <SendReleaseProvider value={release}>{list}</SendReleaseProvider>}
        </TextProvider>,
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

  // The unsaved list is mounted once inside the writing release provider so retry can complete the original filing plan.
  it("the list's one mount sits under the shell's release provider, which the compose hook's door feeds", () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx$/.test(e.name) ? [join(dir, e.name)] : []);
    const mounts = walk(`${ROOT}/packages/app/src`).flatMap((f) => {
      const text = withoutComments(readFileSync(f, "utf8"));
      return [...text.matchAll(/<UnsavedList\b/g)].map((m) => ({ f, text, at: m.index! }));
    });
    expect(mounts, "the new shell mounts the list of the changes that did not go through once").toHaveLength(1);
    const { text, at } = mounts[0]!;
    const open = text.indexOf("<SendReleaseProvider value={");
    const close = text.indexOf("</SendReleaseProvider>");
    expect(open).toBeGreaterThan(0);
    expect(at > open && at < close, "the list is drawn outside the release provider").toBe(true);
    const ground = readFileSync(`${ROOT}/packages/app/src/mail/ground/WritingMount.tsx`, "utf8");
    expect(ground).toContain("<SendReleaseProvider value={compose.releaseConfirmed}>");
    const compose = withoutComments(readFileSync(`${ROOT}/packages/app-logic/src/writing/shell-compose.ts`, "utf8"));
    expect(compose).toContain("return releaseSendAndDone({");
    expect(compose).toContain("onSendOutcome(res.key,");
  });

  /* RE-POINTED BY PATH (the join): the list's binding to the engine is the ground's `UnsavedList`. */
  it("is wired to the engine's retry, with nothing between", () => {
    const src = readFileSync(`${ROOT}/packages/app/src/mail/ground/UnsavedList.tsx`, "utf8");
    expect(src).toContain("onRetry={(id) => engine.retryAbandoned(id)}");
  });
});
