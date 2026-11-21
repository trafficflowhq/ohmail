import { createRoot } from "react-dom/client";
import { Frame } from "../../../packages/app/src/frame/index.js";
import { MailGround, mailPlaces, mailReader } from "../../../packages/app/src/mail/index.js";
import { TextProvider, type Messages } from "../../../packages/app/src/text/index.js";
import newsEn from "../../../packages/app/messages/news.en.json";
import receiptsEn from "../../../packages/app/messages/receipts.en.json";
import writeEn from "../../../packages/app/messages/write.en.json";
import { bodyDouble, fakeMail, letter, WORDS } from "../../../packages/app/test/reader/support/mail.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeAppearance, fakeWindow } from "../../../packages/app/test/support/fake-window.js";

const query = new URLSearchParams(location.search);
const face = query.get("face") === "ohmarchy" ? "ohmarchy" : "paper";
const look = { face, scheme: "dark" } as const;
document.documentElement.dataset.face = face;
document.documentElement.dataset.theme = look.scheme;

const letters = Array.from({ length: 8 }, (_, i) => letter(`news-${i}`, {
  folder: "ohmail/News",
  date: new Date(Date.UTC(2026, 10, 20 - i, 9)).toISOString(),
}));
const { engine } = fakeMail(letters);
const { host } = fakeHost({
  engine, service: "self", scope: "acct-1",
  address: fakeAddress("#/reads"),
  window: fakeWindow("desktop"),
  appearance: fakeAppearance(look),
  above: MailGround,
  places: mailPlaces(),
  reader: mailReader({ body: bodyDouble().body, look: "none" }),
});

createRoot(document.getElementById("root")!).render(
  <TextProvider locale="en" messages={{ ...WORDS.en, ...newsEn, ...receiptsEn, ...writeEn } as Messages} timeZone="UTC">
    <Frame host={host} />
  </TextProvider>,
);
