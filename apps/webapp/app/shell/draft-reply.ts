"use client";

/**
 * Buying a drafted reply — the control that names the cost before it spends, and hands the answer to the editor
 * rather than the wire. Two non-negotiable invariants: NOTHING SENDS — AI proposes and the user decides; the text
 * lands in the reply editor and stops there — no `mail_send`, no triage change, and no discharge of the Reply Run's
 * debt (that is `onSendSettled`'s, keyed on a SEND settling). And THE COST IS STATED BEFORE IT IS TAKEN — one draft
 * is 15 credits ({@link DRAFT_REPLY_COST_CREDITS}), the figure the route charges, not one computed from a balance.
 */

/**
 * The price is a constant here and a dry run in the Screener: the batch's size is a question only the server can
 * answer, while one press here is one message — but the client never decides affordability; the server's refusal
 * renders verbatim. The 202 carries only `{draftId}`; the draft is read directly with `GET /drafts/:id` (a `read`
 * route that spends nothing) rather than waiting on the sync cadence — the mirror still converges, it is just not
 * what is waited on.
 */

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { AnswerOf, RequestOf } from "@ohmail/wire";
import { NONE, type None } from "@ohmail/app/host";
import { ApiError, api, apiConfigured } from "../api-client";
import { isRichEmpty, type RichValue } from "@ohmail/app-logic/writing/rich-text";
import { aiRefusalKey, draftFailureKey } from "./ai-refusal-copy";

/**
 * `closed` — the verb is idle.
 * `offered` — the cost is on screen and nothing has been spent.
 * `running` — the request is in flight.
 */
export type DraftReplyPhase = "closed" | "offered" | "running";

export interface DraftReplyControl {
  /**
   * The host handed a draft wire: the reply's draft control is drawn. False (a host that answers `none`, the demo):
   * no control is drawn, nothing is offered and nothing can be asked.
   */
  offered: boolean;
  phase: DraftReplyPhase;
  /** The message the offer is about, so a stale offer cannot be confirmed against another. */
  messageId: string | null;
  /** What one press costs, in CREDITS. Stated before {@link confirm} is reachable. */
  cost: number;
  /** One sentence about the current state, already translated, or null. */
  notice: string | null;
  /** Offer to draft a reply to this message. Spends nothing. */
  open: (messageId: string) => void;
  cancel: () => void;
  /** Spend, and hand the result to `onDraft`. */
  confirm: () => void;
  /**
   * The offer and the purchase in one press, for a control that states its cost on itself. Pressed again for the
   * same message after a failure it retries that purchase with its key; a press while one runs does nothing. `own` is
   * the person's own text in that reply as the press found it: kept as {@link own} once the draft lands over it.
   */
  press: (messageId: string, own: RichValue) => void;
  /**
   * A draft made of the person's own words in the reply to this message, in one press, as {@link press} is: one key
   * per press, the same words pressed again after a failure retry that purchase, a press while one runs does nothing.
   * `none` where the host has no door for it: the control does not offer it.
   */
  fromText: ((messageId: string, text: string, own: RichValue) => void) | None;
  /**
   * A new letter drafted from the person's own words: the words, the address it goes from and its subject, as
   * {@link fromText} is pressed, kept under {@link NEW_LETTER}. `none` exactly when {@link fromText} is.
   */
  letter: ((words: { text: string; mailboxId: string | null; subject: string }, own: RichValue) => void) | None;
  /** {@link NEW_LETTER}: the new letter's `messageId` while its draft is out, and its entry of `own`. */
  letterId: string;
  /**
   * The person's own text in each reply a draft landed over, and that draft: the reply's two tabs, by the letter's
   * id. Kept here, in memory only, until a send of that reply settles or the reply is discarded (a reload drops it);
   * a draft on another letter never touches it.
   */
  own: ReadonlyMap<string, OwnText>;
  /** The two texts as they stand now, kept for their letter when the person changes tabs. */
  keep: (own: OwnText) => void;
  /** That reply was sent or discarded: its own text is let go. */
  forget: (messageId: string) => void;
  /**
   * The new letter left the composer (another letter took its place, or it was sent or discarded): its own text is let
   * go, and a draft still out for it fills no letter; it stays in Drafts, and the notice says so.
   */
  moved: (messageId: string) => void;
  /** A discard of that reply or letter was undone: a draft still out for it lands, keeping the words its press handed. */
  restore: (messageId: string) => void;
}

/** The person's own text beside the draft that landed over it, and which of the two the reply shows. */
export interface OwnText {
  readonly messageId: string;
  readonly yours: RichValue;
  readonly draft: RichValue;
  readonly shown: "yours" | "draft";
}

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
export interface DraftReplyWire {
  /** Is there anything to ask at all? False shows the unavailable notice and spends nothing. */
  configured: () => boolean;
  /**
   * `POST /messages/:id/draft`, the purchase. The key is the caller's, minted once per press and
   * reused on a retry of that press, so a lost answer is replayed instead of bought twice.
   */
  create: (messageId: string, idempotencyKey: string) => Promise<{ draftId: string }>;
  /** `GET /drafts/:id`, the draft that purchase wrote. A read; it spends nothing. */
  read: (draftId: string) => Promise<DraftReplyRead>;
  /**
   * `POST /drafts/from-text`, a purchase made of the person's own words, under the caller's key as {@link create}.
   * `none`: this host has no door for it.
   */
  fromText:
    | ((body: RequestOf<"POST /drafts/from-text">, idempotencyKey: string) => Promise<AnswerOf<"POST /drafts/from-text">>)
    | None;
  /**
   * The `draftReply` sentence for 503 `drafter_unconfigured` on a door where the person can fix
   * it: a desktop install's model is chosen in its own settings. Absent (the web, a desktop on an
   * account): the server's sentence, since only its operator can connect a drafter.
   */
  noModel?: "noModelHere" | "noModelHost";
}

/**
 * The hosted transport, and the default, so the web is unchanged. Each member reaches `api` only
 * when called: a module that merely imports this one (every test that mocks `api-client` without
 * `api`) touches nothing at load, as before the wire existed.
 */
export const CLOUD_WIRE: DraftReplyWire = {
  configured: () => apiConfigured(),
  create: (id, idempotencyKey) => api<{ draftId: string }>(`/messages/${id}/draft`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
  }),
  read: (draftId) => api<DraftReplyRead>(`/drafts/${draftId}`),
  fromText: (body, idempotencyKey) => api<AnswerOf<"POST /drafts/from-text">>("/drafts/from-text", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body,
  }),
};

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
   * The host's wire: the web hands {@link CLOUD_WIRE}, the desktop and the paired page their engine's. Absent (a host
   * that answers `none`, the demo): nothing is offered to the reply's control and Draft from your text is `none`; the
   * old card's verb keeps the hosted client.
   */
  wire?: DraftReplyWire;
}): DraftReplyControl {
  const t = useTranslations("draftReply");
  /** The three AI refusals both surfaces share — see `ai-refusal-copy.ts`. */
  const tAi = useTranslations("aiRefusal");
  const { onDraft } = opts;
  const hosted = opts.wire !== undefined;
  const wire = opts.wire ?? CLOUD_WIRE;

  const [phase, setPhase] = useState<DraftReplyPhase>("closed");
  const [messageId, setMessageId] = useState<string | null>(null);
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
    setMessageId(id);
    setNotice(null);
    setPhase("offered");
  }, []);

  const cancel = useCallback(() => {
    io.current.run += 1;
    io.current.key = null;
    setPhase("closed");
    setNotice(null);
  }, []);

  /**
   * `of` names the purchase the kept key belongs to: the same purchase pressed again after a failure reuses it, any
   * other is a new one. `busy` holds a press while one runs, read before React has drawn the first: two presses in one
   * moment send one request.
   */
  const spend = useCallback((
    id: string, of: string, buy: (key: string) => Promise<{ draftId: string }>, typed: RichValue | null,
    lands: "reply" | "letter",
  ) => {
    if (io.current.busy) return;
    if (!wire.configured()) {
      // No route is available. Saying so beats a spinner that never resolves.
      setNotice(t("unavailable"));
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
    setPhase("running");
    setNotice(t("running"));

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
        const { draftId } = await buy(key);
        bought = true;
        // `GET /drafts/:id` rather than the mirror — see the header. `cost: read`, spends
        // nothing, and the row was written inside the request that answered above.
        const draft = await wire.read(draftId);
        const letGo = io.current.letGo;
        const away = io.current.away;
        io.current.busy = false;
        if (io.current.run !== run) return;
        io.current.key = null;
        setPhase("closed");
        /* The new letter it was made for left the composer: no letter takes it, it stays in Drafts, and that is said. */
        if (lands === "letter" && away) {
          setOwn((all) => without(all, id));
          setNotice(t("letterLeft"));
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
        /**
         * BACK TO THE OFFER, AND NO RETRY LOOP. Every refusal on this path already has a true sentence written by the
         * code that made the decision — "no AI credits remain on this account" (402), "cannot AI-draft a sensitive
         * message" (422), "this deployment has no AI drafter connected" (503) — and a second taxonomy here is how
         * somebody with an empty balance is told the model is down. The key is kept: if the user presses again it is
         * the SAME purchase being retried, which is what stops a lost response from being charged twice. Nothing
         * retries on its own, because a 402 retried in a loop is a person being asked to buy something they have
         * already been told they cannot afford.
         */
        setPhase("offered");
        // THE THREE REFUSALS EVERY DEPLOYMENT CAN MAKE COME OUT OF THE CATALOGUE, by their code,
        // for the Screener's reason: the server's `message` is English written for a log.
        // THE CHARGED-AND-FAILED PAIR FIRST — the only refusal here that knows what happened to
        // the person's money. An unmodelled fault does not (a killed request answers with no
        // envelope at all), so `failedOpaqueEarly` says only what the kept key makes true.
        const paid = draftFailureKey(err);
        const noModel = wire.noModel !== undefined
          && (err as { code?: unknown } | null)?.code === "drafter_unconfigured" ? wire.noModel : null;
        const key = aiRefusalKey(err);
        setNotice(paid !== null
          ? t(paid)
          : noModel !== null
            ? t(noModel)
            : key === null
              ? messageFor(err, t("failed"), bought ? t("failedOpaque") : t("failedOpaqueEarly"))
              : tAi(key));
      }
    })();
  }, [onDraft, t, tAi, wire]);

  const confirm = useCallback(() => {
    if (!messageId || phase === "running") return;
    spend(messageId, messageId, (key) => wire.create(messageId, key), null, "reply");
  }, [messageId, phase, spend, wire]);

  const press = useCallback((id: string, typed: RichValue) => {
    if (phase === "running" || io.current.busy) return;
    setMessageId(id);
    spend(id, id, (key) => wire.create(id, key), typed, "reply");
  }, [phase, spend, wire]);

  const textWire = wire.fromText;
  const pressText = useCallback((id: string, text: string, typed: RichValue) => {
    if (!hosted || textWire === NONE || io.current.busy) return;
    setMessageId(id);
    spend(id, `${id}\n${text}`, (key) => textWire({ text, inReplyToMessageId: id }, key), typed, "reply");
  }, [hosted, spend, textWire]);

  const pressLetter = useCallback((
    words: { text: string; mailboxId: string | null; subject: string }, typed: RichValue,
  ) => {
    const id = NEW_LETTER;
    if (!hosted || textWire === NONE || io.current.busy) return;
    setMessageId(id);
    const body = {
      text: words.text,
      ...(words.mailboxId !== null ? { mailboxId: words.mailboxId } : {}),
      ...(words.subject.trim() !== "" ? { subject: words.subject } : {}),
    };
    spend(id, `${id}\n${words.mailboxId ?? ""}\n${words.subject}\n${words.text}`, (key) => textWire(body, key), typed, "letter");
  }, [hosted, spend, textWire]);

  const keep = useCallback((o: OwnText) => setOwn((all) => withEntry(all, o)), []);
  const forget = useCallback((id: string) => {
    if (io.current.busy && io.current.flight === id) io.current.letGo = true;
    setOwn((all) => without(all, id));
  }, []);
  const moved = useCallback((id: string) => {
    if (io.current.busy && io.current.flight === id) {
      io.current.letGo = true;
      io.current.away = true;
    }
    setOwn((all) => without(all, id));
  }, []);
  const restore = useCallback((id: string) => {
    if (io.current.busy && io.current.flight === id) {
      io.current.letGo = false;
      io.current.away = false;
    }
  }, []);

  return {
    offered: hosted,
    phase,
    messageId,
    cost: DRAFT_REPLY_COST_CREDITS,
    notice,
    open,
    cancel,
    confirm,
    press,
    fromText: hosted && textWire !== NONE ? pressText : NONE,
    letter: hosted && textWire !== NONE ? pressLetter : NONE,
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
 * written to be read: "no AI credits remain on this account" (402), "cannot AI-draft a sensitive message" (422),
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
 * sentence. Read by shape, as `ai-refusal-copy.ts` reads `code`; a bare `Error` (a transport that
 * never reached a server) has no status and keeps the fallback. So does a host refusal with an
 * empty code: its body was no envelope (an HTML 502 from a relay), and its message is only the
 * transport's English "answered 502".
 */
function isRefusal(err: unknown): err is Error & { status: number; code: string } {
  if (err instanceof ApiError) return true;
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
