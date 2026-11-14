/**
 * THE REPLY, one more sheet at the end of the conversation it answers: the kit's composer as a reply, its people
 * folded into names until they are changed, its subject one line of the head, the shell's editor as its text, its
 * files, and for a forward the original's files and, for a letter ohmail flagged, the question first. Every word,
 * person and file lives in the composition, planned by it (`Writing.reply`); this view holds nothing of the letter.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useReplyRunState } from "@ohmail/app-logic/piles";
import { Composer, SendStatus, type RecipientsProps } from "@ohmail/ui/mail";
import { inlineForwardKey, SEND_IN_FLIGHT_PHASES } from "@ohmail/app-logic/writing/mail-send";
import type { RichValue } from "@ohmail/app-logic/writing/rich-text";
import { letterCap } from "@ohmail/app-logic/write/files";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { scrollIntoViewProgrammatically } from "@ohmail/app-logic/session/programmatic-scroll";
import { useText, type Text } from "../text/index.js";
import { useWriteBeside, useWriting } from "./above.js";
import { People } from "./head/People.js";
import { fieldIn } from "./head/field.js";
import { useFromLine } from "./head/From.js";
import { useWriteParts } from "./parts.js";
import type { EditorHandle, WritePerson, WriteReply } from "./ports.js";
import { Status } from "./status/Status.js";
import { useMarks } from "./text/Marks.js";
import { useSignature } from "./text/Signature.js";
import { unwritten } from "./text/unwritten.js";
import { FilesNote, useFiles } from "./files/Files.js";
import { ForwardRefusal, useForwarded } from "./files/Forwarded.js";
import { useReplyGate, useReplyVerbs, useShowsSend } from "./reply-gate.js";
import { useDraftOffer } from "./draft/Draft.js";
import { useReplyKeys } from "./keys.js";

/** The reader's slot: the open reply, when the letter it answers is one of these. */
export function ReplySheet({
  letters,
  keysHere = false,
}: {
  readonly letters: readonly string[];
  readonly keysHere?: boolean;
}) {
  const w = useWriting();
  const reply = w.reply;
  if (reply === null || !letters.includes(reply.messageId)) return null;
  if (reply.mode === "forward" && w.forwardAsk !== null) return <ForwardAsk ask={w.forwardAsk} />;
  return <ReplyLetter key={`${reply.mode} ${reply.messageId}`} reply={reply} keysHere={keysHere} />;
}

/** A forward of a letter ohmail flagged: why, and the question, before anything is written. */
function ForwardAsk({ ask }: { readonly ask: string }) {
  const t = useText("write");
  const w = useWriting();
  return (
    <SendStatus
      place="top"
      acts={[
        { label: t("reply.ask.confirm"), onPress: w.confirmForward },
        { label: t("reply.ask.cancel"), onPress: w.closeReply },
      ]}
    >
      {`${askWords(t, ask)} ${t("reply.ask.question")}`}
    </SendStatus>
  );
}

function askWords(t: Text, ask: string): string {
  switch (ask) {
    case "otp":
      return t("reply.ask.otp");
    case "verification":
      return t("reply.ask.verification");
    case "password_reset":
      return t("reply.ask.password_reset");
    case "security_alert":
      return t("reply.ask.security_alert");
    default:
      return t("reply.ask.sensitive");
  }
}

const named = (p: WritePerson): string => p.name ?? displayAddress(p.address);

function ReplyLetter({ reply, keysHere }: { readonly reply: WriteReply; readonly keysHere: boolean }) {
  const t = useText("write");
  const w = useWriting();
  const beside = useWriteBeside();
  const { editor: Editor } = useWriteParts();
  const forward = reply.mode === "forward";
  const going = SEND_IN_FLIGHT_PHASES.has(reply.send.phase);
  useShowsSend(reply);
  const files = useFiles({
    list: w.replyAttachments,
    onList: w.setReplyAttachments,
    cap: letterCap(reply.from.maxMessageBytes, beside.surface),
    locked: going,
    forward,
  });
  const forwarded = useForwarded(forward ? w.replyForwardFiles : null, going);
  const fromLine = useFromLine(reply.from, going, (id) => w.setReplyFromId(id));
  const gate = useReplyGate(reply, files.model.attaching.length > 0);
  const { mayGo, tooLong, longLine, refused, empty } = gate;
  const { told } = empty;
  const nothing = empty.empty;
  const send = useCallback(() => w.sendReply(reply.messageId), [w, reply.messageId]);
  /* Nobody named: the press is the composition's own, which says why and sends nothing (today's chord). */
  const wantsPerson = reply.refusal === "incomplete";
  const run = useReplyRunState();
  const leave = run?.at === reply.messageId ? run.exit : w.closeReply;
  const go = useMemo(
    () => ({
      send: () =>
        mayGo ? send() : tooLong ? refused() : nothing ? told() : wantsPerson ? send() : undefined,
      leave,
    }),
    [mayGo, tooLong, refused, nothing, told, wantsPerson, send, leave],
  );
  const { signature, then } = useSignature(
    { state: w.replySig, mailboxId: reply.from.mailboxId, set: w.onReplySig },
    go,
  );
  const [handle, setHandle] = useState<EditorHandle | null>(null);
  const marks = useMarks(handle, !going);
  useReplyKeys(keysHere, then);
  /* Send + Done, asked at every render of the letter as the Ohbox shows it: null where it has nothing to finish. */
  useReplyVerbs(reply, gate, () => then("send"));
  const onText = (next: RichValue): void => w.onReplyBody(next);
  /* The drafter writes replies: a forward's note is never drafted into; a host with no draft wire offers none. */
  const draft = useDraftOffer(reply.messageId);
  const drafted = forward ? null : draft;
  const audience = reply.audience;
  const label =
    audience === "forward" ? t("reply.forwardLabel") : t("reply.label", { name: names(audience.to) });
  const sheet = useRef<HTMLElement | null>(null);
  useForwardAsksWhom(forward, reply.messageId, sheet, t("to"));
  const notice = drafted?.notice ?? null;
  const placeholder = forward ? t("reply.forwardPlaceholder") : t("reply.placeholder");
  const refusedLine = longLine ?? empty.line;
  const noted =
    forward || refusedLine !== null || notice !== null || forwarded.refusal !== null || files.note !== null;
  useLandInView(sheet);
  return (
    <>
      <Composer
        ref={sheet}
        label={label}
        reply
        going={going}
        drafting={drafted?.drafting}
        tabs={drafted?.tabs}
        status={
          <Status at="one" send={reply.send} held={reply.held} locked={null} onResolve={w.resolveHeldSend} />
        }
        head={
          <ReplyPeople
            reply={reply}
            from={fromLine}
            locked={going}
            sheet={sheet}
            onSubjectEscape={() => handle?.focus({ preventScroll: true })}
          />
        }
        marks={marks.strip}
        signature={signature}
        forwarded={forwarded.forwarded}
        files={files.files}
        note={
          noted ? (
            <ReplyNote
              forward={forward}
              tooLong={refusedLine}
              notice={notice}
              refusal={forwarded.refusal}
              files={files.note}
            />
          ) : undefined
        }
        onFiles={files.onFiles}
        heldDrop={files.heldDrop}
        placeholder={unwritten(w.replyBody) ? placeholder : undefined}
        foot={{
          label: t("foot"),
          attach: files.attach,
          format: marks.format,
          ...(drafted === null ? {} : { draft: drafted.control }),
        }}
      >
        <Editor
          value={w.replyBody}
          onChange={onText}
          label={forward ? t("reply.forwardText") : t("reply.text")}
          placeholder={placeholder}
          editable={!going && drafted?.drafting !== true}
          focusAtMount={!forward}
          onSendKey={() => then("send")}
          onLeaveKey={() => then("leave")}
          onHandle={setHandle}
        />
      </Composer>
      {marks.card}
    </>
  );
}

/**
 * A FORWARD OPENS WITH THE KEYS IN ITS TO LINE: it names nobody yet, and whom it goes to is the first thing it asks
 * (a reply's keys are in its text, the editor's `focusAtMount`). Once per open, the line found by name inside the
 * forward's own sheet, as the reply's opened people find theirs.
 */
function useForwardAsksWhom(
  forward: boolean,
  messageId: string,
  sheet: RefObject<HTMLElement | null>,
  toWord: string,
): void {
  useEffect(() => {
    if (!forward) return;
    fieldIn(sheet.current, toWord)?.focus({ preventScroll: true });
  }, [forward, messageId, sheet, toWord]);
}

/**
 * THE REPLY COMES TO THE PERSON when it opens: the conversation above it can be taller than the column, and the text's
 * focus does not scroll (`scrollIntoView: false`), so a reply opened under a long letter would stand below the fold.
 * Its sheet (the composer's own, handed by its ref) is brought into view by its bottom edge, where its last line and
 * the foot are; the app's own scroll, stamped, so the reader never takes it for the person reading. Once per open: the
 * sheet is mounted again for another letter or mode.
 */
function useLandInView(sheet: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (sheet.current) scrollIntoViewProgrammatically(sheet.current, { block: "end" });
  }, [sheet]);
}

/**
 * Who the reply goes to: folded into names until they are changed, then the three lines; its subject. Opening the
 * folded people puts the keys in the To line, where the person asked to change them (the old tests' ruling Q9: KEEP);
 * the press's own button leaves with the fold, so nothing else would hold them.
 */
function ReplyPeople({
  reply,
  from,
  locked,
  sheet,
  onSubjectEscape,
}: {
  readonly reply: WriteReply;
  readonly from: RecipientsProps["from"];
  readonly locked: boolean;
  /** Escape in the subject hands the keys back to the reply's text. */
  readonly onSubjectEscape: () => void;
  /** The reply's own sheet: where the To line is looked for once the people are opened. */
  readonly sheet: RefObject<HTMLElement | null>;
}) {
  const t = useText("write");
  const w = useWriting();
  const audience = reply.audience;
  const [unfolded, setUnfolded] = useState(false);
  const toWord = t("to");
  /* Once the lines stand (the composition holds the opened envelope), not before. */
  const opened = w.replyEnvelope !== null;
  useEffect(() => {
    if (!unfolded || !opened) return;
    setUnfolded(false);
    fieldIn(sheet.current, toWord)?.focus({ preventScroll: true });
  }, [unfolded, opened, sheet, toWord]);
  return (
    <People
      reply
      allOpen
      from={from}
      rows={w.replyEnvelope ?? reply.seed}
      invalid={reply.invalid}
      locked={locked}
      onRows={(rows) => w.setReplyEnvelope(rows)}
      {...(audience !== "forward" && w.replyEnvelope === null
        ? {
            folded: {
              label: t("reply.to"),
              names:
                audience.cc.length > 0
                  ? t("reply.namesCc", { to: names(audience.to), cc: names(audience.cc) })
                  : t("reply.names", { to: names(audience.to) }),
              change: {
                label: t("reply.change"),
                onPress: () => {
                  w.setReplyEnvelope(reply.seed);
                  setUnfolded(true);
                },
              },
            },
          }
        : {})}
      {...(reply.subject.editable
        ? { subject: { value: reply.subject.value, onChange: w.onReplySubject, onEscape: onSubjectEscape } }
        : {})}
    />
  );
}

/** The lines over the foot: a forward's note, why Send rests, the drafter's sentence, the files'. */
function ReplyNote(props: {
  readonly forward: boolean;
  readonly tooLong: string | null;
  readonly notice: string | null;
  readonly refusal: string | null;
  readonly files: string | null;
}) {
  const t = useText("write");
  return (
    <>
      {props.forward ? (
        <SendStatus place="start" sign="forward">
          {t("reply.forwarding")}
        </SendStatus>
      ) : null}
      {props.tooLong !== null ? <SendStatus place="start">{props.tooLong}</SendStatus> : null}
      {props.notice !== null ? (
        <SendStatus place="end" sign="spark">
          {props.notice}
        </SendStatus>
      ) : null}
      {props.refusal !== null ? <ForwardRefusal sentence={props.refusal} /> : null}
      {props.files !== null ? <FilesNote sentence={props.files} /> : null}
    </>
  );
}

function names(people: readonly WritePerson[]): string {
  return people.map(named).join(", ");
}
