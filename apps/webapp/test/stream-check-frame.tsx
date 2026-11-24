import { act, cleanup, render } from "@testing-library/react";
import { onTestFinished, vi } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import { Frame } from "../../../packages/app/src/frame/Frame.js";
import { MailGround, mailPlaces, mailReader } from "../../../packages/app/src/mail/index.js";
import { letterBody } from "../../../packages/app/src/reader/body/index.js";
import { TextProvider, type Messages } from "../../../packages/app/src/text/index.js";
import frameEn from "../../../packages/app/messages/frame.en.json";
import frameDe from "../../../packages/app/messages/frame.de.json";
import newsEn from "../../../packages/app/messages/news.en.json";
import newsDe from "../../../packages/app/messages/news.de.json";
import receiptsEn from "../../../packages/app/messages/receipts.en.json";
import receiptsDe from "../../../packages/app/messages/receipts.de.json";
import { WORDS } from "../../../packages/app/test/reader/support/mail.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";

export const STREAM_DATE = "2026-08-20T12:00:00.000Z";

export function stubStreamDom() {
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  HTMLElement.prototype.scrollTo ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
}

export async function mountCheckedStream(
  engine: OhmailEngine,
  route: string,
  locale: "en" | "de" = "en",
  mailboxes?: Parameters<typeof fakeHost>[0]["mailboxes"],
) {
  stubStreamDom();
  localStorage.clear();
  onTestFinished(() => {
    cleanup();
    engine.dispose?.();
    vi.unstubAllGlobals();
  });
  const address = fakeAddress(route);
  const { host } = fakeHost({
    engine,
    service: "self",
    scope: "stream-test",
    places: mailPlaces(),
    above: MailGround,
    reader: mailReader({ body: letterBody, look: "none" }),
    window: fakeWindow("desktop"),
    address,
    ...(mailboxes ? { mailboxes } : {}),
  });
  const messages = {
    ...WORDS[locale],
    rail: (locale === "de" ? frameDe : frameEn).rail,
    ...(locale === "de" ? newsDe : newsEn),
    ...(locale === "de" ? receiptsDe : receiptsEn),
  } as Messages;
  const page = render(
    <TextProvider locale={locale} messages={messages} timeZone="UTC" now={new Date(STREAM_DATE)}>
      <Frame host={host} />
    </TextProvider>,
  );
  await act(async () => {});
  return { address, el: page.container };
}
