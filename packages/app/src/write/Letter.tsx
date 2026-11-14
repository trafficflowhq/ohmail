/**
 * THE NEW LETTER, in the reading column: the kit's reading sheet with the composer filling it, its people and
 * subject at the head, the shell's editor as its text, what happened to it over its lines, and its verbs at the foot.
 * Every word, person and file lives in the composition; this view holds the open lines and nothing of the letter.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Composer, SendStatus, Sheet, type RecipientsProps } from "@ohmail/ui/mail";
import { COMPOSE_SEND_KEY, sendRefusal, SEND_IN_FLIGHT_PHASES } from "@ohmail/app-logic/writing/mail-send";
import type { RichValue } from "@ohmail/app-logic/writing/rich-text";
import { useFocusFollows } from "@ohmail/app-logic/keys";
import type { PaneProps } from "../frame/contract.js";
import type { EditorHandle, Writing } from "./ports.js";
import { useText } from "../text/index.js";
import { useWriteBeside, useWriting } from "./above.js";
import { People } from "./head/People.js";
import { fieldIn } from "./head/field.js";
import { useWriteParts } from "./parts.js";
import { useLetterSendLines } from "./status/Status.js";
import { useOverLimit, type OverLimit } from "./status/over-limit.js";
import { useNeedsContent, type NeedsContent } from "./status/needs-content.js";
import { saveLines } from "./status/save-note.js";
import { elsewhereForSave, useWentElsewhere, type WentElsewhere } from "./status/elsewhere.js";
import { useMarks } from "./text/Marks.js";
import { FilesNote, useFiles } from "./files/Files.js";
import { ForwardRefusal, useForwarded } from "./files/Forwarded.js";
import { letterCap } from "@ohmail/app-logic/write/files";
import { sendWaits, Verbs, type SendSaid } from "./verbs/Verbs.js";
import { Later } from "./verbs/Later.js";
import { useFromLine } from "./head/From.js";
import { useLetterKeys, useLetterWriting } from "./keys.js";
import { useSignature } from "./text/Signature.js";
import { unwritten } from "./text/unwritten.js";
import { useLetterDraftOffer } from "./draft/Draft.js";

export function Letter({ keysHere, plan }: PaneProps) {
  const t = useText("write");
  const tc = useText("compose");
  const w = useWriting();
  const { editor: Editor } = useWriteParts();
  const { compose } = w;
  const going = SEND_IN_FLIGHT_PHASES.has(w.composeSend.phase);
  /* The letter shows its send while it stands: its ending is said on its line, once, and not again in the report. */
  const { showSend } = w;
  useEffect(() => showSend(COMPOSE_SEND_KEY), [showSend]);
  const locked = w.composeLocked !== null || going;
  const { files, forwarded, notKept } = useLetterFiles(locked);
  const fromLine = useFromLine(w.composeFrom, locked, (fromMailboxId) =>
    w.onComposeFields({ ...compose, fromMailboxId }),
  );
  const [laterOpen, setLaterOpen] = useState(false);
  const { mayGo, long, empty, went, pressable, signature, then } = useLetterSend(
    files.model.attaching.length > 0,
  );
  const tooLong = long.tooLong;
  const nothing = empty.empty;
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
  const saving = useLetterSaveLines(long.line !== null);
  const sheet = useRef<HTMLDivElement | null>(null);
  useFocusFollows(sheet, { enter: false });
  const first = useFirstField(keysHere, compose.to, compose.subject, sheet, {
    to: t("to"),
    subject: t("subject"),
  });
  const onText = (next: RichValue): void =>
    w.onComposeFields({ ...compose, body: next.text, html: next.html });
  return (
    <Sheet
      ref={sheet}
      kind="reading"
      label={t("letter")}
      back={plan.device === "phone" ? { word: t("back"), onPress: () => then("leave") } : undefined}
      foot={
        <Verbs
          canSend={mayGo}
          going={going}
          keysHere={keysHere}
          waits={sendWaits(w.composeSend.phase)}
          resting={tooLong}
          said={sendSaid(nothing ? tc("needContent") : went.refusal, w.composeSend)}
          onSend={() => then("send")}
          later={{ open: laterOpen, onPress: () => setLaterOpen(true) }}
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
        head={<LetterPeople from={fromLine} locked={locked} />}
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
          ...(draft === null ? {} : { draft: draft.control }),
        }}
        placeholder={unwritten({ text: compose.body, html: compose.html }) ? placeholder : undefined}
      >
        <Editor
          value={{ text: compose.body, html: compose.html }}
          onChange={onText}
          label={t("text")}
          placeholder={placeholder}
          editable={!locked && !drafting}
          focusAtMount={keysHere && first === "text"}
          onSendKey={() => {
            if (pressable && !laterOpen) then("send");
          }}
          onLeaveKey={() => then("leave")}
          onHandle={setHandle}
        />
      </Composer>
      {marks.card}
      <Later
        open={laterOpen}
        onClose={() => setLaterOpen(false)}
        onPick={(at) => {
          if (mayGo) w.sendCompose(at);
        }}
        forward={Boolean(compose.forwardOf)}
        hasFiles={(compose.attachments?.length ?? 0) > 0}
        attaching={files.model.attaching}
      />
    </Sheet>
  );
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
function useLetterSaveLines(ceiling: boolean): ReturnType<typeof saveLines> {
  const tc = useText("compose");
  const w = useWriting();
  return saveLines(
    {
      closeRefusal: w.composeCloseRefusal,
      ceiling,
      saveRefused: w.composeSaveRefused,
      resumed: w.composeResumed,
      elsewhere: elsewhereForSave(w.composeElsewhere),
    },
    { notSaved: tc("draftNotSaved"), resumed: tc("resumedNote") },
  );
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

/**
 * The lines over the foot: that the letter's row went elsewhere (first, as today's said it above the rest), why a
 * letter whose send waits keeps the place that writes (the composition's sentence, before the send line), what
 * happened to the send, whether the letter is kept (the close refusal, the draft ceiling's line, why a press of Send
 * over a letter that went sent nothing with its offer, the account's refusal, the resumed note: `save-note.ts`), the
 * drafter's sentence, a forward's refusal, the files'.
 */
function letterNote(
  { wait, send }: { readonly wait: string | null; readonly send: ReactNode | null },
  saving: ReturnType<typeof saveLines>,
  long: string | null,
  notice: string | null,
  refusal: string | null,
  files: string | null,
  went: WentElsewhere,
): ReactNode {
  const kept = [...saving.before, ...saving.after];
  if (
    went.note === null &&
    wait === null &&
    send === null &&
    kept.length === 0 &&
    long === null &&
    notice === null &&
    refusal === null &&
    files === null
  )
    return undefined;
  return (
    <>
      {went.note !== null ? <SendStatus place="start">{went.note}</SendStatus> : null}
      {wait !== null ? <SendStatus place="start">{wait}</SendStatus> : null}
      {send}
      {saving.before.map((line) => (
        <SendStatus key={line} place="start">
          {line}
        </SendStatus>
      ))}
      {long !== null ? <SendStatus place="start">{long}</SendStatus> : null}
      {went.told && went.refusal !== null ? (
        <SendStatus
          place="foot"
          acts={went.offers ? [{ label: went.offerLabel, onPress: went.sendAsNew }] : undefined}
        >
          {went.refusal}
        </SendStatus>
      ) : null}
      {saving.after.map((line) => (
        <SendStatus key={line} place="start">
          {line}
        </SendStatus>
      ))}
      {notice !== null ? (
        <SendStatus place="end" sign="spark">
          {notice}
        </SendStatus>
      ) : null}
      {refusal !== null ? <ForwardRefusal sentence={refusal} /> : null}
      {files !== null ? <FilesNote sentence={files} /> : null}
    </>
  );
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
