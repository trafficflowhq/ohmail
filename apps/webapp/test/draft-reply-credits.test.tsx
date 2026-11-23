/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * THE DRAFT FAILED AFTER THE CHARGE — the two sentences, read off the rendered notice.
 *
 * Before this the notice for a paid press that faulted was `failedOpaqueEarly`: "Something went
 * wrong on the server and no draft was made. Nothing was charged." The last four words were false
 * in exactly the sequence that matters — the spend landed, the drafter threw, and the reversal was
 * lost — so the one person who most needed to know about their credits was told the opposite.
 *
 * TWO STATES, TWO SENTENCES, and they are read here from the RENDERED string rather than from the
 * key: a mapping asserted against itself is a tautology, and the thing a person actually meets is
 * the sentence. Both catalogues, because the whole reason this comes out of the catalogue and not
 * off the wire is that the server's `message` is English written for a log.
 */

const fetchMock = vi.fn();
let host: HTMLElement;
let root: Root | null = null;

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return { ...actual, apiConfigured: () => true, api: (...a: unknown[]) => fetchMock(...a) };
});

const { useDraftReply } = await import("@ohmail/app-logic/writing/draft-reply");
/* The wire the web's host hands, over the server client mocked above: the mount hands it as that host does. */
const { CLOUD_WIRE } = await import("../app/(product)/mailbox/draft-reply-wire");
const { ApiError } = await import("../app/api-client");
type Control = NonNullable<ReturnType<typeof useDraftReply>>;

function mount(locale: "en" | "de") {
  host = document.createElement("div");
  document.body.appendChild(host);
  let control: Control;
  function Harness() {
    control = useDraftReply({
      onDraft: () => { /* nothing is handed over on a failure */ }, wire: CLOUD_WIRE, t: useTranslations(),
    })!;
    return <p data-testid="notice">{control.notice}</p>;
  }
  root = createRoot(host);
  act(() => {
    root!.render(
      <NextIntlClientProvider locale={locale} messages={(locale === "en" ? en : de) as never}>
        <Harness />
      </NextIntlClientProvider>,
    );
  });
  return { get control() { return control; } };
}

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const notice = (): string => host.querySelector("[data-testid=notice]")!.textContent ?? "";

/** The refusal the service throws once a charge has landed and the drafter has not. */
const failed = (credits: "returned" | "owed") =>
  new ApiError(503, "ai_draft_failed", "the draft could not be written", { credits });

beforeEach(() => {
  fetchMock.mockReset();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("key-1-1111-1111-1111-111111111111");
});

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  host?.remove();
  vi.restoreAllMocks();
});

describe("a draft that failed after the charge says what happened to the credits", () => {
  it.each([
    ["en", 503, "ai_draft_failed", "The draft stopped. Your credits were used."],
    ["de", 422, "ai_draft_declined", "Der Entwurf wurde abgebrochen. Deine Punkte wurden verbraucht."],
  ] as const)("renders the credits-used sentence in %s and starts a fresh attempt on the next press",
    async (locale, status, code, sentence) => {
      const h = mount(locale);
      vi.mocked(globalThis.crypto.randomUUID)
        .mockReturnValueOnce("a1111111-1111-1111-1111-111111111111")
        .mockReturnValueOnce("a2222222-2222-2222-2222-222222222222");
      const failure = new ApiError(status, code, "the draft stopped", { credits: "used" });
      fetchMock.mockRejectedValue(failure);

      act(() => { h.control.open("m1"); });
      act(() => { h.control.confirm(); });
      await flush();

      expect(notice()).toBe(sentence);
      act(() => { h.control.confirm(); });
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const keys = fetchMock.mock.calls.map(([, init]) => init.headers["Idempotency-Key"]);
      expect(keys).toEqual(["a1111111-1111-1111-1111-111111111111", "a2222222-2222-2222-2222-222222222222"]);
    },
  );

  it("the reversal LANDED — the person is told the credits are back", async () => {
    const h = mount("en");
    fetchMock.mockRejectedValueOnce(failed("returned"));
    act(() => { h.control.open("m1"); });
    act(() => { h.control.confirm(); });
    await flush();

    expect(notice()).toBe("This did not work. Your credits are back.");
    // AND NOT THE OLD SENTENCE, which claimed the opposite of what happened.
    expect(notice()).not.toContain("Nothing was charged");
    expect(h.control.phase).toBe("offered");
  });

  it("the reversal is OWED — the person is told the credits are coming back", async () => {
    const h = mount("en");
    fetchMock.mockRejectedValueOnce(failed("owed"));
    act(() => { h.control.open("m1"); });
    act(() => { h.control.confirm(); });
    await flush();

    expect(notice()).toBe("This did not work. Your credits will be returned.");
    expect(notice()).not.toContain("Nothing was charged");
  });

  it("the two sentences are DIFFERENT — one state may not render as the other", async () => {
    const back = mount("en");
    fetchMock.mockRejectedValueOnce(failed("returned"));
    act(() => { back.control.open("m1"); });
    act(() => { back.control.confirm(); });
    await flush();
    const a = notice();
    act(() => { root?.unmount(); });
    host.remove();

    const owed = mount("en");
    fetchMock.mockRejectedValueOnce(failed("owed"));
    act(() => { owed.control.open("m1"); });
    act(() => { owed.control.confirm(); });
    await flush();

    expect(notice()).not.toBe(a);
  });

  it("a German reader gets German, not the server's log English", async () => {
    const h = mount("de");
    fetchMock.mockRejectedValueOnce(failed("owed"));
    act(() => { h.control.open("m1"); });
    act(() => { h.control.confirm(); });
    await flush();

    expect(notice()).toBe("Das hat nicht geklappt. Deine Punkte kommen zurück.");
    expect(notice()).not.toContain("the draft could not be written");
  });

  it("an UNRECOGNISED credits word falls back rather than inventing a claim about money", async () => {
    const h = mount("en");
    // A newer server saying something this build has no sentence for. It must not be rendered as
    // either of the two — a guess here is a claim about somebody's money.
    fetchMock.mockRejectedValueOnce(
      new ApiError(503, "ai_draft_failed", "the draft could not be written", { credits: "later" }));
    act(() => { h.control.open("m1"); });
    act(() => { h.control.confirm(); });
    await flush();

    expect(notice()).not.toContain("credits are back");
    expect(notice()).not.toContain("credits will be returned");
    // The server's own sentence, which is what this path has always done for an unmodelled code.
    expect(notice()).toBe("the draft could not be written");
  });

  /**
   * DRAFTING-ROUTE-HAS-NO-ADMISSION-ARITHMETIC: an unmodelled fault cannot be placed before or
   * after the charge — a request the platform killed answers 504 with no envelope at all — so
   * "Nothing was charged" was a guess. The sentence says only what the kept key makes true.
   */
  it.each([
    ["an ordinary fault", new ApiError(500, "internal", "internal error")],
    ["a request killed with no answer", new ApiError(504, "internal", "Something went wrong. Please try again.")],
  ])("%s never claims nothing was charged — only that a retry is not charged twice", async (_what, err) => {
    const h = mount("en");
    fetchMock.mockRejectedValueOnce(err);
    act(() => { h.control.open("m1"); });
    act(() => { h.control.confirm(); });
    await flush();

    expect(notice()).not.toContain("Nothing was charged");
    expect(notice()).toContain("never charged twice");
  });

  it("the German sentence makes the same claim and no other", async () => {
    const h = mount("de");
    fetchMock.mockRejectedValueOnce(new ApiError(504, "internal", "Something went wrong. Please try again."));
    act(() => { h.control.open("m1"); });
    act(() => { h.control.confirm(); });
    await flush();

    expect(notice()).not.toContain("nichts berechnet");
    expect(notice()).toContain("nie doppelt berechnet");
  });
});

/**
 * THE MODEL DECLINED THE DRAFT — said as a decline, with the credit state when one moved. The
 * service answers 422 `ai_draft_declined`; without its own sentence the notice fell to the
 * server's log English. Mutation: drop the `ai_draft_declined` arm in `draftFailureKey`.
 */
describe("a declined draft says it was declined", () => {
  const declined = (credits?: "returned" | "owed") => new ApiError(
    422, "ai_draft_declined", "the model declined to write this draft", credits ? { credits } : undefined);

  it.each([
    ["en", undefined, "The model declined to draft this reply."],
    ["en", "returned", "The model declined to draft this reply. Your credits are back."],
    ["en", "owed", "The model declined to draft this reply. Your credits will be returned."],
    ["de", undefined, "Das Modell hat es abgelehnt, diese Antwort zu entwerfen."],
    ["de", "returned", "Das Modell hat es abgelehnt, diese Antwort zu entwerfen. Deine Punkte sind zurück."],
    ["de", "owed", "Das Modell hat es abgelehnt, diese Antwort zu entwerfen. Deine Punkte kommen zurück."],
  ] as const)("%s, credits %s", async (locale, credits, sentence) => {
    const h = mount(locale);
    fetchMock.mockRejectedValueOnce(declined(credits));
    act(() => { h.control.open("m1"); });
    act(() => { h.control.confirm(); });
    await flush();

    expect(notice()).toBe(sentence);
    expect(h.control.phase).toBe("offered");
  });
});
