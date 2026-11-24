/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OhmailEngine, MemoryMirrorStore, mutationEffects, type SyncChange } from "@ohmail/client-engine";
import { COMMIT_MS } from "@ohmail/app-logic/screener/screener-state";
import messages from "../messages/en.json";
import { message } from "./_draft-shell.js";
import { ISO, act, installShellEnv, mailbox, mountShell, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";

const NOW = new Date(ISO);
let seq = 0;
let sent: EngineMutation[] = [];
let host: HTMLElement;
let engine: OhmailEngine;
let arrivals: SyncChange[];

function msg(id: string, from: string): EngineMessage {
  return message(id, {
    accountId: "acct_live_1", mailboxId: "mb", subject: `Subject ${id}`,
    from: { name: null, address: from }, date: ISO, folder: "ohmail/Screener", updatedAt: ISO,
  });
}

async function engineWith(held: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(held.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })));
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => {
        const next = arrivals;
        arrivals = [];
        return {
          changes: {
            creates: next.filter((change) => change.op === "create"),
            deletes: next.filter((change) => change.op === "delete"),
            updates: [], moves: [],
          },
          cursor: next.length ? `c${seq}` : store.getCursor(), hasMore: false, serverTime: ISO,
        };
      },
      mutate: async (m) => {
        sent.push(m);
        const changes: SyncChange[] = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` })
          .map((e) => ({ type: e.type, op: e.move ? "move" : "update", id: e.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}) }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({ text: "body", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
    },
  });
}

async function mount(held: EngineMessage[]) {
  window.location.hash = "#/screener";
  engine = await engineWith(held);
  host = await mountShell([mailbox({
    id: "mb", organizerRole: "organizer", organizeConsentedAt: ISO, lastSyncAt: ISO,
  })], { engine, suggestWire: "none", junkWire: "none" });
  await tick(50);
}
const sections = () => within(host).queryByRole("group", { name: "Screener sections" });
const list = () => within(host).queryByRole("listbox", { name: "Screener" });
const preview = () => within(host).queryByRole("toolbar", { name: "Actions" });
const paragraphText = () => within(host).getAllByRole("paragraph").map((paragraph) => paragraph.textContent);
const row = (id: string) => within(list()!).getByRole("option", { name: new RegExp(`Subject ${id}$`) });
const decisions = () => sent.filter((mutation) => mutation.kind === "screener_decide");

async function press(control: HTMLElement) {
  await act(async () => { control.click(); });
  await tick(0);
}
const decide = () => press(within(preview()!).getByRole("button", { name: "Ohbox" }));

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  vi.stubGlobal("innerWidth", 414);
  arrivals = [];
  sent = [];
  seq = 0;
});
afterEach(async () => {
  await teardownShellEnv();
  vi.unstubAllGlobals();
});

describe("the last decision on a phone lands somewhere", () => {
  it("a phone opens the sender in place of the waiting list", async () => {
    await mount([msg("m1", "one@example.test")]);
    expect(sections()).toBeTruthy();
    expect(preview()).toBeNull();
    await press(row("m1"));
    expect(within(host).getByRole("region", { name: "one@example.test" }).textContent).toContain("Subject m1");
    expect(preview()).toBeTruthy();
    expect(sections()).toBeNull();
    expect(list()).toBeNull();
  });

  it("deciding the only waiting sender returns to the list and draws the 1 decided mark", async () => {
    await mount([msg("m1", "one@example.test")]);
    await press(row("m1"));
    await decide();
    expect(preview()).toBeNull();
    await tick(400);
    expect(paragraphText()).toContain("1 decided");
    expect(within(sections()!).getByRole("button", { name: /^Waiting/, pressed: true })).not.toBeNull();
    await tick(COMMIT_MS + 20_000);
    expect(decisions()).toHaveLength(1);
    expect(preview()).toBeNull();
    expect(paragraphText()).toContain("1 decided");
  });

  it("control: with a second sender waiting the preview advances to it and full mode stays", async () => {
    await mount([msg("m1", "one@example.test"), msg("m2", "two@example.test")]);
    await press(row("m1"));
    expect(within(host).getByRole("region", { name: "one@example.test" }).textContent).toContain("Subject m1");
    await decide();
    await tick(400);
    expect(sections()).toBeNull();
    expect(preview()).toBeTruthy();
    const open = within(host).getByRole("region", { name: "two@example.test" });
    expect(open.textContent).toContain("Subject m2");
    expect(open.textContent).not.toContain("Subject m1");
  });

  it("Undo after the last decision brings the sender back to the list and does not reopen the preview", async () => {
    await mount([msg("m1", "one@example.test")]);
    await press(row("m1"));
    await decide();
    await tick(1000);
    await press(within(host).getByRole("button", { name: "Undo" }));
    expect(row("m1")).not.toBeNull();
    expect(sections()).not.toBeNull();
    expect(preview()).toBeNull();
    await tick(COMMIT_MS * 2);
    expect(decisions()).toHaveLength(0);
  });

  it("a host still holding full with nobody to show (decided elsewhere) is not honoured, and is told", async () => {
    await mount([msg("m1", "one@example.test")]);
    await press(row("m1"));
    expect(preview()).toBeTruthy();
    arrivals = [{ type: "message", op: "delete", id: "m1", seq: ++seq, updatedAt: ISO, entity: null }];
    await act(async () => { await engine.syncOnce(); });
    await tick(400);
    expect(preview()).toBeNull();
    expect(paragraphText()).toContain("No one’s waiting");
    const entity = msg("m2", "two@example.test");
    arrivals = [{ type: "message", op: "create", id: entity.id, seq: ++seq, updatedAt: ISO, entity }];
    await act(async () => { await engine.syncOnce(); });
    await tick(400);
    expect(row("m2")).not.toBeNull();
    expect(preview()).toBeNull();
  });
});
