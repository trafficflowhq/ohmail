/**
 * THE NEW LETTER, in the reading column: the kit's reading sheet with the composer filling it, its people and
 * subject at the head, the shell's editor as its text, what happened to it over its lines, and its verbs at the foot.
 * Every word, person and file lives in the composition; this view holds the open lines and nothing of the letter.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Composer, Sheet, type RecipientsProps } from "@ohmail/ui/mail";
import { COMPOSE_SEND_KEY, sendRefusal } from "@ohmail/app-logic/writing/mail-send";
import { useFocusFollows } from "@ohmail/app-logic/keys";
import type { PaneProps } from "../frame/contract.js";
import type { EditorHandle, Writing } from "./ports.js";
import { useText } from "../text/index.js";
import { useWriteBeside, useWriting } from "./above.js";
import { People } from "./head/People.js";
import { fieldIn } from "./head/field.js";
import { useLetterSendLines } from "./status/Status.js";
import { useOverLimit, type OverLimit } from "./status/over-limit.js";
import { useNeedsContent, type NeedsContent } from "./status/needs-content.js";
import { letterNote } from "./status/LetterNote.js";
import { canReassure, saveLines } from "./status/save-note.js";
import { elsewhereForSave, useWentElsewhere } from "./status/elsewhere.js";
import { useEmoji } from "./text/Emoji.js";
import { useMarks } from "./text/Marks.js";
import { modalIsOpen } from "@ohmail/app-logic/session/modal-gate";
import { useFiles } from "./files/Files.js";
import { useForwarded } from "./files/Forwarded.js";
import { letterCap } from "@ohmail/app-logic/write/files";
import { letterDiscardHeld, letterGoing, sendWaits, Verbs, type SendSaid } from "./verbs/Verbs.js";
import { Later } from "./verbs/Later.js";
import { useFromLine } from "./head/From.js";
import { useLetterKeys, useLetterWriting } from "./keys.js";
import { useSignature } from "./text/Signature.js";
import { LetterText } from "./text/LetterText.js";
import { unwritten } from "./text/unwritten.js";
import { useWritingViewport } from "./keyboard-viewport.js";
import { OfferedLetterDraft, useLetterDraftOffer } from "./draft/Draft.js";

export function Letter({ keysHere, plan }: PaneProps) {
  const t = useText("write");
  const tc = useText("compose");
  const w = useWriting();
  const { compose } = w;
  const going = useComposeSending(w);
  const locked = w.composeLocked !== null || going;
  const { files, forwarded, notKept } = useLetterFiles(locked);
  const fromLine = useFromLine(w.composeFrom, locked, (fromMailboxId) =>
    w.onComposeFields({ ...compose, fromMailboxId }),
  );
  const [laterAnchor, setLaterAnchor] = useState<HTMLElement | null>(null);
  const laterOpen = laterAnchor !== null;
  const { mayGo, long, empty, went, pressable, signature, then } = useLetterSend(
    files.model.attaching.length > 0,
  );
  const [handle, setHandle] = useState<EditorHandle | null>(null);
  const marks = useMarks(handle, !locked, plan.pointer !== "coarse");
  const lines = useLetterSendLines();
  const draft = useLetterDraftOffer();
  const drafting = draft?.drafting === true;
  const placeholder = draft === null ? t("placeholder") : t("draft.placeholder");
  /* With Send later open, Mod+Enter is the card's: it schedules, it never sends now. */
  useLetterKeys(
    keysHere,
    pressable && !laterOpen,
    () => then("send"),
    () => then("leave"),
  );
  useLetterWriting(keysHere);
  const { saving, reassurance } = useLetterSaveLines(long.line !== null, fromLine !== undefined);
  const emoji = useEmoji(handle, locked || drafting);
  const from = withStamp(fromLine, letterStamp(going, drafting, w, t, tc), reassurance);

  const { sheet, first } = useComposeFocus(keysHere, compose, t);
  const compact = useWritingViewport(sheet, plan.pointer === "coarse");
  return (
    <>
      <Sheet
        ref={sheet}
        inert={files.previewOpen}
        kind="reading"
        label={t("letter")}
        back={plan.device === "phone" ? { word: t("back"), onPress: () => then("leave") } : undefined}
        foot={
          <Verbs
            compact={compact}
            forward={Boolean(compose.forwardOf)}
            canSend={mayGo}
            going={going}
            keysHere={keysHere}
            discardHeld={letterDiscardHeld(w.composeSend)}
            resting={long.tooLong}
            said={sendSaid(empty.empty ? tc("needContent") : went.refusal, w.composeSend)}
            onSend={() => {
              if (!modalIsOpen()) then("send");
            }}
            later={{ open: laterOpen, onPress: setLaterAnchor }}
            discardReason={went.discardReason}
            onDiscard={w.discardCompose}
          />
        }
      >
        {/* The sheet names the letter: the composer inside it is no second landmark of the same name. */}
        <Composer
          fill
          going={going}
          drafting={drafting}
          tabs={draft?.tabs}
          status={lines.top}
          head={<LetterPeople from={from} locked={locked} />}
          marks={marks.strip}
          signature={signature}
          forwarded={forwarded.forwarded}
          files={files.files}
          note={letterNote(
            { wait: w.composeWaitNote, send: forkSaid(w) ? null : lines.foot },
            saving,
            long.line ?? empty.line,
            draft?.notice ?? null,
            forwarded.refusal,
            files.note ?? notKept,
            went,
          )}
          onFiles={files.onFiles}
          heldDrop={files.heldDrop}
          foot={{
            label: t("foot"),
            attach: files.attach,
            format: marks.format,
            emoji: emoji.control,
            ...(draft === null ? {} : { draft: draft.control }),
          }}
          placeholder={unwritten({ text: compose.body, html: compose.html }) ? placeholder : undefined}
        >
          <OfferedLetterDraft locked={locked} focus={() => handle?.focus({ preventScroll: true })} />
          <LetterText
            placeholder={placeholder}
            editable={!locked && !drafting}
            focusAtMount={keysHere && first === "text"}
            onSendKey={() => {
              if (pressable && !laterOpen && !modalIsOpen()) then("send");
            }}
            onLeaveKey={() => then("leave")}
            onHandle={setHandle}
          />
        </Composer>
        {marks.card}
        {emoji.menu}
      </Sheet>
      <ComposeLater
        anchor={laterAnchor}
        close={() => setLaterAnchor(null)}
        mayGo={mayGo}
        attaching={files.model.attaching}
      />
    </>
  );
}

function useComposeSending({ showSend, composeSend }: Writing): boolean {
  useEffect(() => showSend(COMPOSE_SEND_KEY), [showSend]);
  return letterGoing(composeSend);
}

function ComposeLater({
  anchor,
  close,
  mayGo,
  attaching,
}: {
  anchor: HTMLElement | null;
  close: () => void;
  mayGo: boolean;
  attaching: readonly string[];
}) {
  const w = useWriting();
  return (
    <Later
      anchor={w.compose.forwardOf ? null : anchor}
      onClose={close}
      onPick={(at) => {
        if (mayGo) w.sendCompose(at);
      }}
      forward={Boolean(w.compose.forwardOf)}
      hasFiles={(w.compose.attachments?.length ?? 0) > 0}
      attaching={attaching}
    />
  );
}

function withStamp(from: RecipientsProps["from"], label?: string, hint?: string): RecipientsProps["from"] {
  return from && { ...from, stamp: { label, hint } };
}

function letterStamp(
  going: boolean,
  drafting: boolean,
  w: Writing,
  t: ReturnType<typeof useText>,
  tc: ReturnType<typeof useText>,
): string | undefined {
  if (going) return tc("sending");
  if (drafting) return t("draft.running");
  return w.composeElsewhere === null && w.composeLocked === null ? t("draft.draft") : undefined;
}

function useComposeFocus(keysHere: boolean, compose: Writing["compose"], t: ReturnType<typeof useText>) {
  const sheet = useRef<HTMLDivElement | null>(null);
  useFocusFollows(sheet, { enter: false });
  const first = useFirstField(keysHere, compose.to, compose.subject, sheet, {
    to: t("to"),
    subject: t("subject"),
  });
  return { sheet, first };
}

/** The letter's files and a forward's, and what a schedule that ended unsent did not keep of them. */
function useLetterFiles(locked: boolean) {
  const tc = useText("compose");
  const w = useWriting();
  const beside = useWriteBeside();
  const { compose } = w;
  const files = useFiles({
    list: compose.attachments ?? [],
    onList: (attachments) => w.onComposeFields({ ...compose, attachments }),
    cap: letterCap(w.composeFrom.maxMessageBytes, beside.surface),
    locked,
    forward: Boolean(compose.forwardOf),
    letterEpochNow: w.composeEpochNow,
  });
  const forwarded = useForwarded(w.composeForwardFiles, locked);
  /* A schedule that ended unsent and whose files the door did not keep: said until files are on the letter again. */
  const notKept =
    w.composeFilesNotKept !== null && (compose.attachments?.length ?? 0) === 0
      ? tc("filesNotKept", { count: w.composeFilesNotKept })
      : null;
  return { files, forwarded, notKept };
}

/**
 * THE LETTER'S SEND: its gate, and the press Send, the chord and the signature's order go through. Send's press is
 * refused in words where the letter is too long or has nothing to send (`pressable`).
 */
function useLetterSend(attaching: boolean) {
  const w = useWriting();
  const { compose } = w;
  const { mayGo, long, empty } = useLetterGate(attaching);
  const { tooLong, refused } = long;
  const { told } = empty;
  const nothing = empty.empty;
  const send = useCallback(() => w.sendCompose(), [w]);
  const tc = useText("compose");
  const went = useWentElsewhere(w.composeElsewhere, (key) => tc(key), send);
  const elsewhere = went.refusal !== null;
  const { tell } = went;
  const go = useMemo(
    () => ({
      send: () => (mayGo ? send() : tooLong ? refused() : nothing ? told() : elsewhere ? tell() : undefined),
      leave: w.closeCompose,
    }),
    [mayGo, tooLong, refused, nothing, told, elsewhere, tell, send, w],
  );
  const { signature, then } = useSignature(
    {
      state: compose.sig,
      mailboxId: w.composeFrom.mailboxId,
      set: (sig) => w.onComposeFields({ ...compose, sig }),
      remove: w.removeComposeSig,
    },
    go,
  );
  return { mayGo, long, empty, went, pressable: mayGo || tooLong || nothing || elsewhere, signature, then };
}

/** What Send says beside its gate: why its press sends nothing (nothing to send, a row that went), and that it is at work. */
function sendSaid(refused: string | null, send: Writing["composeSend"]): SendSaid {
  return {
    ...(refused !== null ? { refused } : {}),
    busy: send.phase === "sending" && send.previous !== true,
  };
}

/** A fork is said once: the letter's own line says its row was changed elsewhere, not the send's line too. */
function forkSaid(w: Writing): boolean {
  return w.composeElsewhere?.why === "changed" && w.composeSend.code === "draft_changed";
}

/** Whether the letter is kept, said over its foot (`save-note.ts`): the close refusal, the account's refusal, the resumed note. */
function useLetterSaveLines(ceiling: boolean, hasFrom: boolean) {
  const tc = useText("compose");
  const w = useWriting();
  const { phase, previous } = w.composeSend;
  const sending = previous !== true && (phase === "sending" || sendWaits(phase));
  const sendStatusTakesPrecedence = w.composeLocked !== null || sending || phase === "unverified";
  const state = {
    closeRefusal: w.composeCloseRefusal,
    ceiling,
    saveRefused: w.composeSaveRefused,
    resumed: w.composeResumed && !sendStatusTakesPrecedence,
    elsewhere: elsewhereForSave(w.composeElsewhere),
  };
  const saved = tc("draftNote");
  return {
    saving: saveLines(state, {
      notSaved: tc("draftNotSaved"),
      resumed: tc("resumedNote"),
      saved: hasFrom ? undefined : saved,
    }),
    reassurance: hasFrom && canReassure(state) ? saved : undefined,
  };
}

/**
 * Whether Send may take the letter now; a file still being read is not on the letter yet: Send waits for it, and the
 * line over the foot says so. PAST THE DRAFT CEILING, and WITH NOTHING TO SEND, Send stays pressable: its press (or
 * the chord) sends nothing and says why.
 */
function useLetterGate(attaching: boolean): {
  readonly mayGo: boolean;
  readonly long: OverLimit;
  readonly empty: NeedsContent;
} {
  const tc = useText("compose");
  const w = useWriting();
  const beside = useWriteBeside();
  const refusal = sendRefusal(w.composeSend, w.plan.mutation);
  const held = w.composeLocked !== null || attaching;
  const long = useOverLimit(
    { refusal, held, words: w.compose },
    {
      send: () => tc("sendTooLong", beside.sendLineValues()),
      save: () => tc("bodyTooLong", beside.sendLineValues()),
    },
  );
  const empty = useNeedsContent({ refusal, held }, tc("needContent"));
  /* A letter whose row went elsewhere is not sent from here: Send rests and its press says why (`elsewhere.ts`). */
  return { mayGo: !held && refusal === null && w.composeElsewhere === null, long, empty };
}

/**
 * WHERE THE CARET LANDS when the letter opens: the first field with nothing in it, To, then the subject, then the
 * text (a person who answered whom and what resumes writing where they stopped). Decided once, at the letter's
 * mount, so a re-render never takes the caret back; placed the first time the letter's column has the keys. The
 * text's own focus is the editor's (`focusAtMount`, once the editor stands); To and the subject are found by name
 * inside the letter's own sheet (the composer's, by its ref), as the reply's opened people find their To line.
 */
function useFirstField(
  keysHere: boolean,
  to: string,
  subject: string,
  sheet: RefObject<HTMLElement | null>,
  names: { readonly to: string; readonly subject: string },
): "to" | "subject" | "text" {
  const [first] = useState<"to" | "subject" | "text">(() =>
    !to.trim() ? "to" : !subject.trim() ? "subject" : "text",
  );
  const placed = useRef(false);
  const name = first === "to" ? names.to : names.subject;
  useEffect(() => {
    if (!keysHere || placed.current) return;
    placed.current = true;
    if (first === "text") return;
    fieldIn(sheet.current, name)?.focus();
  }, [keysHere, first, sheet, name]);
  return first;
}

/** Who the letter goes to, from whom, and its subject: the composition's lines and its plan's refusals. */
function LetterPeople({
  from,
  locked,
}: {
  readonly from: RecipientsProps["from"];
  readonly locked: boolean;
}) {
  const w = useWriting();
  const { compose, plan } = w;
  return (
    <People
      from={from}
      rows={compose}
      invalid={{ to: plan.invalid, cc: plan.cc.invalid, bcc: plan.bcc.invalid }}
      locked={locked}
      onRows={(rows) => w.onComposeFields({ ...compose, ...rows })}
      subject={{ value: compose.subject, onChange: (subject) => w.onComposeFields({ ...compose, subject }) }}
    />
  );
}
