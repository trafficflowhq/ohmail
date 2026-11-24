/** @vitest-environment jsdom */
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import { useNotice } from "../../src/frame/commands.js";
import type { PaneProps } from "../../src/frame/contract.js";
import { MailGround, mailPlaces, mailReader } from "../../src/mail/index.js";
import { sendingNotice } from "../../src/mail/ground/send-notices.js";
import { newsPlace } from "../../src/news/place.js";
import { StreamList } from "../../src/stream/StreamList.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import newsEn from "../../messages/news.en.json" with { type: "json" };
import { bodyDouble, fakeMail, WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";
import { issue } from "./registered-world.js";

const notice = sendingNotice(
  () => "Sending letter",
  [{ id: "send", key: "compose", state: "sending", to: null, subject: null }],
  () => {},
);

function ListWithSendNotice(props: PaneProps) {
  useNotice(notice);
  return <StreamList {...props} />;
}

afterEach(cleanup);

it("the last News card rests clear of the send notice on a phone", async () => {
  if (newsPlace.panes.kind !== "columns") throw new Error("News needs a list");
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  const letters = [16, 15, 14, 13, 12, 11].map((day) =>
    issue(`issue-${day}`, day, { body: "A paragraph from the issue.\n\n".repeat(8) }),
  );
  const { engine } = fakeMail(letters);
  const { host } = fakeHost({
    engine,
    service: "self",
    scope: "acct-1",
    above: MailGround,
    address: fakeAddress("#/reads"),
    window: fakeWindow("phone"),
    places: {
      ...mailPlaces(),
      news: { ...newsPlace, panes: { ...newsPlace.panes, List: ListWithSendNotice } },
    },
    reader: mailReader({ body: bodyDouble().body, look: "none" }),
  });
  const { container } = render(
    <TextProvider locale="en" messages={{ ...WORDS.en, ...newsEn } as Messages} timeZone="UTC">
      <Frame host={host} />
    </TextProvider>,
  );
  expect((await screen.findByRole("status")).textContent).toContain("Sending letter");
  await screen.findByRole("heading", { name: "Issue 11" });
  const root = [...document.documentElement.attributes]
    .map(({ name, value }) => `${name}="${value}"`)
    .join(" ");
  // Use the browser fixture's bundled styles with the frame and send notice drawn above.
  const bundled = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { readerStatesPage } from "./packages/app/test/states/reader-states.mjs"; process.stdout.write(await readerStatesPage("packages/app/test/states/streams-page.tsx"));',
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const pageHtml = bundled
    .slice(0, bundled.indexOf('<script type="module">'))
    .replace('<html lang="en">', `<html ${root}>`)
    .replace('<div id="root"></div>', () => `<div id="root">${container.innerHTML}</div>`);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`${pageHtml}</body></html>`);
    const stream = page.getByRole("region", { name: "News stream" });
    const last = stream.getByRole("article").filter({ has: page.getByRole("heading", { name: "Issue 11" }) });
    const scroller = stream.locator("[data-reading-scroll]");
    const end = await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    expect(end, "the stream can scroll to its last card").toBeGreaterThan(0);
    const lastCard = await last.boundingBox();
    const shownNotice = await page.getByRole("status").filter({ hasText: "Sending letter" }).boundingBox();
    expect(lastCard).not.toBeNull();
    expect(shownNotice).not.toBeNull();
    expect(lastCard!.y).toBeGreaterThanOrEqual(shownNotice!.y + shownNotice!.height);
    const port = await scroller.boundingBox();
    expect(port).not.toBeNull();
    expect(lastCard!.y).toBeGreaterThanOrEqual(port!.y - 1);
    expect(lastCard!.y + lastCard!.height).toBeLessThanOrEqual(port!.y + port!.height + 1);
  } finally {
    await browser.close();
  }
}, 20_000);
