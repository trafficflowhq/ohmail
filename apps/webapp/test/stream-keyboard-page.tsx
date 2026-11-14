import { createRoot } from "react-dom/client";
import { Frame } from "../../../packages/app/src/frame/index.js";
import { MailGround, mailPlaces, mailReader } from "../../../packages/app/src/mail/index.js";
import { TextProvider, type Messages } from "../../../packages/app/src/text/index.js";
import newsEn from "../../../packages/app/messages/news.en.json";
import receiptsEn from "../../../packages/app/messages/receipts.en.json";
import writeEn from "../../../packages/app/messages/write.en.json";
import { bodyDouble, fakeMail, letter, WORDS } from "../../../packages/app/test/reader/support/mail.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";

const query = new URLSearchParams(location.search);
const receipts = query.get("place") === "receipts";
const folder = receipts ? "ohmail/Receipts" : "ohmail/News";
const { engine } = fakeMail([
  letter("short", { folder, subject: "Short letter", body: "One line of mail.", threadId: "thread" }),
  letter("long", { folder, subject: "Long letter", body: "Another line of mail.\n".repeat(30), date: "2026-11-09T09:00:00.000Z" }),
  ...Array.from({ length: query.has("older") ? 22 : 0 }, (_, i) => letter(`older-${i}`, {
    folder,
    subject: `Older letter ${i}`,
    body: "A visible line of an older letter.\n".repeat(30),
    date: new Date(Date.UTC(2026, 9, 25 - i, 9)).toISOString(),
  })),
]);
const emptyFiles: ReturnType<typeof engine.attachmentsOf> = { state: "ready", items: [] };
engine.attachmentsOf = () => emptyFiles;
engine.loadAttachments = async () => emptyFiles;
engine.forwardPartsAnnounced = async () => true;

const viewport = fakeWindow(innerWidth < 700 ? "phone" : "desktop");
viewport.resize(innerWidth, innerHeight);
const { host } = fakeHost({
  engine, service: "self", scope: "acct-1",
  address: fakeAddress(receipts ? "#/receipts" : "#/reads"),
  window: viewport,
  above: MailGround,
  places: mailPlaces(),
  reader: mailReader({ body: bodyDouble().body, look: "none" }),
});

createRoot(document.getElementById("root")!).render(
  <TextProvider locale="en" messages={{ ...WORDS.en, ...newsEn, ...receiptsEn, ...writeEn } as Messages} timeZone="UTC">
    <Frame host={host} />
  </TextProvider>,
);
