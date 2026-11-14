/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TextProvider, type Messages } from "@ohmail/app/text";
import { SubscriptionPane, useSubscription } from "../../../../packages/app/src/account/subscription/index.js";
import ownEn from "../../../../packages/app/messages/account-subscription.en.json";
import { en, json, published, refusal, serve, settle, type Server } from "./storage-harness";
import { NEAR, open } from "./storage-fixtures";

/**
 * THE CALLS OF ONE VISIT, BEFORE AND AFTER. The shipped section and the new pane over the web's filling are each
 * walked through the same visit over the same scripted server: open; Manage, refused; Manage again, answered with the
 * page and left for; leave. The two ordered lists of method, path and body keys are equal. One difference is declared
 * and is not here yet: the new pane will ask the plans once per visit when the server serves their read.
 */

const MINT = "POST /api/account/manage-link";
let server: Server;
beforeEach(() => {
  server = serve(() => open(NEAR));
});
afterEach(() => {
  cleanup();
  server.restore();
});

const TEXT = { ...en, ...ownEn } as Messages;
function Words({ children }: { readonly children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <TextProvider locale="en" messages={TEXT} timeZone="UTC">
        <ThemeProvider>{children}</ThemeProvider>
      </TextProvider>
    </NextIntlClientProvider>
  );
}

async function walk(pane: ReactNode): Promise<string[]> {
  server.answer(MINT, refusal(500, "internal"), json({ url: "https://pay.example.com/manage/visit" }));
  await published();
  server.forget();
  const { unmount } = render(<Words>{pane}</Words>);
  for (let press = 0; press < 2; press += 1) {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.settings.subscriptionManage }));
    });
    await settle();
  }
  unmount();
  await settle();
  return server.sent.map((s) => `${s.line} {${s.keys.join(",")}}`);
}

describe("one visit to Settings › Subscription asks the server the same things, in the same order", () => {
  it("the shipped section and the new pane", async () => {
    const { SubscriptionSection } = await import("../../app/(product)/mailbox/SubscriptionSection");
    const before = await walk(<SubscriptionSection onNowhere={() => {}} />);
    cleanup();
    server.restore();
    server = serve(() => open(NEAR));

    const { useSubscriptionDoor } = await import("../../app/(product)/mailbox/subscription-door");
    function Anew() {
      return <SubscriptionPane model={useSubscription(useSubscriptionDoor(null, () => {}))} toStorage={null} />;
    }
    const after = await walk(<Anew />);

    expect(before).toEqual([`${MINT} {lang}`, `${MINT} {lang}`]);
    expect(after).toEqual(before);
    expect(server.left.map((l) => l.href)).toEqual(["https://pay.example.com/manage/visit"]);
  });
});
