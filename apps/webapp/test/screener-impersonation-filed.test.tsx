/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine, MemoryMirrorStore, type AutoFiledItemWire, type EngineMessage, type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import { createEngine } from "../app/shell/engine-config.js";
import { impersonationSeenKey } from "../app/shell/impersonation-filed.js";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * "N LETTERS THAT CLAIMED TO BE A COMPANY WENT TO SPAM" — the Screener's one quiet line (owner,
 * 2026-11-09). The organizer files such a letter on its own; the person sees it here, with each
 * letter's reason and Put back, and OK lets the line go on this device until the next filing. A
 * filing for any other reason is not this line's, and a door that cannot say draws nothing.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const NOW = new Date("2026-11-09T12:00:00.000Z");
let seq = 0;

function held(id: string, from: string, folder: EngineMessage["folder"] = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-11-09T09:00:00.000Z", folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-11-09T09:00:00.000Z",
  };
}

const PHISH: AutoFiledItemWire = {
  messageId: "p1", from: "billing@hosting-renewals.example", subject: "Erinnerung: Zahlungsinformationen",
  to: "ohmail/Quarantine", filedAt: "2026-11-09T11:00:00.000Z", why: "impersonation", brand: "Metanet",
};
const ACT: AutoFiledItemWire = {
  messageId: "a1", from: "deals@shop.example", subject: "Sale", to: "ohmail/Quarantine",
  filedAt: "2026-11-09T11:30:00.000Z", why: null, brand: null,
};

let filed: AutoFiledItemWire[] = [];
let undone: Array<readonly string[]> = [];
/** What the next pull carries, and how many times the line's list was read. */
let incoming: SyncChange[] = [];
let reads = 0;
/** Set, the next reads wait for it: a read still in the air when more filings land. */
let gate: Promise<void> | null = null;

async function engineWith(door: boolean): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([held("m0", "stranger@example.test")].map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: incoming.splice(0), updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
      ...(door
        ? {
          autoFiled: async () => {
            reads++;
            if (gate !== null) await gate;
            return { items: filed, more: false };
          },
          undoAutoFiled: async (ids: readonly string[]) => {
            undone.push(ids);
            filed = filed.filter((i) => !ids.includes(i.messageId));
            return { putBack: [...ids], requested: [] };
          },
        }
        : {}),
    } as never,
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  filed = [PHISH, ACT];
  undone = [];
  incoming = [];
  reads = 0;
  gate = null;
  try { localStorage.removeItem(impersonationSeenKey()); } catch { /* none to clear */ }
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

const created = (m: EngineMessage): SyncChange =>
  ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m });

async function pull(engine: OhmailEngine): Promise<void> {
  await act(async () => { await engine.syncOnce(); });
  await flush();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}

async function mount(engine: OhmailEngine): Promise<void> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state = useScreenerState(engine, v, (() => {}) as never);
    return h(ScreenerView, {
      owed: false, state, segment: "waiting", settled: true,
      selection: { waiting: null, screened: null, spam: null } as never, onSelect: () => {},
      hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {},
    } as never);
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(ThemeProvider, { storageKey: null, children: h(KeymapProvider, { children: h(Probe) }) }),
      }),
    );
  });
  await flush();
  await settleFirstPaint();
}

const line = (): HTMLElement | null => host!.querySelector(".scn-impersonated");
const button = (text: string): HTMLElement => {
  const hits = [...(line()?.querySelectorAll<HTMLElement>("button") ?? [])].filter((b) => (b.textContent ?? "").trim() === text);
  if (hits.length !== 1) throw new Error(`${hits.length} buttons read "${text}"`);
  return hits[0]!;
};
const press = async (el: HTMLElement): Promise<void> => {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
};

describe("the Screener's line for letters filed to Spam for claiming a company", () => {
  it("counts only the impersonation filings, and Review gives each its reason and Put back", async () => {
    await mount(await engineWith(true));
    expect(line()?.querySelector(".scn-held-lead")?.textContent).toBe("1 letter that claimed to be a company went to Spam");
    expect(line()?.textContent ?? "").not.toContain("deals@shop.example");
    await press(button("Review"));
    const text = line()?.textContent ?? "";
    expect(text).toContain("billing@hosting-renewals.example · Erinnerung: Zahlungsinformationen");
    expect(text).toContain("This message claims to be from Metanet, but hosting-renewals.example isn't one of Metanet's addresses.");
    await press(button("Put back"));
    expect(undone).toEqual([["p1"]]);
    expect(line(), "the line stays after its letter went back").toBeNull();
  });

  it("OK lets the line go on this device until a newer filing", async () => {
    await mount(await engineWith(true));
    await press(button("OK"));
    expect(line()).toBeNull();
    expect(localStorage.getItem(impersonationSeenKey())).toBe(PHISH.filedAt);
    await act(async () => { root!.unmount(); });
    root = null;
    host?.remove();
    await mount(await engineWith(true));
    expect(line(), "an acknowledged filing came back").toBeNull();
    await act(async () => { root!.unmount(); });
    root = null;
    host?.remove();
    filed = [...filed, { ...PHISH, messageId: "p2", filedAt: "2026-11-09T11:45:00.000Z" }];
    await mount(await engineWith(true));
    expect(line()?.querySelector(".scn-held-lead")?.textContent).toBe("1 letter that claimed to be a company went to Spam");
  });

  it("a letter the organizer files while the Screener is open shows in the line and Review at once", async () => {
    filed = [ACT];
    const engine = await engineWith(true);
    await mount(engine);
    expect(line()).toBeNull();
    filed = [PHISH, ACT];
    incoming = [created(held("p1", PHISH.from!, "ohmail/Quarantine"))];
    await pull(engine);
    expect(line()?.querySelector(".scn-held-lead")?.textContent).toBe("1 letter that claimed to be a company went to Spam");
    await press(button("Review"));
    expect(line()?.textContent ?? "").toContain("billing@hosting-renewals.example · Erinnerung: Zahlungsinformationen");
    expect(undone).toEqual([]);
    await press(button("Put back"));
    expect(undone).toEqual([["p1"]]);
  });

  it("asks again only when Spam's letters change, and once for filings landing during a read", async () => {
    filed = [ACT];
    const engine = await engineWith(true);
    await mount(engine);
    const first = reads;
    incoming = [created(held("m9", "another@example.test"))];
    await pull(engine);
    expect(reads, "a pull that filed nothing to Spam asked again").toBe(first);
    let open!: () => void;
    gate = new Promise<void>((r) => { open = r; });
    for (const id of ["q1", "q2", "q3"]) {
      incoming = [created(held(id, `${id}@example.test`, "ohmail/Quarantine"))];
      await pull(engine);
    }
    expect(reads, "each filing during the read asked on its own").toBe(first + 1);
    filed = [PHISH, ACT];
    gate = null;
    await act(async () => { open(); });
    await flush();
    expect(reads, "the filings during the read were not asked about after it").toBe(first + 2);
    expect(line()?.querySelector(".scn-held-lead")?.textContent).toBe("1 letter that claimed to be a company went to Spam");
  });

  it("a door that cannot say draws nothing", async () => {
    await mount(await engineWith(false));
    expect(line()).toBeNull();
  });

  it("the engine the product builds carries both calls through its gate", () => {
    const engine = createEngine(false, { NEXT_PUBLIC_API_BASE: "/api" });
    const adapter = (engine as unknown as { adapter: Record<string, unknown> }).adapter;
    expect(typeof adapter.autoFiled).toBe("function");
    expect(typeof adapter.undoAutoFiled).toBe("function");
  });
});
