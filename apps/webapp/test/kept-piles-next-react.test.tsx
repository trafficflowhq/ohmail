/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { Messages } from "@ohmail/app/text";
import frameEn from "../../../packages/app/messages/frame.en.json";
import newsEn from "../../../packages/app/messages/news.en.json";
import receiptsEn from "../../../packages/app/messages/receipts.en.json";

/** Render the registered frame with the React and renderer used by the Next App Router. */
const asBundled = (m: object): object => new Proxy({ ...m }, { has: () => true });
vi.mock("react", async () => asBundled(await import("next/dist/compiled/react" as string)));
vi.mock("react/jsx-runtime", async () => asBundled(await import("next/dist/compiled/react/jsx-runtime" as string)));
vi.mock("react/jsx-dev-runtime", async () => asBundled(await import("next/dist/compiled/react/jsx-dev-runtime" as string)));
vi.mock("react-dom", async () => asBundled(await import("next/dist/compiled/react-dom" as string)));

const React = await import("react");
const { createRoot } = (await import("next/dist/compiled/react-dom/client" as string)) as typeof import("react-dom/client");
const { Frame } = await import("@ohmail/app/frame");
const { MailGround, mailPlaces } = await import("@ohmail/app/mail");
const { TextProvider } = await import("@ohmail/app/text");
const { fakeMail, WORDS, letter } = await import("../../../packages/app/test/reader/support/mail.js");
const { fakeHost } = await import("../../../packages/app/test/support/fake-host.js");
const { fakeAddress, fakeWindow } = await import("../../../packages/app/test/support/fake-window.js");
const { stubDom } = await import("./_draft-shell.js");

const act = React.act;
const h = React.createElement;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;
const region = (name: string) => host?.querySelector<HTMLElement>(`[role="region"][aria-label="${name}"]`) ?? null;
const stream = (name: "News" | "Receipts") => region(`${name} stream`);
const failure = () => region(frameEn.viewError.title);
const words = { ...WORDS.en, ...newsEn, ...receiptsEn } as Messages;

async function start() {
  stubDom();
  localStorage.clear();
  const inbox = letter("inbox", { folder: "INBOX", unread: true, subject: "Ohbox control" });
  const mail = fakeMail([
    inbox,
    letter("news", { folder: "ohmail/News", unread: true, subject: "First news" }),
    letter("receipt", { folder: "ohmail/Receipts", unread: true, subject: "A receipt" }),
  ], [], {}, {
    "rule:known": {
      id: "known", kind: "sender", match: inbox.from.address, destination: "INBOX",
      priority: 0, manual: true, enabled: true, createdAt: inbox.date,
    },
  });
  const address = fakeAddress("#/reads");
  const { host: frameHost } = fakeHost({
    engine: mail.engine, service: "self", scope: "acct-1", above: MailGround, places: mailPlaces(),
    address, window: fakeWindow("desktop"),
  });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => {
    root!.render(h(TextProvider, { locale: "en", messages: words, timeZone: "UTC", children: h(Frame, { host: frameHost }) }));
  });
  const go = (fragment: string) => act(async () => { await address.visit(fragment); });
  return { mail, go };
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = undefined;
  host = undefined;
  vi.restoreAllMocks();
});

describe("News and Receipts under Next's own React", () => {
  it("is the vendored React this test renders with", () => {
    const vendored = createRequire(import.meta.url)("next/dist/compiled/react") as { version: string };
    expect(React.version).toBe(vendored.version);
  });

  it("News, the Ohbox, Receipts and News again all draw, with no failure card", async () => {
    const { go } = await start();
    expect(stream("News")?.textContent).toContain("First news");
    expect(failure()).toBeNull();

    await go("#/ohbox");
    expect(stream("News")).toBeNull();
    expect(host?.textContent).toContain("Ohbox control");
    expect(failure()).toBeNull();

    await go("#/receipts");
    expect(stream("Receipts")?.textContent).toContain("A receipt");
    expect(stream("News")).toBeNull();
    expect(failure()).toBeNull();

    await go("#/reads");
    expect(stream("Receipts")).toBeNull();
    expect(stream("News")?.textContent).toContain("First news");
    expect(host!.querySelectorAll('[aria-label="News stream"]')).toHaveLength(1);
    expect(failure()).toBeNull();
  });

  it("an inactive pile cannot read or take focus and includes changes on return", async () => {
    const { go, mail } = await start();
    const oldNews = stream("News")!;
    expect(oldNews.textContent).toContain("First news");
    await go("#/receipts");
    expect(oldNews.isConnected).toBe(false);
    expect(stream("News")).toBeNull();
    expect(region("Receipts")?.querySelector('[role="option"]')?.textContent).toContain("A receipt");

    await act(async () => {
      mail.patch("news", { subject: "Updated news" });
      window.dispatchEvent(new Event("scroll"));
    });
    expect(mail.mutations).toEqual([]);
    const menu = region("Receipts")!.querySelector<HTMLButtonElement>('button[aria-label="List"]')!;
    await act(async () => { menu.click(); });
    const markAll = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.startsWith("Mark all read"));
    expect(markAll).toBeDefined();
    await act(async () => { markAll!.click(); });
    expect(mail.mutations.filter((m) => m.kind === "mark_seen").map((m) => m.messageIds)).toEqual([["receipt"]]);
    expect(mail.mutations.filter((m) => m.kind === "feed_mark_seen").map((m) => m.view)).toEqual(["receipts"]);

    await go("#/reads");
    expect(stream("News")?.textContent).toContain("Updated news");
    expect(stream("News")?.textContent).not.toContain("First news");
    expect(stream("Receipts")).toBeNull();
    expect(failure()).toBeNull();
  });
});
