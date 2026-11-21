/**
 * DRAFT REPLY IN ONE PRESS: the kit's draft control at the reply's foot, its price said on it before the press where
 * drafting is charged, the press buying and placing the draft (the composition's `press`: one key per press, a retry
 * reuses it). While the reply holds the person's own words, and the host has a door for it, the control drafts from
 * them ("Draft from your text"); where it has none the word is not drawn and the plain control stands. An empty
 * balance the host knows of is said before the press. A draft that lands over typed words takes their place on
 * screen; the person's own text stays one tab away (the tabs over the text), kept by the composition (`own`) until
 * the reply is sent or discarded, whether the reply is closed and opened again or drafted again; not past a reload.
 * Nothing is asked of a server before the press.
 */
import { useEffect, useState, type ReactNode } from "react";
import { isRichEmpty, type RichValue } from "@ohmail/app-logic/writing/rich-text";
import { Button } from "@ohmail/ui/base";
import { DraftControl, DraftTabs, GroupHeading } from "@ohmail/ui/mail";
import { useOptionalReport } from "../../frame/commands.js";
import { useText, type Text } from "../../text/index.js";
import { useWriteBeside, useWriting } from "../above.js";
import type { WriteDraftControl, WriteOwnText } from "../ports.js";

type Shown = "yours" | "draft";

/**
 * The person's own text and the draft beside it, as two tabs over the text, while their text holds words (a draft over
 * none has nothing to show beside it). A tab press puts that text in place; the text leaving keeps its latest words.
 */
function ownTabs(
  t: Text,
  control: WriteDraftControl,
  texts: WriteOwnText | null,
  now: RichValue,
  put: (next: RichValue) => void,
): ReactNode | undefined {
  if (texts === null || isRichEmpty(texts.yours)) return undefined;
  const show = (shown: Shown): void => {
    if (shown === texts.shown) return;
    control.keep(shown === "yours" ? { ...texts, draft: now, shown } : { ...texts, yours: now, shown });
    put(shown === "yours" ? texts.yours : texts.draft);
  };
  return (
    <DraftTabs
      label={t("draft.tabs")}
      options={[
        { value: "yours", label: t("draft.yours") },
        { value: "draft", label: t("draft.draft") },
      ]}
      value={texts.shown}
      onChange={show}
    />
  );
}

export interface DraftOffer {
  /** The control for the foot's end. */
  readonly control: ReactNode;
  /** The drafter's sentence about this reply (a refusal, the balance), or null. */
  readonly notice: string | null;
  /** The two texts once a draft landed over typed words; undefined: none. */
  readonly tabs: ReactNode | undefined;
  /** A draft is being written for this reply. */
  readonly drafting: boolean;
}

/** The reply's draft offer; null where the host hands no draft wire (nothing is drawn). */
export function useDraftOffer(messageId: string): DraftOffer | null {
  const t = useText("write");
  const w = useWriting();
  const beside = useWriteBeside();
  const draftReply = useText("draftReply");
  const { control, pending, resolve, noCredits } = w.draftReplyChrome;
  const here = control.messageId === messageId;
  const drafting = here && control.phase === "running";
  /* A draft for another letter is being written: this one waits, and says so. */
  const waiting = !here && control.phase === "running";
  const waitingWord = control.messageId === control.letterId ? t("draft.waitingLetter") : t("draft.waiting");
  /* The person's own text and the draft beside it, as the composition keeps them for this reply. */
  const texts = control.own.get(messageId) ?? null;
  /* A draft that landed over typed words takes their place; the press handed them, and the composition keeps them. */
  const landed = pending !== null && pending.messageId === messageId ? pending : null;
  useEffect(() => {
    if (landed !== null) resolve("replace");
  }, [landed, resolve]);
  const priced = beside.metered && noCredits !== true;
  const cost = priced ? t("draft.cost", { cost: control.cost }) : undefined;
  /* A draft on screen as it landed is drafted again from what it was made of; an edited one is the person's text. */
  const untouched = texts !== null && texts.shown === "draft" && w.replyBody.text === texts.draft.text;
  const made = untouched ? texts.yours : w.replyBody;
  const madeOf = made.text;
  const fromText = control.fromText;
  const ownWords = fromText !== "none" && madeOf.trim() !== "";
  const label = drafting
    ? t("draft.running")
    : waiting
      ? waitingWord
      : untouched
        ? t("draft.again")
        : ownWords
          ? t("draft.fromText")
          : t("draft.verb");
  const title =
    cost === undefined || waiting
      ? label
      : ownWords && !untouched
        ? t("draft.fromTextTitle", { cost: control.cost })
        : t("draft.title", { cost: control.cost });
  if (!control.offered) return null;
  return {
    control: (
      <DraftControl
        label={label}
        title={beside.metered || drafting || waiting ? title : draftReply("offerBodyUnmetered")}
        cost={cost}
        busy={drafting || waiting}
        /* Another letter's draft is being written: this one cannot be pressed until it lands, and says so. */
        disabled={waiting}
        onPress={() => (ownWords ? fromText(messageId, madeOf, made) : control.press(messageId, made))}
      />
    ),
    notice:
      here && control.notice !== null ? control.notice : noCredits === true ? t("draft.noCredits") : null,
    tabs: ownTabs(t, control, texts, w.replyBody, (next) => w.onReplyBody(next)),
    drafting,
  };
}

/**
 * A NEW LETTER's draft, made of the person's own words, the address it goes from and its subject: quiet ("Draft")
 * until words are written, and a press with none says so and asks nothing. Where the host has no door for drafting
 * from words, none is drawn, and none on a forward (as a reply offers none on one). The draft takes the letter's words;
 * the person's own stay one tab away, kept by the composition until the letter is sent or discarded.
 */
export function useLetterDraftOffer(): DraftOffer | null {
  const t = useText("write");
  const w = useWriting();
  const beside = useWriteBeside();
  const { control, noCredits } = w.draftReplyChrome;
  const { compose } = w;
  const id = control.letterId;
  const [asked, setAsked] = useState(false);
  const here = control.messageId === id;
  const drafting = here && control.phase === "running";
  const waiting = !here && control.phase === "running";
  const texts = control.own.get(id) ?? null;
  const body = { text: compose.body, html: compose.html };
  const untouched = texts !== null && texts.shown === "draft" && body.text === texts.draft.text;
  const made = untouched ? texts.yours : body;
  const words = made.text.trim() !== "";
  const letter = control.letter;
  const priced = beside.metered && noCredits !== true;
  const set = (next: RichValue): void => w.onComposeFields({ ...compose, body: next.text, html: next.html });
  if (!control.offered || letter === "none" || Boolean(compose.forwardOf)) return null;
  const fromText = !drafting && !waiting && !untouched;
  const word = drafting
    ? t("draft.running")
    : waiting
      ? t("draft.waiting")
      : untouched
        ? t("draft.again")
        : t("draft.fromText");
  const label = fromText && !words ? t("draft.letterVerb") : word;
  const cost = priced && words ? t("draft.cost", { cost: control.cost }) : undefined;
  const press = (): void => {
    if (!words) {
      setAsked(true);
      return;
    }
    setAsked(false);
    letter({ text: made.text, mailboxId: w.composeFrom.mailboxId, subject: compose.subject }, made);
  };
  const notice =
    here && control.notice !== null
      ? control.notice
      : noCredits === true
        ? t("draft.noCredits")
        : asked && !words
          ? t("draft.nothingYet")
          : null;
  return {
    control: (
      <DraftControl
        label={label}
        word={word}
        short={fromText ? t("draft.fromTextShort") : undefined}
        title={cost === undefined || waiting ? word : t("draft.fromTextTitle", { cost: control.cost })}
        cost={cost}
        idle={!words}
        busy={drafting || waiting}
        onPress={press}
      />
    ),
    notice,
    tabs: ownTabs(t, control, texts, body, set),
    drafting,
  };
}

/** A saved offer can fill the envelope as well as the text. It keeps the sender already chosen. */
export function OfferedLetterDraft({ locked, focus }: { locked: boolean; focus: () => void }) {
  const { offeredDraft, takeOfferedDraft } = useWriting();
  const report = useOptionalReport();
  const t = useText("compose");
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!offeredDraft || !takeOfferedDraft || dismissed === offeredDraft.id) return null;
  const hide = () => setDismissed(offeredDraft.id);
  const take = (said: boolean) => {
    hide();
    void takeOfferedDraft(offeredDraft.id);
    if (said) report?.(t("toastUseDraft"));
    requestAnimationFrame(focus);
  };
  return (
    <section aria-label={t("draftTag")}>
      <GroupHeading>{t("draftTag")}</GroupHeading>
      <p className="oh-text">{offeredDraft.body}</p>
      {offeredDraft.rationale ? <p className="oh-text">{offeredDraft.rationale}</p> : null}
      <div>
        <Button kind="ink" size="s" disabled={locked} onPress={() => take(true)}>
          {t("useDraft")}
        </Button>
        <Button kind="quiet" size="s" disabled={locked} onPress={() => take(false)}>
          {t("edit")}
        </Button>
        <Button
          kind="quiet"
          size="s"
          disabled={locked}
          onPress={() => {
            hide();
            report?.(t("toastDiscard"));
          }}
        >
          {t("discard")}
        </Button>
      </div>
    </section>
  );
}
