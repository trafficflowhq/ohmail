"use client";

/**
 * Buying a drafted reply — the control that names the cost before it spends, and hands the answer to the editor
 * rather than the wire. Two non-negotiable invariants: NOTHING SENDS — AI proposes and the user decides; the text
 * lands in the reply editor and stops there — no `mail_send`, no triage change, and no discharge of the Reply Run's
 * debt (that is `onSendSettled`'s, keyed on a SEND settling). And THE COST IS STATED BEFORE IT IS TAKEN — one draft
 * is 15 credits ({@link DRAFT_REPLY_COST_CREDITS}), the figure the route charges, not one computed from a balance.
 */

/** Read the saved draft directly after the purchase receipt. Progress is provisional. */
import { useCallback, useRef, useState } from "react";
import type { AnswerOf, ParamsOf, RequestOf } from "@ohmail/wire";
import { isRichEmpty, type RichValue } from "./rich-text.js";
import type { Translator } from "../text/translator.js";
import { aiRefusalKey, draftFailureKey } from "../text/ai-refusal-copy.js";
import type { DraftReplyControl, DraftReplyPhase, OwnText } from "./draft-reply-control.js";

export type { DraftReplyControl, DraftReplyPhase, OwnText } from "./draft-reply-control.js";

/** One draft, in the shape the editor holds. */
export type DraftedReply = RichValue;

/** What `GET /drafts/:id` answers, in the members this flow reads. */
export interface DraftReplyRead {
  body?: string;
  html?: string | null;
}

/**
 * The two calls a draft makes, gathered into something a host can hand in, the way
 * `SuggestWire` gathers the Screener's. What varies between the doors is only how the bytes
 * travel: the browser asks the API, the desktop its engine over the private pipe, a paired
 * browser the host computer over its bearer. When to spend, the press's key and what lands in the
 * editor stay here and cannot be forked.
 *
 * Two named calls rather than a generic `request(path)`: a host's transport then addresses
 * exactly these two routes (`draft-reply-wire.ts` writes them once for both engine doors), and
 * shared code cannot send anything else down the pipe through this seam.
 */
type DraftPreview = (body: string) => void;

export interface DraftReplyWire {
  /** Is there anything to ask at all? False shows the unavailable notice and spends nothing. */
  configured: () => boolean;
  /**
   * `POST /messages/:id/draft`, the purchase. The key is the caller's, minted once per press and
   * reused on a retry of that press, so a lost answer is replayed instead of bought twice.
   */
  create: (
    messageId: ParamsOf<"POST /messages/:id/draft">["id"], idempotencyKey: string, onPreview?: DraftPreview,
  ) => Promise<AnswerOf<"POST /messages/:id/draft">>;
  /** `GET /drafts/:id`, the draft that purchase wrote. A read; it spends nothing. */
  read: (draftId: string) => Promise<DraftReplyRead>;
  /**
   * `POST /drafts/from-text`, a purchase made of the person's own words, under the caller's key as {@link create}.
   * `none`: this host has no door for it.
   */
  fromText:
    | ((body: RequestOf<"POST /drafts/from-text">, idempotencyKey: string, onPreview?: DraftPreview) => Promise<AnswerOf<"POST /drafts/from-text">>)
    | "none";
  /**
   * The `draftReply` sentence for 503 `drafter_unconfigured` on a door where the person can fix
   * it: a desktop install's model is chosen in its own settings. Absent (the web, a desktop on an
   * account): the server's sentence, since only its operator can connect a drafter.
   */
  noModel?: "noModelHere" | "noModelHost";
}

/**
 * What one draft costs: 15 credits. The plan is sold in CREDITS and an action has its own price
 * (a draft 15 against a classification's 1, on the metering service's card). A literal, not an
 * import: the webapp takes no dependency on `@trafficflow/db` (`connect-gate-order.test.ts`
 * asserts it), and `test/landing-pricing-matches-plan-card.test.ts` holds this literal to the
 * metering service's own card. `DraftingService` still spends once per request.
 */
export const DRAFT_REPLY_COST_CREDITS = 15;

/** The new letter's place among the letters a draft is bought for: no message's id has this shape. */
export const NEW_LETTER = "letter:new";

export function useDraftReply(opts: {
  /**
   * Where the answer goes. Called with the drafted reply and the message it answers; the
   * CALLER decides whether it replaces or is appended to whatever is already typed, because
   * only the caller can see the editor. `letter`: a new letter's draft, under the id its press named.
   */
  onDraft: (draft: DraftedReply, messageId: string, of: "reply" | "letter") => void;
  /**
   * The host's draft wire, as its contract answers `draftReply`: the web hands the server client's, the desktop its
   * engine's, a paired browser its host computer's. `none`: this host has no drafter. The hook then answers no
   * control (`null`), so nothing can open an offer, and no request is ever made. There is no fallback: a wire is
   * never assumed for a host that named none.
   */
  wire: DraftReplyWire | "none";
  /** The whole catalogue's reader, as the host's text package answers it: the `draftReply` and `aiRefusal` sentences. */
  t: Translator;
}): DraftReplyControl | null {
  const { onDraft, wire, t } = opts;

  const [phase, setPhase] = useState<DraftReplyPhase>("closed");
  const [messageId, setMessageId] = useState<string | null>(null);
  const [preview, setPreview] = useState<string>();
  const [notice, setNotice] = useState<string | null>(null);
  const [own, setOwn] = useState<ReadonlyMap<string, OwnText>>(() => new Map());

  /**
   * The press counter, and the key of the press in flight.
   *
   * `run` discards an answer that arrives after the user has moved on — the same guard
   * `screener-suggest.ts` keeps for its dry runs. `key` is minted ONCE per press and reused if
   * that press has to be retried at the transport level, which is what makes a lost response
   * replay instead of buying a second draft; a second deliberate press is a different purchase
   * and gets a different key. `flight` is the letter of the purchase out; `letGo`: that reply was sent or discarded
   * since the press, so the words the press handed are no longer the person's text to keep; `away`: the new letter the
   * press was made for left the composer since, so its answer fills no letter.
   */
  const io = useRef<{
    run: number; key: string | null; of: string | null; busy: boolean; flight: string | null; letGo: boolean;
    away: boolean;
  }>({
    run: 0, key: null, of: null, busy: false, flight: null, letGo: false, away: false,
  });

  /* Neither `open` nor `cancel` clears `busy`: only the answer of the request in flight does (a purchase is out). */
  const open = useCallback((id: string) => {
    io.current.run += 1;
    io.current.key = null;
    setPreview(undefined);
    setMessageId(id);
    setNotice(null);
    setPhase("offered");
  }, []);

  const cancel = useCallback(() => {
    io.current.run += 1;
    io.current.key = null;
    setPreview(undefined);
    setPhase("closed");
    setNotice(null);
  }, []);

  /**
   * `of` names the purchase the kept key belongs to: the same purchase pressed again after a failure reuses it, any
   * other is a new one. `busy` holds a press while one runs, read before React has drawn the first: two presses in one
   * moment send one request.
   */
  const spend = useCallback((
    id: string, of: string, buy: (key: string, onPreview: DraftPreview) => ReturnType<DraftReplyWire["create"]>, typed: RichValue | null,
    lands: "reply" | "letter",
  ) => {
    if (wire === "none" || io.current.busy) return;
    if (!wire.configured()) {
      // No route is available. Saying so beats a spinner that never resolves.
      setNotice(t("draftReply.unavailable"));
      return;
    }
    if (io.current.of !== of) io.current.key = null;
    io.current.of = of;
    const run = ++io.current.run;
    io.current.key ??= newKey();
    const key = io.current.key;
    io.current.busy = true;
    io.current.flight = id;
    io.current.letGo = false;
    io.current.away = false;
    setPreview(undefined);
    setPhase("running");
    setNotice(t("draftReply.running"));

    void (async () => {
      /**
       * WHICH STEP FAILED — because the opaque sentence below is a claim about the draft, and only
       * the SECOND step can honestly make it.
       *
       * One `catch` covers both requests. The failure sentence for an unhandled fault says "the
       * draft was written but could not be loaded", which is true when the 202 already came back
       * and the read is what died — and FALSE when the paid POST itself faulted, where no draft
       * exists and nothing was written. Saying it anyway would be the app inventing a row and
       * telling somebody their money bought it.
       */
      let bought = false;
      try {
        const { draftId } = await buy(key, (text) => {
          if (io.current.run === run && !io.current.letGo && !io.current.away) setPreview(text);
        });
        bought = true;
        // `GET /drafts/:id` rather than the mirror — see the header. `cost: read`, spends
        // nothing, and the row was written inside the request that answered above.
        const draft = await wire.read(draftId);
        const letGo = io.current.letGo;
        const away = io.current.away;
        io.current.busy = false;
        if (io.current.run !== run) return;
        setPreview(undefined);
        io.current.key = null;
        setPhase("closed");
        /* The new letter it was made for left the composer: no letter takes it, it stays in Drafts, and that is said. */
        if (lands === "letter" && away) {
          setOwn((all) => without(all, id));
          setNotice(t("draftReply.letterLeft"));
          return;
        }
        setNotice(null);
        const landed = { text: draft.body ?? "", html: draft.html ?? "" };
        /*
         * This letter's entry alone. Over the person's own words: they stay one tab away. Over none (or words let go
         * with their reply since the press): the draft is kept with no text of theirs, so it is drafted again as a
         * draft. The old card's confirm hands nothing: its entry is let go.
         */
        setOwn((all) => typed === null
          ? without(all, id)
          : withEntry(all, {
            messageId: id, yours: letGo || isRichEmpty(typed) ? NO_TEXT : typed, draft: landed, shown: "draft",
          }));
        onDraft(landed, id, lands);
      } catch (err) {
        io.current.busy = false;
        if (io.current.run !== run) return;
        setPreview(undefined);
        setPhase("offered");
        const paid = draftFailureKey(err);
        // The server settled this key. A deliberate new press can buy a fresh attempt.
        // An opaque failure keeps the key so a lost response can still be recovered.
        if (paid === "creditsUsed") io.current.key = null;
        const noModel = wire.noModel !== undefined
          && (err as { code?: unknown } | null)?.code === "drafter_unconfigured" ? wire.noModel : null;
        const key = aiRefusalKey(err);
        /* The three AI refusals both surfaces share (`ai-refusal-copy.ts`) are the `aiRefusal` sentences. */
        setNotice(paid !== null
          ? t(`draftReply.${paid}`)
          : noModel !== null
            ? t(`draftReply.${noModel}`)
            : key === null
              ? messageFor(
                  err,
                  t("draftReply.failed"),
                  bought ? t("draftReply.failedOpaque") : t("draftReply.failedOpaqueEarly"),
                )
              : t(`aiRefusal.${key}`));
      }
    })();
  }, [onDraft, t, wire]);

  const confirm = useCallback(() => {
    if (wire === "none" || !messageId || phase === "running") return;
    spend(messageId, messageId, (key, progress) => wire.create(messageId, key, progress), null, "reply");
  }, [messageId, phase, spend, wire]);

  const press = useCallback((id: string, typed: RichValue) => {
    if (wire === "none" || phase === "running" || io.current.busy) return;
    setMessageId(id);
    spend(id, id, (key, progress) => wire.create(id, key, progress), typed, "reply");
  }, [phase, spend, wire]);

  /* The door for a draft made of the person's own words: the host's, or `none` (also where the host has no drafter). */
  const textWire = wire === "none" ? "none" : wire.fromText;
  const pressText = useCallback((id: string, text: string, typed: RichValue) => {
    if (textWire === "none" || io.current.busy) return;
    setMessageId(id);
    spend(id, `${id}\n${text}`, (key, progress) => textWire({ text, inReplyToMessageId: id }, key, progress), typed, "reply");
  }, [spend, textWire]);

  const pressLetter = useCallback((
    words: { text: string; mailboxId: string | null; subject: string }, typed: RichValue,
  ) => {
    const id = NEW_LETTER;
    if (textWire === "none" || io.current.busy) return;
    setMessageId(id);
    const body = {
      text: words.text,
      ...(words.mailboxId !== null ? { mailboxId: words.mailboxId } : {}),
      ...(words.subject.trim() !== "" ? { subject: words.subject } : {}),
    };
    spend(id, `${id}\n${words.mailboxId ?? ""}\n${words.subject}\n${words.text}`, (key, progress) => textWire(body, key, progress), typed, "letter");
  }, [spend, textWire]);

  const keep = useCallback((o: OwnText) => setOwn((all) => withEntry(all, o)), []);
  const forget = useCallback((id: string) => {
    if (io.current.busy && io.current.flight === id) {
      io.current.letGo = true;
      setPreview(undefined);
    }
    setOwn((all) => without(all, id));
  }, []);
  const moved = useCallback((id: string) => {
    if (io.current.busy && io.current.flight === id) {
      io.current.letGo = true;
      io.current.away = true;
      setPreview(undefined);
    }
    setOwn((all) => without(all, id));
  }, []);
  const restore = useCallback((id: string) => {
    if (io.current.busy && io.current.flight === id) {
      io.current.letGo = false;
      io.current.away = false;
    }
  }, []);

  /* No drafter on this host: no control. Said after the hooks, which a mounted hook may not skip. */
  if (wire === "none") return null;
  return {
    offered: true,
    phase,
    preview,
    messageId,
    cost: DRAFT_REPLY_COST_CREDITS,
    notice,
    open,
    cancel,
    confirm,
    press,
    fromText: textWire !== "none" ? pressText : "none",
    letter: textWire !== "none" ? pressLetter : "none",
    letterId: NEW_LETTER,
    own,
    keep,
    forget,
    moved,
    restore,
  };
}

/**
 * The server's own sentence — or an honest one when the server did not give one. Every refusal on this path was
 * written to be read: "no AI credits remain on this account" (402),
 * "this deployment has no AI drafter connected" (503) — passed through verbatim. An unhandled fault is not one of
 * them: a 500's envelope is `{"error":{"code":"internal","message":"internal error"}}`, and quoting it puts "internal
 * error" in front of a person as though the app were explaining itself — which this surface did while `GET
 * /drafts/:id` answered 500 to an id it could not parse: the button failed, said nothing usable, and re-offered
 * itself. The server half is fixed (a malformed id is now a 400 with a real sentence); this arm is for the next
 * unmodelled fault.
 */

/**
 * The test is the `code`, not the status. The obvious rule — `status >= 500` — is wrong, and
 * `draft-reply.test.tsx` said so within a minute: "this deployment has no AI drafter connected"
 * is a 503 and one of the most useful sentences on the path. `errorResponse("internal", …)` is
 * the API's envelope for a throw nobody modelled — the only case where the message is machine
 * noise — and every deliberate refusal carries a code of its own. An empty message is caught
 * too: a blank notice is the same failure with fewer characters. `status === 0` is the
 * transport's own "we never reached ohmail", already a true sentence from `api-client`, and is
 * left alone.
 */
export function messageFor(err: unknown, fallback: string, opaque: string): string {
  if (!isRefusal(err)) return fallback;
  return err.code === "internal" || err.message.trim() === "" ? opaque : err.message;
}

/**
 * A refusal that came off a wire with its envelope: the browser's `ApiError`, or a host
 * transport's own class (the desktop's `DraftReplyRefused`) carrying the same status, code and
 * sentence. Read by shape alone, as `ai-refusal-copy.ts` reads `code`, so that this file names no
 * transport's class; a bare `Error` (a transport that never reached a server) has no status and
 * keeps the fallback. So does a host refusal with an
 * empty code: its body was no envelope (an HTML 502 from a relay), and its message is only the
 * transport's English "answered 502".
 */
function isRefusal(err: unknown): err is Error & { status: number; code: string } {
  const e = err as { status?: unknown; code?: unknown } | null;
  return err instanceof Error && typeof e?.status === "number" && typeof e.code === "string" && e.code !== "";
}

const NO_TEXT: RichValue = { text: "", html: "" };

/** The kept texts with `o` for its letter; no other letter's entry changes. */
function withEntry(all: ReadonlyMap<string, OwnText>, o: OwnText): ReadonlyMap<string, OwnText> {
  return new Map(all).set(o.messageId, o);
}

/** The kept texts without `id`'s; the same map when it held none. */
function without(all: ReadonlyMap<string, OwnText>, id: string): ReadonlyMap<string, OwnText> {
  if (!all.has(id)) return all;
  const next = new Map(all);
  next.delete(id);
  return next;
}

/** A fresh idempotency key — see `screener-suggest.ts` for why the fallback exists. */
function newKey(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `dr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
