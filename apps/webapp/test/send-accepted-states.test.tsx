/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { SendStatus } from "../app/shell/SendStatus.js";
import { SENDING_LONG_MS, sendVerb, type SendState } from "../app/shell/mail-send.js";

/**
 * THE TWO `queued` STATES, AND THE LONG-SEND LINE — the states the ceiling added, said correctly.
 *
 * A send can now be `queued` for two reasons that look identical on screen and are not the same
 * fact at all:
 *
 *   the SERVER accepted it   the reservation is committed under this key and the submission is
 *                            still being handed to the mail server (the send route's own 202,
 *                            past its attempt ceiling). "Accepted" is true; the surface may close.
 *   the TRANSPORT refused    the request may never have arrived. The only honest line is that it
 *                            has not gone yet, and the surface stays open.
 *
 * Saying "Accepted. ohmail sends it on its next pass." about a request nobody received is a false
 * claim about a person's mail, and it is one careless `else` away — so it is asserted here in both
 * directions and in both locales, because a translation is where a distinction quietly collapses.
 *
 * The third case is the long-send line: a send still running at four seconds stops saying
 * "Sending your message" and says the product still knows about it. Measured against the thing it
 * describes — a healthy send settles well inside a second, and the slowest shipped provider takes
 * a few — so four seconds is past every ordinary send and short of the point where somebody
 * decides the button is broken.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(send: SendState, messages: typeof en | typeof de, locale: string): string {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <NextIntlClientProvider locale={locale} messages={messages as never} timeZone="UTC">
        <SendStatus send={send} scope="reply" lane={null} showing={null} />
      </NextIntlClientProvider>,
    );
  });
  return host.textContent ?? "";
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("the server's accepted-pending send is not the transport's queued one", () => {
  it("accepted reads as a send still going, never as one that may not have arrived — en", () => {
    // NOT `statusAccepted`: that string says "ohmail sends it on its next pass" and no pass
    // claims an interactive row (`claimDue` needs a `send_key` a manual send never has). What is
    // true is that the server holds the reservation and the submission is still in flight, which
    // is the same condition a long send is in — so it says that.
    const text = render({ phase: "queued", accepted: true }, en, "en");
    expect(text).toBe(en.reply.statusSendingLong);
    expect(text, "the surface claimed a pass that will never look at this row")
      .not.toContain("next pass");
  });

  it("accepted reads as a send still going, never as one that may not have arrived — de", () => {
    const text = render({ phase: "queued", accepted: true }, de, "de");
    expect(text).toBe(de.reply.statusSendingLong);
    expect(text).not.toContain("Durchlauf");
  });

  it("a queued send with NO accepted flag never claims acceptance — en", () => {
    const text = render({ phase: "queued" }, en, "en");
    expect(text).toBe(en.reply.statusQueued);
    expect(
      text,
      "a request that may never have arrived was reported as still on its way",
    ).not.toBe(en.reply.statusSendingLong);
  });

  it("a queued send with NO accepted flag never claims acceptance — de", () => {
    const text = render({ phase: "queued" }, de, "de");
    expect(text).toBe(de.reply.statusQueued);
    expect(text).not.toBe(de.reply.statusSendingLong);
  });
});

describe("a send that is still going says so", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("swaps to the long-send line at the threshold, and not before", async () => {
    const since = Date.now();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <NextIntlClientProvider locale="en" messages={en as never} timeZone="UTC">
          <SendStatus send={{ phase: "sending", since }} scope="reply" lane={null} showing={null} />
        </NextIntlClientProvider>,
      );
    });

    expect(host.textContent, "the opening line is the one a normal send shows")
      .toBe(en.reply.statusSending);

    await act(async () => { await vi.advanceTimersByTimeAsync(SENDING_LONG_MS - 1); });
    expect(host.textContent, "the line changed before the threshold").toBe(en.reply.statusSending);

    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(host.textContent, "a send past the threshold still says nothing new")
      .toBe(en.reply.statusSendingLong);
  });

  it("a send ALREADY past the threshold when it renders says so immediately", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <NextIntlClientProvider locale="en" messages={en as never} timeZone="UTC">
          <SendStatus send={{ phase: "sending", since: Date.now() - SENDING_LONG_MS - 1 }} scope="reply" lane={null} showing={null} />
        </NextIntlClientProvider>,
      );
    });
    // The surface can be re-rendered mid-send (a re-mount, a parent update). Deriving from the
    // phase's own stamp rather than from this component's lifetime is what makes that case right.
    expect(host.textContent).toBe(en.reply.statusSendingLong);
  });
});

describe("the button's word and its state attribute come from one derivation", () => {
  it("only the three phases the stylesheet paints ever carry the attribute", () => {
    expect(sendVerb({ phase: "idle" }, "compose")).toEqual({ key: "send" });
    expect(sendVerb({ phase: "sending" }, "compose")).toEqual({ key: "sending", attr: "sending" });
    expect(sendVerb({ phase: "sent" }, "compose")).toEqual({ key: "sent", attr: "sent" });
    expect(sendVerb({ phase: "queued" }, "compose")).toEqual({ key: "queued", attr: "queued" });
    // Back to rest: Send is the retry, and an attribute the stylesheet has no rule for would be
    // a claim in the DOM that nothing is making.
    expect(sendVerb({ phase: "failed" }, "compose")).toEqual({ key: "send" });
    expect(sendVerb({ phase: "unverified" }, "compose")).toEqual({ key: "send" });
  });

  it("a send-later confirm says Scheduled on the compose form and Sent on a reply", () => {
    // Nothing was sent; an appointment was made. "Sent" over it is the false claim the phase
    // machine exists to prevent — and the reply scope has no `scheduled` key to render at all,
    // so asking for one there would put a key's own name in front of a reader.
    expect(sendVerb({ phase: "sent", scheduled: true }, "compose")).toEqual({ key: "scheduled", attr: "sent" });
    expect(sendVerb({ phase: "sent", scheduled: true }, "reply")).toEqual({ key: "sent", attr: "sent" });
  });

  it("every key the verb can name exists in BOTH locales, in both scopes it is used in", () => {
    // The compose form is the only scope that can reach `scheduled`; the guard says so rather
    // than asserting a key the reply catalogue deliberately does not carry.
    for (const [messages, name] of [[en, "en"], [de, "de"]] as const) {
      for (const scope of ["compose", "reply"] as const) {
        const states: SendState[] = [
          { phase: "idle" }, { phase: "sending" }, { phase: "sent" },
          { phase: "queued" }, { phase: "failed" }, { phase: "unverified" },
          ...(scope === "compose" ? [{ phase: "sent", scheduled: true } as SendState] : []),
        ];
        for (const state of states) {
          const { key } = sendVerb(state, scope);
          // Read as `unknown` and narrowed by the assertion, NOT cast to a two-level record: the
          // catalogue nests deeper than that in other scopes (`screener.empty.waiting.title`), so
          // the direct cast does not overlap and `apps/webapp` — one of the four packages that
          // typecheck their TESTS — fails the whole gate on it.
          const catalogue = messages as unknown as Record<string, Record<string, unknown>>;
          expect(
            catalogue[scope]?.[key],
            `${name}.${scope}.${key} is missing — the button would render the key's own name`,
          ).toBeTypeOf("string");
        }
      }
    }
  });
});
