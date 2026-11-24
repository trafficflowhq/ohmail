/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation, Folder } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { OhmailEngine, MemoryMirrorStore, mutationEffects, type SyncChange } from "@ohmail/client-engine";
import { useScreenerState } from "@ohmail/app-logic/screener/screener-state";
import { useScreenerWords } from "../../../packages/app/src/screener/words.js";
import { inWords, mountPlace } from "../../../packages/app/test/screener/screener-world.js";

const NOW = new Date("2026-08-02T12:00:00.000Z");
let seq = 0;
let sent: EngineMutation[] = [];
function msg(id: string, from: string, hour: number, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

/** An engine over a mirror already holding `held`, with every mutation it issues recorded. */
async function engineWith(held: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    held.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (m) => {
        sent.push(m);
        const changes: SyncChange[] = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` })
          .map((e) => ({
            type: e.type, op: e.move ? "move" : "update", id: e.id, seq: ++seq,
            updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
          }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({ text: "body", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
    },
  });
}

beforeEach(() => { sent = []; });
afterEach(cleanup);

async function mount(engine: OhmailEngine) {
  const { result } = renderHook(
    () => useScreenerState(engine, null, 0, () => {}, useScreenerWords()),
    { wrapper: ({ children }: { children: ReactNode }) => inWords(children) },
  );
  await waitFor(() => expect(result.current.queueSettled).toBe(true));
  mountPlace(result.current, { engine });
  return { latest: () => result.current };
}

describe("SCR-READBOX — the demoting piles have no read/seen checkbox", () => {
  it("the ✓ renders for Ohbox / News / Receipts and NOT for Screen out / Spam", async () => {
    await mount(await engineWith([msg("m0", "stranger@example.com", 11)]));
    const panel = within(screen.getByRole("toolbar", { name: "Actions" }));
    for (const name of ["Ohbox", "News", "Receipts", "Screen out", "Spam"]) {
      expect(panel.getByRole("button", { name })).toBeTruthy();
    }
    fireEvent.click(panel.getByRole("button", { name: "More" }));
    const more = within(screen.getByRole("menu", { name: "More" }));
    expect(more.getAllByRole("menuitem", { name: /, mark read$/ })).toEqual(
      ["Ohbox", "News", "Receipts"].map((dest) => more.getByRole("menuitem", { name: `${dest}, mark read` })),
    );
    expect(more.queryByRole("menuitem", { name: "Screened out, mark read" })).toBeNull();
    expect(more.queryByRole("menuitem", { name: "Spam, mark read" })).toBeNull();
  });

  it("a screened decision taken WITH read:true emits no mark_seen — while News does", async () => {
    const engine = await engineWith([
      msg("a", "screenme@example.com", 11),
      msg("b", "readme@example.com", 10),
    ]);
    const { latest } = await mount(engine);

    const st = latest();
    const waiting = st.waiting;
    expect(waiting.length).toBe(2);
    const a = waiting.find((w) => w.from.address === "screenme@example.com")!;
    const b = waiting.find((w) => w.from.address === "readme@example.com")!;
    // Premise: both are derived rows whose held ids ARE message ids — the shape mark_seen needs,
    // so a green cannot mean "there was nothing to mark".
    expect(a.derived).toBe(true);
    expect(a.held.length).toBeGreaterThan(0);
    const aHeld = a.held.map((held) => held.id);
    const bHeld = b.held.map((held) => held.id);

    await act(async () => {
      // read:true on BOTH. The clamp is the only thing that distinguishes them.
      st.decide(a, "screened", { read: true, scope: "sender", quiet: true });
      st.decide(b, "reads", { read: true, scope: "sender", quiet: true });
      st.flush();
    });
    await waitFor(() => expect(sent.filter((m) => m.kind === "screener_decide")).toHaveLength(2));

    const markSeens = sent.filter((m) => m.kind === "mark_seen");
    // One mark_seen — the Reads decision's — and none for the screened one.
    expect(markSeens).toHaveLength(1);
    const seenIds = markSeens.flatMap((m) => (m as { messageIds: string[] }).messageIds);
    expect(seenIds).toEqual(bHeld);
    for (const id of aHeld) expect(seenIds).not.toContain(id);

    // Both decisions were still FILED — the mail is triaged, only the read flag is clamped.
    expect(sent.filter((m) => m.kind === "screener_decide")).toHaveLength(2);
  });
});
