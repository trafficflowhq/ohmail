import "@ohmail/tokens/tokens.css";
import "@ohmail/tokens/faces.css";
import "@ohmail/tokens/ohmarchy.css";
import "@ohmail/tokens/design/fonts.css";
import { createRoot } from "react-dom/client";
import { MemoryMirrorStore, OhmailEngine, type EngineAdapter } from "@ohmail/client-engine";
import type { EngineMessage } from "@ohmail/wire";
import { Frame } from "@ohmail/app/frame";
import { MailGround, mailPlaces, mailReader } from "@ohmail/app/mail";
import { fragmentAddress } from "@ohmail/app/host/browser";
import { TextProvider, type Messages } from "@ohmail/app/text";
import { letterBody } from "@ohmail/app/reader/body";
import words from "../../messages/en.json";
import { letter } from "../../../../packages/app/test/reader/support/fake-mail.js";
import { fakeHost } from "../../../../packages/app/test/support/fake-host.js";
import { fakeAppearance, fakeWindow } from "../../../../packages/app/test/support/fake-window.js";

const options = new URLSearchParams(location.search);
const unreadCase = options.has("unread");
const letters = Array.from({ length: 48 }, (_, i) => letter(`sample-${i + 1}`, {
  subject: `Glaze sample ${i + 1}`,
  date: new Date(Date.UTC(2026, 10, 20, 19, -i)).toISOString(),
  from: { name: "Ben Arnold", address: "ben@studio.example" },
  snippet: "Can we add the celadon to the next firing?",
  body: (
    "The celadon trials came out of the kiln this morning. Could we add another batch to the next firing?\n\n"
  ).repeat(options.has("long") ? 100 : 1).trimEnd(),
  unread: unreadCase && (i === 1 || i === 2),
  hasAttachments: true,
  folder: i === 0 ? "ohmail/News" : "INBOX",
}));

const mirror = new MemoryMirrorStore();
await mirror.load();
await mirror.applyChanges(letters.map((m, i) => ({
  type: "message", op: "create", seq: i + 1, id: m.id, entity: m, updatedAt: m.updatedAt,
})));
await mirror.applyChanges([{
  type: "rule", op: "create", id: "studio-sender", seq: 49, updatedAt: letters[0]!.updatedAt,
  entity: {
    id: "studio-sender", kind: "sender", match: letters[0]!.from.address, destination: "INBOX",
    priority: 0, enabled: true, provenance: "seeded-from-sent",
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: letters[0]!.updatedAt, updatedAt: letters[0]!.updatedAt,
  },
}]);
let seq = 49;
const adapter: EngineAdapter = {
  sync: async () => ({
    changes: { creates: [], updates: [], moves: [], deletes: [] },
    cursor: "0", hasMore: false, serverTime: letters[0]!.date!,
  }),
  mutate: async (mutation) => {
    const changes = letters.flatMap((original) => {
      const m = mirror.get<EngineMessage>("message", original.id) ?? original;
      const patch = mutation.kind === "mark_seen" && mutation.messageIds.includes(m.id)
        ? { unread: mutation.unread }
        : mutation.kind === "move" && mutation.messageId === m.id
          ? { folder: mutation.folder }
          : null;
      return patch === null ? [] : [{
        type: "message" as const, op: "update" as const, seq: ++seq, id: m.id,
        entity: { ...m, ...patch }, updatedAt: m.updatedAt,
      }];
    });
    return { changes, seq };
  },
  fetchBody: async () => ({
    text: letters[0]!.body!, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
  }),
  withdrawSend: async () => ({ outcome: "unsupported" }),
  searchServer: async (query, { filters }) => {
    const matches = mirror.list<EngineMessage>("message")
      .filter((m) => m.subject.toLowerCase().includes(query.toLowerCase()));
    const items = matches.filter((m) =>
      (filters?.folder === undefined || filters.folder === m.folder) && (!filters?.unread || m.unread));
    const unread = items.filter((m) => m.unread).length;
    const folder: Record<string, number> = {};
    for (const m of matches) folder[m.folder] = (folder[m.folder] ?? 0) + 1;
    return {
      items, total: items.length, totalExact: true, ms: 4, tier: "exact",
      facets: { folder, sender: [], hasAttachments: { true: items.length, false: 0 }, unread: { true: unread, false: items.length - unread } },
    };
  },
};
const engine = new OhmailEngine({ adapter, store: mirror });
const scheme = options.get("scheme") === "dark" ? "dark" : "light";
const viewport = fakeWindow(innerWidth < 700 ? "phone" : "desktop");
viewport.resize(innerWidth, innerHeight);

const { host } = fakeHost({
  engine, service: "self", scope: "acct-1",
  window: viewport, appearance: fakeAppearance({ face: "paper", scheme }), above: MailGround,
  places: mailPlaces(), reader: mailReader({ body: letterBody, look: "none" }),
});
createRoot(document.getElementById("root")!).render(
  <TextProvider locale="en" messages={words as unknown as Messages} timeZone="UTC">
    <Frame host={{
      ...host,
      capabilities: { ...host.capabilities, searchBy: unreadCase ? "people" : host.capabilities.searchBy },
      device: { ...host.device, address: fragmentAddress(window) },
    }} />
  </TextProvider>,
);
