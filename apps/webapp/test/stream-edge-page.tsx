import type { EngineMessage } from "@ohmail/wire";
import { createRoot } from "react-dom/client";
import { Frame } from "../../../packages/app/src/frame/index.js";
import { MailGround, mailPlaces, mailReader } from "../../../packages/app/src/mail/index.js";
import { TextProvider, type Messages } from "../../../packages/app/src/text/index.js";
import newsEn from "../../../packages/app/messages/news.en.json";
import newsDe from "../../../packages/app/messages/news.de.json";
import receiptsEn from "../../../packages/app/messages/receipts.en.json";
import writeEn from "../../../packages/app/messages/write.en.json";
import { bodyDouble, fakeMail, letter, WORDS } from "../../../packages/app/test/reader/support/mail.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeAppearance, fakeWindow } from "../../../packages/app/test/support/fake-window.js";

const query = new URLSearchParams(location.search);
const locale = query.has("recipients") ? "de" : "en";
const face = query.get("face") === "ohmarchy" ? "ohmarchy" : "paper";
const scheme = query.get("scheme") === "light" ? "light" : "dark";
const look = { face, scheme } as const;
document.documentElement.dataset.face = face;
document.documentElement.dataset.theme = look.scheme;

const geometry = query.has("geometry");
const place = query.get("geometry") === "receipts" ? "receipts" : "reads";
const letters = Array.from({ length: geometry ? 2 : 8 }, (_, i) => letter(`news-${i}`, {
  folder: place === "receipts" ? "ohmail/Receipts" : "ohmail/News",
  ...(geometry && place === "receipts" ? {
    amount: "CHF 36.00",
    from: { name: "Open-Air Kino Seeblick", address: "tickets@kino-seeblick.example.test" },
  } : {}),
  ...(geometry ? {
    subject: i === 0 ? "Short letter" : "Long letter",
    body: i === 0 ? (query.has("waiting") ? undefined : "One line of mail.") : Array.from({ length: 30 }, () => "One line of mail.").join("\n"),
  } : {}),
  ...(i === 0 ? { threadId: "example-thread" } : {}),
  ...(i === 0 && query.has("recipients") ? {
    to: ["Adelheid Stephanie Winterfeld", "Theodor Maximilian Mühlenberg", "Cora"].map((name, n) => ({
      name,
      address: `recipient-${n}@example.test`,
    })),
  } : {}),
  date: new Date(Date.UTC(2026, 10, 20 - i, 9)).toISOString(),
}));
const bodies = query.has("waiting") ? { "news-0": { state: "loading" } } : {};
const { engine, add } = fakeMail(letters, [], bodies, query.has("filing") ? {
  "view_meta:reads_waterline": { newestSeenId: "news-7", at: letters[7]!.date },
  "view_meta:reads_ai_chip": {
    afterId: "news-0",
    label: "News — AI 0.87: newsletter fingerprint",
    approvedLabel: "Approved",
    correctedLabel: "Corrected",
  },
} : {});
window.addEventListener("example-reply", () => {
  add(letter("example-reply", {
    folder: "Sent" as EngineMessage["folder"],
    threadId: "example-thread",
    local: true,
    date: new Date(Date.UTC(2026, 10, 20, 10)).toISOString(),
  }));
});
const viewport = fakeWindow("desktop");
if (geometry || query.has("filing")) {
  viewport.resize(innerWidth, innerHeight, matchMedia("(pointer: coarse)").matches ? "coarse" : "fine");
}
const { host } = fakeHost({
  engine, service: "self", scope: "acct-1",
  address: fakeAddress(query.has("linked") ? "#/reads/m/news-1" : `#/${place}`),
  window: viewport,
  ...(query.has("delivery") ? { mailboxes: async () => [
    { id: "mb-1", address: "work@example.test", displayName: "Work", status: "connected" },
    { id: "mb-2", address: "personal@example.test", displayName: "Personal", status: "connected" },
  ] } : {}),
  appearance: fakeAppearance(look),
  above: MailGround,
  places: mailPlaces(),
  reader: mailReader({ body: bodyDouble().body, look: "none" }),
});

createRoot(document.getElementById("root")!).render(
  <TextProvider locale={locale} messages={{ ...WORDS[locale], ...(locale === "de" ? newsDe : newsEn), ...receiptsEn, ...writeEn } as Messages} timeZone="UTC">
    <Frame host={host} />
  </TextProvider>,
);
