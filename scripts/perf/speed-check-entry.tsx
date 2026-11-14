/**
 * The page of the two speed checks (`open-letter.mjs`, `search-first.mjs`; `speed-check.mjs` bundles
 * and drives it): the real AppShell over planted mail, mounted the desktop's way (an engine prop, a
 * FixturesAdapter that also serves bodies). Planted mail only; nothing here reaches a network.
 *
 * Query: ?n=messages in the mirror (half Ohbox, a third News, a sixth Receipts, the view-switch
 * fixture's shares) &bodyMs=the adapter's body latency (0).
 *
 * The Ohbox's letters come in three kinds, in turn down the list, because a reader does different
 * work for each: `plain` (text, already in the mirror), `prose` (a short HTML letter, fetched) and
 * `designed` (a 50 KB newsletter of nested tables, fetched). Every fifteenth subject carries a rare
 * word and every letter a common one, so a search has both a short and a long answer.
 */
import "../../apps/webapp/app/app.css";
import "../../apps/webapp/app/zero-layout.css";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import en from "../../apps/webapp/messages/en.json";
import { AppShell } from "../../apps/webapp/app/shell/AppShell";
import { setActiveCatalog } from "../../apps/webapp/app/shell/locale";
import { resetUiVitalsForTest, takeUiVitals } from "@ohmail/app-logic/session/ui-vitals";
import { ThemeProvider, ToastHost } from "../../packages/ui/src/index";
import { localStorageDoor } from "../../packages/client-engine/src/durable";
import { OhmailEngine } from "../../packages/client-engine/src/index";
import { FixturesAdapter } from "../../packages/testing/src/adapters/fixtures-adapter";
import type { MessageBodyWire } from "../../packages/client-engine/src/index";
import { getFixtures } from "../../packages/testing/src/index";
import type { Address, Fixtures, Folder, MessageFixture } from "../../packages/testing/src/types";

const params = new URLSearchParams(window.location.search);
const N = Math.max(60, Number(params.get("n") ?? "5000"));
const BODY_MS = Number(params.get("bodyMs") ?? "0");
const OHBOX = Math.round(N / 2);
const NEWS = Math.round(N / 3);
const RECEIPTS = N - OHBOX - NEWS;

const KINDS = ["plain", "prose", "designed"] as const;
type Kind = (typeof KINDS)[number];
/** One unread letter in seven, as the view-switch fixture has it; the kinds take turns among those. */
const UNREAD_EVERY = 7;
const kindOf = (i: number): Kind => KINDS[Math.floor(i / UNREAD_EVERY) % KINDS.length]!;

const FIRST = ["Lena", "Jonas", "Mara", "Piet", "Nora", "Ivo", "Greta", "Samu", "Anna", "Timo", "Ruth", "Falk"];
const LAST = ["Berg", "Lindt", "Vogel", "Stein", "Kranz", "Moser", "Ebner", "Falke", "Huber", "Weiss"];
const DOMAINS = ["atelier.example", "papierwerk.example", "nordpost.example", "buchbund.example", "werkstatt.example", "kanzlei.example"];
const TOPICS = ["Planning notes for the quarter", "Invoice for July", "The kiln schedule", "Shelf measurements",
  "New arrivals this week", "Your order has shipped", "Meeting moved to Thursday", "Draft chapter attached"];
/** In every letter's text; in one subject of fifteen. */
const COMMON = "studio";
const RARE = "quince";

function prose(i: number): string {
  return `<p>Hello,</p><p>The figures for letter ${i} are below.</p>` +
    Array.from({ length: 5 }, (_, k) => `<p>Paragraph ${k + 1}: the kiln ran through the night and the second batch came out cleaner than the first.</p>`).join("") +
    `<p>Regards,</p>`;
}
/** About 50 KB: nested tables, inline styles, remote images (never fetched), a pixel. */
function designed(i: number): string {
  const block = (k: number) => `<tr><td style="padding:16px 24px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;color:#333333;background-color:#ffffff">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td width="180" valign="top" style="padding-right:12px"><a href="https://news.example/item/${i}/${k}?utm_source=nl&amp;utm_medium=email"><img src="https://cdn.news.example/img/${i}-${k}.jpg" width="180" height="120" alt="Item ${k}" style="display:block;border:0;width:180px;height:120px"></a></td>` +
    `<td valign="top"><h2 style="margin:0 0 8px;font-size:18px;line-height:24px;color:#111111">Story ${k} of issue ${i}: the long headline a newsletter writes</h2>` +
    `<p style="margin:0 0 10px">${"This is the copy of the story, set in the sender's type with inline styles on every element. ".repeat(4)}</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:4px;background-color:#0b5fff"><a href="https://news.example/read/${i}/${k}" style="display:inline-block;padding:8px 14px;color:#ffffff;text-decoration:none;font-weight:bold">Read more</a></td></tr></table>` +
    `</td></tr></table></td></tr>`;
  return `<!doctype html><html><head><style>body{margin:0;padding:0}@media (max-width:600px){.m{width:100%!important}}</style></head><body style="margin:0;background-color:#f2f2f2">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2f2f2"><tr><td align="center">` +
    `<table role="presentation" class="m" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px">` +
    `<tr><td style="padding:24px"><img src="https://cdn.news.example/logo.png" width="200" height="50" alt="Logo"></td></tr>` +
    Array.from({ length: 28 }, (_, k) => block(k)).join("") +
    `<tr><td style="padding:24px;font-size:12px;color:#888888">You receive this because you subscribed. <a href="https://news.example/unsub?u=${i}">Unsubscribe</a></td></tr>` +
    `</table></td></tr></table><img src="https://track.news.example/open/${i}.gif" width="1" height="1"></body></html>`;
}

/** Bodies the adapter serves; a letter not in here carries its text in the mirror. */
const HTML = new Map<string, string>();

function plant(n: number, folder: Folder): MessageFixture[] {
  const out: MessageFixture[] = [];
  for (let i = 0; i < n; i++) {
    const first = FIRST[i % FIRST.length]!;
    const last = LAST[(i * 7) % LAST.length]!;
    const domain = DOMAINS[(i * 5) % DOMAINS.length]!;
    const topic = TOPICS[(i * 3) % TOPICS.length]!;
    const id = `${folder}-${i}`;
    const kind: Kind = folder === "ohbox" ? kindOf(i) : i % 4 === 3 ? "prose" : "designed";
    const snippet = `Letter ${i} from the ${COMMON}, about ${topic.toLowerCase()}. The paragraphs are long enough to cost what a real body costs.`;
    if (kind !== "plain") HTML.set(id, kind === "prose" ? prose(i) : designed(i));
    out.push({
      id, folder,
      /* The Ohbox's senders write from their own domains, which the rules below keep in the Ohbox. */
      from: { name: `${first} ${last}`, address: `${first.toLowerCase()}@${folder === "ohbox" ? "ob-" : ""}${domain}` },
      subject: `${topic}${i % 15 === 0 ? ` and the ${RARE}` : ""} (${i})`,
      snippet,
      ...(kind === "plain" ? { body: `Hello,\n\n${snippet}\n\nRegards,\n${first}` } : {}),
      time: `d${Math.floor(i / 3)}`,
      to: [{ name: "Me", address: "me@home.example" } as Address],
      unread: i % UNREAD_EVERY === 0,
      ...(folder === "receipts" ? { amount: `€${(12 + (i % 90)).toFixed(2)}` } : {}),
    });
  }
  return out;
}

class PlantedAdapter extends FixturesAdapter {
  constructor(opts: ConstructorParameters<typeof FixturesAdapter>[0]) {
    super(opts);
    const at = "2026-07-01T00:00:00.000Z";
    const emit = (this as unknown as { emit: (t: string, id: string, e: unknown) => void }).emit.bind(this);
    DOMAINS.forEach((d, k) => emit("rule", `speed-rule-${k}`, {
      id: `speed-rule-${k}`, kind: "domain", match: `ob-${d}`, destination: "ohbox", priority: 100 + k,
      provenance: "manual", enabled: true, subjectContains: null, bodyContains: null,
      stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: at, updatedAt: at,
    }));
  }
  override async fetchBody(messageId: string): Promise<MessageBodyWire | null> {
    const html = HTML.get(messageId);
    if (html === undefined) return null;
    if (BODY_MS > 0) await new Promise((r) => setTimeout(r, BODY_MS));
    return { text: `Plain-text alternative for ${messageId}.`, html, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null };
  }
}

function world(): Fixtures {
  const base = getFixtures();
  const reads = plant(NEWS, "reads");
  return {
    ...base,
    ohbox: [...base.ohbox, ...plant(OHBOX, "ohbox")],
    reads,
    readsWaterline: { ...base.readsWaterline, newestSeenId: reads[Math.min(10, reads.length - 1)]!.id },
    readsAiChip: { ...base.readsAiChip, afterId: reads[0]!.id },
    receipts: plant(RECEIPTS, "receipts"),
    receiptsGroups: [],
  };
}

setActiveCatalog("en", en as never);
const engine = new OhmailEngine({ adapter: new PlantedAdapter({ fixtures: world() }), storePolicy: { mode: "full" } });
document.body.className = "mo-canvas app-body";
createRoot(document.getElementById("root")!).render(
  <IntlProvider locale="en" messages={en as never} timeZone="UTC" now={new Date("2026-08-02T09:00:00.000Z")}>
    <ThemeProvider storageKey="ohmail.theme" faces={true} storage={localStorageDoor("theme")}>
      <ToastHost>
        <AppShell demo={false} engine={engine} />
      </ToastHost>
    </ThemeProvider>
  </IntlProvider>,
);
(window as unknown as { __speed: unknown }).__speed = {
  planted: N,
  words: { common: COMMON, rare: RARE, sender: FIRST[1], two: "kiln schedule" },
  /** The kind of a planted Ohbox letter, or `null` for any other row (the sample world's own). */
  kindOf: (id: string): Kind | null => {
    const m = /^ohbox-(\d+)$/.exec(id);
    return m ? kindOf(Number(m[1])) : null;
  },
  vitals: takeUiVitals,
  resetVitals: resetUiVitalsForTest,
};
