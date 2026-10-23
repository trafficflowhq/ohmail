/**
 * The view-switch harness's page (`scripts/perf/view-switch.mjs` bundles and drives it): the real
 * AppShell over a generated mirror, mounted the desktop's way (an engine prop, a FixturesAdapter that
 * also serves html bodies). Local fixtures only; nothing here reaches a network.
 *
 * Query: ?n=Ohbox rows &nr=News rows &nc=Receipts rows &heavy=1 (50 KB newsletters) &bodyMs=body
 * latency &demo=0 &store=full|windowed
 */
import "../../apps/webapp/app/app.css";
import "../../apps/webapp/app/zero-layout.css";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import en from "../../apps/webapp/messages/en.json";
import { AppShell } from "../../apps/webapp/app/shell/AppShell";
import { setActiveCatalog } from "../../apps/webapp/app/shell/locale";
import { resetUiVitalsForTest, takeUiVitals } from "../../apps/webapp/app/shell/ui-vitals";
import { ThemeProvider, ToastHost } from "../../packages/ui/src/index";
import { localStorageDoor } from "../../packages/client-engine/src/durable";
import { OhmailEngine } from "../../packages/client-engine/src/index";
import { FixturesAdapter } from "../../packages/client-engine/src/adapters/fixtures-adapter";
import type { MessageBodyWire } from "../../packages/client-engine/src/index";
import { getFixtures } from "../../packages/fixtures/src/index";
import type { Address, Fixtures, MessageFixture, Folder } from "../../packages/fixtures/src/types";

const THEME_DOOR = localStorageDoor("theme");
const params = new URLSearchParams(window.location.search);
const NO = Number(params.get("n") ?? "3000");
const NR = Number(params.get("nr") ?? "2000");
const NC = Number(params.get("nc") ?? "1000");
const BODY_MS = Number(params.get("bodyMs") ?? "0");
const DEMO = params.get("demo") !== "0";
const STORE = params.get("store") ?? "full";
const HEAVY = params.get("heavy") === "1";

function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const FIRST = ["Lena", "Jonas", "Mara", "Piet", "Nora", "Ivo", "Greta", "Samu", "Anna", "Timo", "Ruth", "Falk"];
const LAST = ["Berg", "Lindt", "Vogel", "Stein", "Kranz", "Moser", "Ebner", "Falke", "Huber", "Weiss"];
const DOMAINS = ["atelier.example", "papierwerk.example", "nordpost.example", "buchbund.example", "werkstatt.example", "kanzlei.example"];
const TOPICS = ["Q3 planning notes", "Invoice for July", "The kiln schedule", "Re: shelf measurements",
  "Newsletter — new arrivals", "Your order has shipped", "Meeting moved to Thursday", "Draft chapter attached"];

/** A designed newsletter (a fixed canvas, so the srcdoc frame). */
function htmlRigid(i: number): string {
  const cell = (t: string) => `<td width="200" style="padding:12px;background:#f6f4ee">${t}</td>`;
  return `<table width="600" cellpadding="0" cellspacing="0" style="width:600px"><tr>` +
    `${cell(`New arrivals ${i}`)}${cell("Two brushes and a gouache set")}${cell("Read on")}` +
    `</tr><tr><td colspan="3" style="padding:20px"><h1>The studio letter</h1>` +
    `<p>${"A paragraph of the letter's own copy, set in the sender's type. ".repeat(12)}</p>` +
    `<table width="560">${Array.from({ length: 8 }, (_, r) => `<tr><td style="padding:6px;border-bottom:1px solid #ddd">Item ${r + 1}</td><td align="right">€${(r * 7 + 3).toFixed(2)}</td></tr>`).join("")}</table>` +
    `</td></tr></table>`;
}
/** A ~50 KB designed newsletter: nested tables, inline styles, remote images (blocked), a pixel. */
function htmlHeavy(i: number): string {
  const block = (k: number) => `<tr><td style="padding:16px 24px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;color:#333333;background-color:#ffffff">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td width="180" valign="top" style="padding-right:12px"><a href="https://news.example/item/${i}/${k}?utm_source=nl&amp;utm_medium=email"><img src="https://cdn.news.example/img/${i}-${k}.jpg" width="180" height="120" alt="Item ${k}" style="display:block;border:0;width:180px;height:120px"></a></td>` +
    `<td valign="top"><h2 style="margin:0 0 8px;font-size:18px;line-height:24px;color:#111111">Story ${k} of issue ${i}: the long headline a newsletter writes</h2>` +
    `<p style="margin:0 0 10px">${"This is the copy of the story, set in the sender's type with inline styles on every element. ".repeat(4)}</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:4px;background-color:#0b5fff"><a href="https://news.example/read/${i}/${k}" style="display:inline-block;padding:8px 14px;color:#ffffff;text-decoration:none;font-weight:bold">Read more</a></td></tr></table>` +
    `</td></tr></table></td></tr>`;
  return `<!doctype html><html><head><style>body{margin:0;padding:0}.x{color:#333}@media (max-width:600px){.m{width:100%!important}}</style></head><body style="margin:0;background-color:#f2f2f2">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2f2f2"><tr><td align="center">` +
    `<table role="presentation" class="m" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px">` +
    `<tr><td style="padding:24px"><img src="https://cdn.news.example/logo.png" width="200" height="50" alt="Logo"></td></tr>` +
    Array.from({ length: 28 }, (_, k) => block(k)).join("") +
    `<tr><td style="padding:24px;font-size:12px;color:#888888">You receive this because you subscribed. <a href="https://news.example/unsub?u=${i}">Unsubscribe</a></td></tr>` +
    `</table></td></tr></table><img src="https://track.news.example/open/${i}.gif" width="1" height="1"></body></html>`;
}
function htmlProse(i: number): string {
  return `<p>Hello,</p><p>The figures for message ${i} are below.</p>` +
    Array.from({ length: 5 }, (_, k) => `<p>Paragraph ${k + 1}: the kiln ran through the night and the second batch came out cleaner than the first.</p>`).join("") +
    `<p>Regards,</p>`;
}

const HTML = new Map<string, string>();
function gen(n: number, folder: Folder, seed: number): MessageFixture[] {
  const rnd = mulberry32(seed);
  const out: MessageFixture[] = [];
  for (let i = 0; i < n; i++) {
    const f = FIRST[Math.floor(rnd() * FIRST.length)]!;
    const l = LAST[Math.floor(rnd() * LAST.length)]!;
    const dom0 = DOMAINS[Math.floor(rnd() * DOMAINS.length)]!;
    const dom = folder === "ohbox" ? `ob-${dom0}` : dom0;
    const topic = TOPICS[Math.floor(rnd() * TOPICS.length)]!;
    const id = `${folder}-${i}`;
    const snippet = `Message ${i} about ${topic.toLowerCase()}. The paragraphs are long enough to cost what a real body costs.`;
    const html = folder === "ohbox" ? null : (i % 4 === 3 ? htmlProse(i) : HEAVY ? htmlHeavy(i) : htmlRigid(i));
    if (html) HTML.set(id, html);
    out.push({
      id, folder,
      from: { name: `${f} ${l}`, address: `${f.toLowerCase()}@${dom}` },
      subject: `${topic} (${i})`,
      snippet,
      ...(folder === "ohbox" ? { body: `Hello,\n\n${snippet}\n\nRegards,\n${f}` } : {}),
      time: `d${Math.floor(i / 3)}`,
      to: [{ name: "Me", address: "me@home.example" } as Address],
      unread: i % 7 === 0,
      ...(folder === "ohbox" && i % 5 === 0 ? { threadCount: 2 + (i % 4) } : {}),
      ...(folder === "receipts" ? { amount: `€${(12 + (i % 90)).toFixed(2)}` } : {}),
    });
  }
  return out;
}

class BodyAdapter extends FixturesAdapter {
  constructor(opts: ConstructorParameters<typeof FixturesAdapter>[0]) {
    super(opts);
    const at = "2026-07-01T00:00:00.000Z";
    // Domain rules so the Ohbox rows stay in the Ohbox under the organizer.
    const emit = (this as unknown as { emit: (t: string, id: string, e: unknown) => void }).emit.bind(this);
    DOMAINS.forEach((d, k) => emit("rule", `vsh-rule-${k}`, {
      id: `vsh-rule-${k}`, kind: "domain", match: `ob-${d}`, destination: "ohbox", priority: 100 + k,
      provenance: "manual", enabled: true, subjectContains: null, bodyContains: null,
      stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: at, updatedAt: at,
    }));
  }
  override async fetchBody(messageId: string): Promise<MessageBodyWire | null> {
    const html = HTML.get(messageId);
    if (html === undefined) return null;
    if (BODY_MS > 0) await new Promise((r) => setTimeout(r, BODY_MS));
    const w = window as unknown as { __bodyFetches?: number };
    w.__bodyFetches = (w.__bodyFetches ?? 0) + 1;
    return { text: `Plain-text alternative for ${messageId}.`, html, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null };
  }
}

function world(): Fixtures {
  const base = getFixtures();
  const reads = gen(NR, "reads", 42);
  const receipts = gen(NC, "receipts", 4242);
  return {
    ...base,
    ohbox: [...base.ohbox, ...gen(NO, "ohbox", 7)],
    reads,
    readsWaterline: { ...base.readsWaterline, newestSeenId: reads[Math.min(10, reads.length - 1)]!.id },
    readsAiChip: { ...base.readsAiChip, afterId: reads[0]!.id },
    receipts,
    receiptsGroups: [],
  };
}

setActiveCatalog("en", en as never);
const engine = new OhmailEngine({
  adapter: new BodyAdapter({ fixtures: world() }),
  storePolicy: STORE === "full" ? { mode: "full" } : { mode: "windowed", days: 90, minRows: 5000, maxRows: 10000 },
});
document.body.className = "mo-canvas app-body";
createRoot(document.getElementById("root")!).render(
  <IntlProvider locale="en" messages={en as never} timeZone="UTC" now={new Date("2026-08-02T09:00:00.000Z")}>
    <ThemeProvider storageKey="ohmail.theme" faces={true} storage={THEME_DOOR}>
      <ToastHost>
        <AppShell demo={DEMO} engine={engine} />
      </ToastHost>
    </ThemeProvider>
  </IntlProvider>,
);
(window as unknown as { __harness: unknown }).__harness = { engine, vitals: takeUiVitals, resetVitals: resetUiVitalsForTest };
