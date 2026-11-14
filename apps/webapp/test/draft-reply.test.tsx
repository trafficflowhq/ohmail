/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import messages from "../messages/en.json";

/**
 * PRESSING "DRAFT REPLY" — the cost, the key, the refusals, and the debt it must not settle.
 *
 * The route this drives has been live and uncalled for months, so every state here is one
 * nobody has yet seen in the product. Four of them are the reason this file is long:
 *
 *  · the cost is on screen BEFORE anything is spent, and confirming is a separate act;
 *  · one press is one Idempotency-Key, and a retry of that press reuses it — a second draft
 *    bought for one intent is a charge the user did not make;
 *  · a refusal renders the SERVER's sentence and stops. No retry loop, and no locally-invented
 *    reason: somebody out of credits must not be told the model is down;
 *  · a generated draft is not a sent reply. It dispatches no mutation, so it cannot discharge
 *    a Reply Run's debt — asserted here by counting mutations rather than by reading the code.
 */

const fetchMock = vi.fn();
let host: HTMLElement;
let root: Root | null = null;

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return { ...actual, apiConfigured: () => true, api: (...a: unknown[]) => fetchMock(...a) };
});

const { useDraftReply, DRAFT_REPLY_COST_CREDITS } = await import("@ohmail/app-logic/writing/draft-reply");
/* The wire the web's host hands, over the server client mocked above: the mount hands it as that host does. */
const { CLOUD_WIRE } = await import("../app/(product)/mailbox/draft-reply-wire");
const { ApiError } = await import("../app/api-client");
type Control = NonNullable<ReturnType<typeof useDraftReply>>;

/** Mounted over the wire a host hands: the web's unless a case names another. No wire at all is the last describe's. */
function mount(wire: Exclude<Parameters<typeof useDraftReply>[0]["wire"], "none"> = CLOUD_WIRE) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const drafts: Array<{ draft: { text: string; html: string }; messageId: string }> = [];
  let control: Control;

  function Harness() {
    control = useDraftReply({
      onDraft: (draft, messageId) => drafts.push({ draft, messageId }), wire, t: useTranslations(),
    })!;
    return <p>{control.phase}</p>;
  }

  root = createRoot(host);
  act(() => {
    root!.render(
      <NextIntlClientProvider locale="en" messages={messages as never}>
        <Harness />
      </NextIntlClientProvider>,
    );
  });
  return { drafts, get control() { return control; } };
}

/** The reply holds no words of the person's own when pressed. */
const NO_WORDS = { text: "", html: "" };
/** The person's own words in the reply, as the press hands them. */
const typed = (text: string) => ({ text, html: "" });

/** Lets the two awaited requests inside `confirm` resolve. */
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => {
  fetchMock.mockReset();
  vi.spyOn(globalThis.crypto, "randomUUID")
    .mockReturnValueOnce("key-1-1111-1111-1111-111111111111")
    .mockReturnValueOnce("key-2-2222-2222-2222-222222222222");
});

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  host?.remove();
  vi.restoreAllMocks();
});

describe("the cost is named before anything is spent", () => {
  it("opening the offer reaches no network at all", () => {
    const h = mount();
    act(() => { h.control.open("m1"); });
    expect(h.control.phase).toBe("offered");
    expect(h.control.cost).toBe(DRAFT_REPLY_COST_CREDITS);
    expect(h.control.messageId).toBe("m1");
    // THE ASSERTION. A price that is only visible after the spend is not a price.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancelling spends nothing and forgets the offer", () => {
    const h = mount();
    act(() => { h.control.open("m1"); });
    act(() => { h.control.cancel(); });
    expect(h.control.phase).toBe("closed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("states the cost in CREDITS — the unit the plan is sold in", () => {
    // 15, not 1. Weighted debits made a draft fifteen credits against a classification's one,
    // and the plan card moved from "~N AI actions" to "N AI credits" in the same change — so
    // the unit a person is quoted and the unit the server charges are one unit again.
    // `test/landing-pricing-matches-plan-card.test.ts` pins this literal to the server's
    // `AI_ACTION_WEIGHTS.debit_draft`; this case pins the CLIENT contract.
    expect(DRAFT_REPLY_COST_CREDITS).toBe(15);
  });
});

describe("one press is one purchase", () => {
  it("POSTs with an Idempotency-Key, then READS the draft and hands it over", async () => {
    const h = mount();
    fetchMock
      .mockResolvedValueOnce({ draftId: "d1" })
      .mockResolvedValueOnce({ body: "Thursday works.", html: "<p>Thursday works.</p>" });

    act(() => { h.control.open("m1"); });
    act(() => { h.control.confirm(); });
    await flush();

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/messages/m1/draft", {
      method: "POST",
      headers: { "Idempotency-Key": "key-1-1111-1111-1111-111111111111" },
    });
    // The draft is READ, not waited for on the mirror — the row exists by the time 202 lands.
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/drafts/d1");
    expect(h.drafts).toEqual([
      { draft: { text: "Thursday works.", html: "<p>Thursday works.</p>" }, messageId: "m1" },
    ]);
    expect(h.control.phase).toBe("closed");
  });

  it("REUSES the key when the same press is pressed again after a failure", async () => {
    // A lost response is the case this exists for: the server may have drafted and charged,
    // and a fresh key would buy a second one for the same intent.
    const h = mount();
    fetchMock.mockRejectedValueOnce(new ApiError(503, "upstream", "the model is unreachable"));
    act(() => { h.control.open("m1"); });
    act(() => { h.control.confirm(); });
    await flush();
    expect(h.control.phase).toBe("offered");

    fetchMock
      .mockResolvedValueOnce({ draftId: "d1" })
      .mockResolvedValueOnce({ body: "ok", html: "" });
    act(() => { h.control.confirm(); });
    await flush();

    const keys = fetchMock.mock.calls
      .filter((c) => String(c[0]).endsWith("/draft"))
      .map((c) => (c[1] as { headers: Record<string, string> }).headers["Idempotency-Key"]);
    expect(keys).toEqual([
      "key-1-1111-1111-1111-111111111111",
      "key-1-1111-1111-1111-111111111111",
    ]);
  });

  it("mints a NEW key for a deliberate second draft of the same message", async () => {
    const h = mount();
    fetchMock
      .mockResolvedValueOnce({ draftId: "d1" }).mockResolvedValueOnce({ body: "one", html: "" })
      .mockResolvedValueOnce({ draftId: "d2" }).mockResolvedValueOnce({ body: "two", html: "" });

    act(() => { h.control.open("m1"); });
    act(() => { h.control.confirm(); });
    await flush();
    act(() => { h.control.open("m1"); });
    act(() => { h.control.confirm(); });
    await flush();

    const keys = fetchMock.mock.calls
      .filter((c) => String(c[0]).endsWith("/draft"))
      .map((c) => (c[1] as { headers: Record<string, string> }).headers["Idempotency-Key"]);
    expect(new Set(keys).size, "a second, deliberate purchase reused the first key").toBe(2);
  });

  it("ignores an answer that arrives after the user has moved on", async () => {
    const h = mount();
    let release!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => { release = r; }));
    act(() => { h.control.open("m1"); });
    act(() => { h.control.confirm(); });
    act(() => { h.control.cancel(); });
    await act(async () => { release({ draftId: "d1" }); await Promise.resolve(); });
    expect(h.drafts).toEqual([]);
    expect(h.control.phase).toBe("closed");
  });
});

describe("one press: the offer and the purchase together", () => {
  const keysSent = () => fetchMock.mock.calls
    .filter((c) => String(c[0]).endsWith("/draft"))
    .map((c) => (c[1] as { headers: Record<string, string> }).headers["Idempotency-Key"]);

  it("buys and hands the draft over in one call, with one key", async () => {
    const h = mount();
    fetchMock.mockResolvedValueOnce({ draftId: "d1" }).mockResolvedValueOnce({ body: "Noon is fine.", html: "" });
    act(() => { h.control.press("m1", NO_WORDS); });
    act(() => { h.control.press("m1", NO_WORDS); });
    await flush();
    expect(keysSent()).toEqual(["key-1-1111-1111-1111-111111111111"]);
    expect(h.drafts).toEqual([{ draft: { text: "Noon is fine.", html: "" }, messageId: "m1" }]);
    expect(h.control.phase).toBe("closed");
  });

  it("pressed again after a failure retries the same purchase; a press on another letter is a new one", async () => {
    const h = mount();
    fetchMock.mockRejectedValueOnce(new ApiError(503, "upstream", "the model is unreachable"));
    act(() => { h.control.press("m1", NO_WORDS); });
    await flush();
    expect(h.control.phase).toBe("offered");
    fetchMock.mockRejectedValueOnce(new ApiError(503, "upstream", "the model is unreachable"));
    act(() => { h.control.press("m1", NO_WORDS); });
    await flush();
    fetchMock.mockResolvedValueOnce({ draftId: "d2" }).mockResolvedValueOnce({ body: "ok", html: "" });
    act(() => { h.control.press("m2", NO_WORDS); });
    await flush();
    expect(keysSent()).toEqual([
      "key-1-1111-1111-1111-111111111111",
      "key-1-1111-1111-1111-111111111111",
      "key-2-2222-2222-2222-222222222222",
    ]);
    expect(h.drafts.map((d) => d.messageId)).toEqual(["m2"]);
  });

  it("the in-flight mark is cleared only by the answer of its own request: open and cancel meanwhile start nothing", async () => {
    const h = mount();
    let release = (): void => undefined;
    fetchMock
      .mockImplementationOnce(() => new Promise((r) => { release = () => r({ draftId: "d1" }); }))
      .mockResolvedValueOnce({ body: "one", html: "" });
    act(() => { h.control.press("m1", NO_WORDS); });
    act(() => { h.control.cancel(); });
    act(() => { h.control.open("m1"); });
    act(() => { h.control.confirm(); });
    act(() => { h.control.press("m1", NO_WORDS); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
    await flush();
    // That answer came after the person moved on: dropped. Its request is over, so a press now is a new purchase.
    expect(h.drafts).toEqual([]);
    fetchMock.mockResolvedValueOnce({ draftId: "d2" }).mockResolvedValueOnce({ body: "two", html: "" });
    act(() => { h.control.press("m1", NO_WORDS); });
    await flush();
    expect(keysSent()).toEqual(["key-1-1111-1111-1111-111111111111", "key-2-2222-2222-2222-222222222222"]);
    expect(h.drafts.map((d) => d.draft.text)).toEqual(["two"]);
  });
});

describe("draft from your text: one press, one purchase", () => {
  const asked = () => fetchMock.mock.calls.filter((c) => String(c[0]) === "/drafts/from-text");
  const keyOf = (c: unknown[]) => (c[1] as { headers: Record<string, string> }).headers["Idempotency-Key"];

  it("sends the person's words with the letter they answer and one key, then reads the draft and hands it over", async () => {
    const h = mount(CLOUD_WIRE);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce({ draftId: "d1" }).mockResolvedValueOnce({ body: "Noon suits me.", html: "" });
    const fromText = h.control.fromText;
    if (fromText === "none") throw new Error("the web's wire offers drafting from text");
    act(() => { fromText("m1", "noon ok, bring the glaze", typed("noon ok, bring the glaze")); });
    await flush();
    expect(asked()).toHaveLength(1);
    const [, init] = asked()[0]! as [string, { method: string; body: unknown }];
    expect(init.method).toBe("POST");
    expect(init.body).toEqual({ text: "noon ok, bring the glaze", inReplyToMessageId: "m1" });
    expect(keyOf(asked()[0]!)).toBe("key-1-1111-1111-1111-111111111111");
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["/drafts/from-text", "/drafts/d1"]);
    expect(h.drafts).toEqual([{ draft: { text: "Noon suits me.", html: "" }, messageId: "m1" }]);
  });

  it("a second press while the first is in flight sends nothing; a press after it is a new purchase with a new key", async () => {
    const h = mount(CLOUD_WIRE);
    let release = (): void => undefined;
    fetchMock
      .mockImplementationOnce(() => new Promise((r) => { release = () => r({ draftId: "d1" }); }))
      .mockResolvedValueOnce({ body: "one", html: "" })
      .mockResolvedValueOnce({ draftId: "d2" })
      .mockResolvedValueOnce({ body: "two", html: "" });
    const fromText = h.control.fromText;
    if (fromText === "none") throw new Error("the web's wire offers drafting from text");
    act(() => {
      fromText("m1", "my words", typed("my words"));
      fromText("m1", "my words", typed("my words"));
    });
    act(() => { (h.control.fromText as typeof fromText)("m1", "my words", typed("my words")); });
    act(() => { h.control.press("m1", NO_WORDS); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
    await flush();
    act(() => { (h.control.fromText as typeof fromText)("m1", "my words", typed("my words")); });
    await flush();
    expect(asked().map(keyOf)).toEqual(["key-1-1111-1111-1111-111111111111", "key-2-2222-2222-2222-222222222222"]);
    expect(h.drafts.map((d) => d.draft.text)).toEqual(["one", "two"]);
  });

  it("after a failure the same words retry the same purchase under its key; other words or another letter are a new one", async () => {
    const h = mount(CLOUD_WIRE);
    vi.mocked(globalThis.crypto.randomUUID).mockReturnValueOnce("key-3-3333-3333-3333-333333333333");
    fetchMock
      .mockRejectedValueOnce(new TypeError("lost"))
      .mockRejectedValueOnce(new TypeError("lost again"))
      .mockRejectedValueOnce(new TypeError("lost on another letter"));
    const fromText = () => (id: string, text: string) =>
      (h.control.fromText as (id: string, text: string, own: typeof NO_WORDS) => void)(id, text, typed(text));
    act(() => { fromText()("m1", "my words"); });
    await flush();
    act(() => { fromText()("m1", "my words"); });
    await flush();
    act(() => { fromText()("m2", "my words"); });
    await flush();
    fetchMock.mockResolvedValueOnce({ draftId: "d4" }).mockResolvedValueOnce({ body: "ok", html: "" });
    act(() => { fromText()("m1", "my other words"); });
    await flush();
    expect(asked().map(keyOf)).toEqual([
      "key-1-1111-1111-1111-111111111111",
      "key-1-1111-1111-1111-111111111111",
      "key-2-2222-2222-2222-222222222222",
      "key-3-3333-3333-3333-333333333333",
    ]);
    expect((asked()[2]![1] as { body: unknown }).body).toEqual({ text: "my words", inReplyToMessageId: "m2" });
    // Nothing retried by itself: four presses, four purchases asked, one draft read.
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      "/drafts/from-text", "/drafts/from-text", "/drafts/from-text", "/drafts/from-text", "/drafts/d4",
    ]);
  });

  it("keeps the person's own words beside the draft that landed over them, for that letter, until it is let go", async () => {
    const h = mount(CLOUD_WIRE);
    fetchMock.mockResolvedValueOnce({ draftId: "d1" }).mockResolvedValueOnce({ body: "Noon suits me.", html: "" });
    act(() => { (h.control.fromText as (id: string, text: string, own: typeof NO_WORDS) => void)("m1", "noon ok", typed("noon ok")); });
    await flush();
    expect([...h.control.own.values()]).toEqual([{
      messageId: "m1", yours: typed("noon ok"), draft: { text: "Noon suits me.", html: "" }, shown: "draft",
    }]);
    // A draft that lands for another letter, over words or over none, changes that letter's entry alone.
    fetchMock.mockResolvedValueOnce({ draftId: "d2" }).mockResolvedValueOnce({ body: "Thanks.", html: "" });
    act(() => { h.control.press("m2", NO_WORDS); });
    await flush();
    fetchMock.mockResolvedValueOnce({ draftId: "d3" }).mockResolvedValueOnce({ body: "See you.", html: "" });
    act(() => { (h.control.fromText as (id: string, text: string, own: typeof NO_WORDS) => void)("m3", "friday", typed("friday")); });
    await flush();
    expect([...h.control.own.keys()]).toEqual(["m1", "m2", "m3"]);
    expect(h.control.own.get("m1")?.yours).toEqual(typed("noon ok"));
    // Over no words the draft is kept with no text of the person's: drafted again, it is a plain draft.
    expect(h.control.own.get("m2")).toEqual({ messageId: "m2", yours: NO_WORDS, draft: { text: "Thanks.", html: "" }, shown: "draft" });
    expect(h.control.own.get("m3")?.yours).toEqual(typed("friday"));
    act(() => { h.control.forget("m2"); });
    act(() => { h.control.forget("m3"); });
    expect([...h.control.own.keys()]).toEqual(["m1"]);
    act(() => { h.control.forget("m1"); });
    expect(h.control.own.size).toBe(0);
  });

  /* A host that hands no draft wire is answered no control at all (the file's last describe): nothing is offered. */
  it("the web's wire is offered the control and Draft from your text, and nothing is asked before a press", () => {
    const web = mount(CLOUD_WIRE);
    expect(web.control.offered).toBe(true);
    expect(web.control.fromText).not.toBe("none");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a host with no door for it answers none, and the control offers none", () => {
    const h = mount({
      configured: () => true,
      create: async () => ({ draftId: "never" }),
      read: async () => ({}),
      fromText: "none",
    });
    expect(h.control.fromText).toBe("none");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("refusals say the right thing, and nothing retries by itself", () => {
  it.each([
    [422, "sensitive_no_ai", "cannot AI-draft a sensitive message"],
    [503, "drafter_unconfigured", "this deployment has no AI drafter connected"],
  ])("renders the %i refusal verbatim and returns to the offer", async (status, code, message) => {
    const h = mount();
    fetchMock.mockRejectedValueOnce(new ApiError(status, code, message));
    act(() => { h.control.open("m1"); });
    act(() => { h.control.confirm(); });
    await flush();

    expect(h.control.notice).toBe(message);
    expect(h.control.phase).toBe("offered");
    // ONE call. Nothing retried on its own — a 402 in a loop is somebody being asked to buy
    // what they have just been told they cannot afford.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.drafts).toEqual([]);
  });

  it.each([
    [402, "insufficient_credits", messages.aiRefusal.insufficientCredits],
    [409, "ai_disabled", messages.aiRefusal.aiDisabled],
    [503, "ai_unavailable", messages.aiRefusal.aiUnavailable],
  ])("says the %i refusal in the reader's language, from the catalogue", async (status, code, said) => {
    // THE THREE REFUSALS EVERY DEPLOYMENT CAN MAKE. Their server `message` is English written
    // for a log, and it was being painted verbatim — so a German reader met an English sentence
    // about an account state. The code carries the fact; the catalogue carries the sentence.
    // The case above is the other half: everything else still passes through verbatim, because
    // "this deployment has no AI drafter connected" is a fact no code here carries.
    const h = mount();
    fetchMock.mockRejectedValueOnce(new ApiError(status, code, "a sentence written for a log"));
    act(() => { h.control.open("m1"); });
    act(() => { h.control.confirm(); });
    await flush();

    expect(h.control.notice).toBe(said);
    expect(h.control.notice).not.toContain("written for a log");
    expect(h.control.phase).toBe("offered");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.drafts).toEqual([]);
  });

  it("does not invent a reason for something that is not a refusal", async () => {
    const h = mount();
    fetchMock.mockRejectedValueOnce(new TypeError("boom"));
    act(() => { h.control.open("m1"); });
    act(() => { h.control.confirm(); });
    await flush();
    expect(h.control.notice).toBe(messages.draftReply.failed);
  });
});

describe("a generated draft is not a sent reply", () => {
  it("dispatches NO mutation — so it cannot discharge a Reply Run's debt", async () => {
    /**
     * The debt is discharged by `onSendSettled`, which runs from the send machine's `settle`
     * and only for a mutation that machine dispatched. This module reaches the API directly
     * and returns its answer to the caller, so there is no mutation for `absorb` to see and no
     * path from drafting to `triage_set`.
     *
     * Asserted by counting rather than by reading, because the failure mode is somebody later
     * adding "the message is handled now" to the landing path — which is the pre-fix `onDone`
     * bug returning as AI.
     */
    const h = mount();
    fetchMock
      .mockResolvedValueOnce({ draftId: "d1" })
      .mockResolvedValueOnce({ body: "drafted", html: "" });
    act(() => { h.control.open("m1"); });
    act(() => { h.control.confirm(); });
    await flush();

    expect(h.drafts).toHaveLength(1);
    const paths = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(paths).toEqual(["/messages/m1/draft", "/drafts/d1"]);
    for (const p of paths) {
      expect(p, "the drafting press reached a triage or send route").not.toMatch(/triage|send|sync/);
    }
  });

  it("hands the draft to the caller instead of writing it anywhere itself", async () => {
    // The replace-or-append decision belongs to whoever can see the editor. This module must
    // not make it, because the one thing it must never do is overwrite typed text.
    const h = mount();
    fetchMock
      .mockResolvedValueOnce({ draftId: "d1" })
      .mockResolvedValueOnce({ body: "generated", html: "<p>generated</p>" });
    act(() => { h.control.open("m9"); });
    act(() => { h.control.confirm(); });
    await flush();
    expect(h.drafts[0]).toEqual({
      draft: { text: "generated", html: "<p>generated</p>" }, messageId: "m9",
    });
  });
});

describe("a host that hands no draft wire", () => {
  it("is answered no control at all, and the server client is never asked", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    let control: Control | null | undefined;
    function Harness() {
      control = useDraftReply({ onDraft: () => { /* nothing can be drafted */ }, wire: "none", t: useTranslations() });
      return <p>{control === null ? "no control" : "a control"}</p>;
    }
    root = createRoot(host);
    act(() => {
      root!.render(
        <NextIntlClientProvider locale="en" messages={messages as never}>
          <Harness />
        </NextIntlClientProvider>,
      );
    });
    // No control: nothing can open an offer, so nothing can be confirmed and nothing bought.
    expect(control, "a host that named no drafter was answered a control").toBeNull();
    expect(host.textContent).toBe("no control");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
