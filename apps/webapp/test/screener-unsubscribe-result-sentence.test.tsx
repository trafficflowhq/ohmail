/** @vitest-environment jsdom */
import type { UnsubscribeResult } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import { HeldUnsubscribe } from "../app/views/ScreenerView";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE SENTENCE A PERSON READS AFTER PRESSING UNSUBSCRIBE (a high review finding).
 *
 * The record for a list is written BEFORE the request, so its existence says only that somebody
 * got as far as trying. The service answered `already_recorded` on any conflict and this control
 * rendered "Already unsubscribed from this list." over it — so a person whose unsubscribe was
 * claimed and then stranded by a DNS failure was told the thing was done, while the mail kept
 * arriving. The acceptance is the sentence, not the service's return code.
 *
 * Read from the RENDERED output. Watched red by putting the old mapping back (every refusal that
 * is not null rendering `unsubAlready`): the first case then reads the completed sentence for a
 * send that never happened.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
});

async function press(res: UnsubscribeResult): Promise<string> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    // `children` in the props object, never a third argument: the provider's overload requires it
    // in the type, and `apps/webapp` typechecks its tests — the form every sibling test uses.
    root!.render(
      React.createElement(NextIntlClientProvider, {
        locale: "en", messages: en,
        children: React.createElement(HeldUnsubscribe, {
          state: "one_click", url: "https://sender.example/u",
          onUnsubscribe: async () => res,
        }),
      }),
    );
  });
  const button = host.querySelector("button");
  expect(button, "the one-click control must render a press").not.toBeNull();
  await act(async () => { button!.click(); });
  await settleFirstPaint();
  return host.textContent ?? "";
}

const ALREADY = en.screener.unsubAlready;
const UNFINISHED = en.screener.unsubUnfinished;
const SENT = en.screener.unsubSent;

describe("the sentence after a press follows the OUTCOME, not the record", () => {
  it("a claim that never sent does NOT say the unsubscribe is done", async () => {
    const text = await press({
      messageId: "m", posted: false, status: null,
      refusal: "previous_attempt_unsettled", header: "one_click",
    });
    expect(text).toContain(UNFINISHED);
    expect(text, "a send that never happened may not read as a completed one").not.toContain(ALREADY);
  });

  it("a settled send still says it — the case the sentence was written for", async () => {
    const text = await press({
      messageId: "m", posted: false, status: null,
      refusal: "already_recorded", header: "one_click",
    });
    expect(text).toContain(ALREADY);
  });

  it("a fresh send says it was sent", async () => {
    const text = await press({
      messageId: "m", posted: true, status: 200,
      refusal: null, header: "one_click",
    });
    expect(text).toContain(SENT);
  });
});
