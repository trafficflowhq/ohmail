/**
 * THE LIST-VIEW FRAMES HARNESS: the real `AppShell` over a memory mirror and a scriptable server,
 * in a real browser with the app's stylesheets, so the list surface's states render as a person
 * sees them — the empty panes, the gone notice, a husk moved out of Junk, a drop and the first
 * answer after it. `?view=` picks a view mounted alone (Trash's live sheet, the address view).
 * The rig drives it through `window.__lv`; nothing here reaches a network.
 */
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore, MutationRejectedError, OhmailEngine, mutationEffects,
  type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { AppShell } from "../_todays-shell.js";
import { TrashView } from "../../app/views/TrashView";
import { AddressView } from "../../app/views/AddressView";
import { KeymapProvider } from "@ohmail/app/keys";
import { ListGoneProvider, listGoneFacts } from "../../app/shell/list-view";
import messages from "../../messages/en.json";
import "../../app/app.css";
import "../../app/zero-layout.css";

const NOW = new Date("2026-09-16T09:00:00.000Z");
const ME = "me@example.invalid";
const SENDER = "colleague@example.invalid";
let seq = 0;

const msg = (id: string, o: Partial<EngineMessage> = {}): EngineMessage => ({
  id, accountId: "a1", mailboxId: "mb1", threadId: `t-${id}`, folder: "INBOX",
  subject: `A letter about ${id}`, from: { address: SENDER, name: "The colleague" },
  to: [{ address: ME, name: "Me" }], cc: [], date: "2026-09-16T08:29:00.000Z", unread: false,
  labels: [], snippet: `The opening lines of ${id}`, hasAttachments: false, attachmentCount: 0,
  updatedAt: "2026-09-16T08:29:00.000Z", ...o,
} as unknown as EngineMessage);

const create = (e: unknown, type = "message"): SyncChange =>
  ({ type, op: "create", id: (e as { id: string }).id, seq: ++seq, updatedAt: NOW.toISOString(), entity: e }) as SyncChange;

/** What the rig can do to the world under the shell. */
interface Rig {
  /** The next `/sync` answers with these. */
  pending: SyncChange[];
  /** The store's History doors and the files list fail with a network error while true. */
  wireDown: boolean;
  /** Bodies by id; a `withheld` entry answers the Junk verdict's husk. */
  bodies: Record<string, { text: string } | { withheld: string }>;
  drain: () => Promise<void>;
  tombstone: (id: string) => Promise<void>;
  go: (hash: string) => void;
  ready: boolean;
}

declare global {
  interface Window { __lv: Rig }
}

const q = new URLSearchParams(location.search);
const world = q.get("world") ?? "full";

const rows: EngineMessage[] = world === "empty" ? [] : [
  msg("m1", { labels: ["tg1"] }),
  msg("m2", { labels: ["tg1"], date: "2026-09-16T08:00:00.000Z" }),
  msg("m3", { date: "2026-09-15T08:00:00.000Z" }),
  msg("m4", { folder: "ohmail/News", date: "2026-09-14T08:00:00.000Z", subject: "The weekly notes" }),
  msg("m5", { folder: "INBOX", date: "2026-09-13T08:00:00.000Z", subject: "Moved out of Junk" }),
];

const rig: Rig = {
  pending: [], wireDown: false, ready: false,
  bodies: { m4: { withheld: "junk_filed" } },
  drain: async () => { await engine.syncOnce(); },
  tombstone: async (id) => {
    rig.pending = [{ type: "message", op: "delete", id, seq: ++seq, updatedAt: NOW.toISOString(), entity: null } as unknown as SyncChange];
    await engine.syncOnce();
  },
  go: (hash) => { location.hash = hash; },
};
window.__lv = rig;

const offline = () => new MutationRejectedError("network failure: TypeError: Failed to fetch", { code: "network", retryable: true });
const store = new MemoryMirrorStore();

const engine = new OhmailEngine({
  store,
  now: () => NOW,
  adapter: {
    sync: async () => {
      const page = rig.pending;
      rig.pending = [];
      return {
        changes: { creates: page.filter((c) => c.op !== "delete"), updates: [], moves: [], deletes: page.filter((c) => c.op === "delete") },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      };
    },
    mutate: async (m: EngineMutation) => {
      const changes = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` }).map((e) => ({
        type: e.type, op: e.entity === null ? "delete" : e.move ? "move" : "update",
        id: e.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
      })) as SyncChange[];
      await store.applyChanges(changes);
      return { changes, seq: changes[changes.length - 1]?.seq ?? null };
    },
    fetchBody: async (id: string) => {
      const b = rig.bodies[id];
      if (b && "withheld" in b) return { text: "", html: null, loadedRemoteContent: false, withheld: b.withheld, unsubscribe: "no_header", unsubscribeUrl: null };
      return { text: b?.text ?? `The whole of ${id}, as the mail server holds it.`, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null };
    },
    listMessages: async (_v: unknown, o: { startBelow?: { date: string | null; id: string }; limit?: number }) => {
      if (rig.wireDown) throw offline();
      const below = o.startBelow;
      const all = [...store.list<EngineMessage>("message")].sort((a, b) => (a.date! < b.date! ? 1 : -1));
      const rest = below ? all.filter((m) => m.date! < below.date! || (m.date === below.date && m.id < below.id)) : all;
      return { items: rest.slice(0, o.limit ?? 50), nextCursor: null };
    },
    timeline: async () => {
      if (rig.wireDown) throw offline();
      const all = store.list<EngineMessage>("message");
      return { total: all.length, months: all.length ? [{ month: "2026-09", count: all.length, first: { date: all[0]!.date, id: all[0]!.id } }] : [], undated: 0 };
    },
    listAttachments: async () => {
      if (rig.wireDown) throw offline();
      return [{ id: "a1", filename: "invoice.pdf", contentType: "application/pdf", sizeBytes: 23_000, inline: false, messageId: "m3" }];
    },
    fetchAttachment: async () => new Blob(["%PDF"], { type: "application/pdf" }),
    listTrash: async () => ({ items: [], nextCursor: null }),
    restoreFromTrash: async () => ({ restoreTo: "INBOX", pending: true }),
  },
} as never);

const consentTransport = {
  foldersStorable: true,
  state: async () => ({ seedConfirmedAt: "2026-09-01T00:00:00.000Z", screeningResetAt: null, dormancyDays: 90, foldersEnabledAt: null }),
  setAutoSuggest: async () => ({ autoSuggestAt: null }),
  setDormancyDays: async () => ({}),
  setBlockRemoteImages: async () => ({ blockRemoteImagesAt: null }),
  setBlockTrackingPixels: async () => ({ loadTrackingPixelsAt: null }),
  setBlockAutoUnsubscribe: async () => ({ blockAutoUnsubscribeAt: null }),
  setFoldersEnabled: async () => ({ foldersEnabledAt: null }),
  setMailboxFoldersEnabled: async () => ({ folderMailboxesOff: {} }),
  setMailboxSignature: async () => ({ signatures: {} }),
};
const roster = async () => [{
  id: "mb1", address: ME, status: "connected", errorCode: null, disabledReason: null, syncBlockedReason: null,
  syncBlockedSince: null, lastSyncAt: "2026-09-16T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer" as const, organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
}];

async function boot(): Promise<void> {
  await store.load();
  await store.applyChanges([
    create({ id: "tg1", name: "Invoices", hue: "moss", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }, "tag"),
    create({ id: "tg2", name: "Travel", hue: "sky", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }, "tag"),
    create({ id: "r1", kind: "sender", match: SENDER, destination: "INBOX", enabled: true, createdAt: "2026-09-01T00:00:00.000Z" }, "rule"),
    ...rows.map((m) => create(m)),
  ]);
  const mount = document.getElementById("app")!;
  const intl = (children: unknown) => h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW, children } as never);
  const view = q.get("view");
  if (view === "trash-live") {
    const live = {
      supported: true, phase: "ready", mailboxes: [{ id: "mb1", address: ME, window: "ok" }], nextCursor: null, olderLoading: false,
      items: [{ mailboxId: "mb1", uid: 1, uidValidity: "77", subject: "A receipt the mail server kept", from: { name: "Shop", address: "shop@example.invalid" },
        date: "2026-09-10T10:00:00.000Z", messageIdHeader: "<m@x>", seen: false, origin: "provider" }],
      reload: () => {}, loadOlder: () => {}, openBody: () => {},
      bodyFor: () => ({ phase: "ready", text: "The receipt, read from the mail server's own Trash." }),
    };
    createRoot(mount).render(intl(h(KeymapProvider, { children: h(ListGoneProvider, {
      value: listGoneFacts(() => false, new Set(), null),
      children: h("div", { className: "app-root", children: h(TrashView, {
        page: { available: true, items: [], loading: false, error: null, exhausted: true, loadMore: () => {} },
        live, tags: [], now: NOW, onOpen: () => {}, hydrateBody: () => {}, onAction: () => {}, onAddTag: () => {},
      } as never) }),
    }) })));
  } else if (view === "address-offline") {
    const offlineEngine = new OhmailEngine({
      adapter: { sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: NOW.toISOString() }),
        mutate: async () => ({ changes: [], seq: null }), fetchBody: async () => null } as never,
      now: () => NOW,
      serverAddressSearch: async () => { throw new MutationRejectedError("this install is offline", { status: 503, code: "offline_read_only", retryable: true }); },
    } as never);
    await offlineEngine.start();
    createRoot(mount).render(intl(h(KeymapProvider, { children: h("div", { className: "app-root", children:
      h(AddressView, { engine: offlineEngine, version: 1, now: NOW, address: SENDER, onOpen: () => {} }) }) })));
  } else {
    createRoot(mount).render(intl(h(ThemeProvider, { children: h(ToastHost, {
      children: h(AppShell as never, { demo: false, engine, consentTransport, mailboxFacts: roster } as never),
    }) })));
  }
  rig.ready = true;
}
void boot();
