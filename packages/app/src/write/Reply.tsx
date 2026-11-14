/**
 * THE REPLY, one more sheet at the end of the conversation it answers: the kit's composer as a reply, its people
 * folded into names until they are changed, its subject one line of the head, the shell's editor as its text, its
 * files, and for a forward the original's files and, for a letter ohmail flagged, the question first. Every word,
 * person and file lives in the composition, planned by it (`Writing.reply`); this view holds nothing of the letter.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { Composer, SendStatus, type RecipientsProps } from "@ohmail/ui/mail";
import { SEND_IN_FLIGHT_PHASES } from "@ohmail/app-logic/writing/mail-send";
import type { RichValue } from "@ohmail/app-logic/writing/rich-text";
import { letterCap } from "@ohmail/app-logic/write/files";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { useText, type Text } from "../text/index.js";
import { usePublishVerbs, useWriteBeside, useWriting } from "./above.js";
import { People } from "./head/People.js";
import { useFromLine } from "./head/From.js";
import { useWriteParts } from "./parts.js";
import type { EditorHandle, WritePerson, WriteReply } from "./ports.js";
import { Status } from "./status/Status.js";
import { useMarks } from "./text/Marks.js";
import { useSignature } from "./text/Signature.js";
import { unwritten } from "./text/unwritten.js";
import { FilesNote, useFiles } from "./files/Files.js";
import { ForwardRefusal, useForwarded } from "./files/Forwarded.js";
import { discardVerb, sendVerb } from "./verbs/Verbs.js";
import { useDraftOffer } from "./draft/Draft.js";

/** The reader's slot: the open reply, when the letter it answers is one of these. */
export function ReplySheet({ letters }: { readonly letters: readonly string[] }) {
  const w = useWriting();
  const reply = w.reply;
  if (reply === null || !letters.includes(reply.messageId)) return null;
  if (reply.mode === "forward" && w.forwardAsk !== null) return <ForwardAsk ask={w.forwardAsk} />;
  return <ReplyLetter key={`${reply.mode} ${reply.messageId}`} reply={reply} />;
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

function ReplyLetter({ reply }: { readonly reply: WriteReply }) {
  const t = useText("write");
  const w = useWriting();
  const beside = useWriteBeside();
  const { editor: Editor } = useWriteParts();
  const forward = reply.mode === "forward";
  const going = SEND_IN_FLIGHT_PHASES.has(reply.send.phase);
  const files = useFiles({
    list: w.replyAttachments,
    onList: w.setReplyAttachments,
    cap: letterCap(reply.from.maxMessageBytes, beside.surface),
    locked: going,
    forward,
  });
  const forwarded = useForwarded(forward ? w.replyForwardFiles : null, going);
  const fromLine = useFromLine(reply.from, going, (id) => w.setReplyFromId(id));
  /* The send's own gate decides; a file still being read is not on the reply yet. */
  const mayGo = reply.refusal === null && files.model.attaching.length === 0;
  const send = useCallback(() => w.sendReply(reply.messageId), [w, reply.messageId]);
  const go = useMemo(
    () => ({ send: () => (mayGo ? send() : undefined), leave: w.closeReply }),
    [mayGo, send, w],
  );
  const { signature, then } = useSignature(
    { state: w.replySig, mailboxId: reply.from.mailboxId, set: w.onReplySig },
    go,
  );
  const [handle, setHandle] = useState<EditorHandle | null>(null);
  const marks = useMarks(handle, !going);
  /* Send and Discard stand in the reading sheet's one panel while this reply stands: handed there, each press reading
     the reply as it is when pressed. */
  const presses = useRef({ send: () => then("send"), discard: w.discardReply });
  presses.current = { send: () => then("send"), discard: w.discardReply };
  const sendWord = t("send");
  const discardWord = t("discard");
  const verbs = useMemo(
    () => [
      sendVerb(sendWord, mayGo, going, () => presses.current.send()),
      discardVerb(discardWord, going, () => presses.current.discard()),
    ],
    [sendWord, discardWord, mayGo, going],
  );
  usePublishVerbs(verbs);
  const onText = (next: RichValue): void => w.onReplyBody(next);
  /* The drafter writes replies: a forward's note is never drafted into; a host with no draft wire offers none. */
  const draft = useDraftOffer(reply.messageId);
  const drafted = forward ? null : draft;
  const audience = reply.audience;
  const label =
    audience === "forward" ? t("reply.forwardLabel") : t("reply.label", { name: names(audience.to) });
  const tooLong = reply.refusal === "too_long" ? t("status.tooLong", beside.sendLineValues()) : null;
  const notice = drafted?.notice ?? null;
  const placeholder = forward ? t("reply.forwardPlaceholder") : t("reply.placeholder");
  const noted =
    forward || tooLong !== null || notice !== null || forwarded.refusal !== null || files.note !== null;
  return (
    <>
      <Composer
        label={label}
        reply
        going={going}
        drafting={drafted?.drafting}
        tabs={drafted?.tabs}
        status={
          <Status at="one" send={reply.send} held={reply.held} locked={null} onResolve={w.resolveHeldSend} />
        }
        head={<ReplyPeople reply={reply} from={fromLine} locked={going} />}
        marks={marks.strip}
        signature={signature}
        forwarded={forwarded.forwarded}
        files={files.files}
        note={
          noted ? (
            <ReplyNote
              forward={forward}
              tooLong={tooLong}
              notice={notice}
              refusal={forwarded.refusal}
              files={files.note}
            />
          ) : undefined
        }
        onFiles={files.onFiles}
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
          onSendKey={() => {
            if (mayGo) then("send");
          }}
          onLeaveKey={() => then("leave")}
          onHandle={setHandle}
        />
      </Composer>
      {marks.card}
    </>
  );
}

/** Who the reply goes to: folded into names until they are changed, then the three lines; its subject. */
function ReplyPeople({
  reply,
  from,
  locked,
}: {
  readonly reply: WriteReply;
  readonly from: RecipientsProps["from"];
  readonly locked: boolean;
}) {
  const t = useText("write");
  const w = useWriting();
  const audience = reply.audience;
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
              change: { label: t("reply.change"), onPress: () => w.setReplyEnvelope(reply.seed) },
            },
          }
        : {})}
      {...(reply.subject.editable
        ? { subject: { value: reply.subject.value, onChange: w.onReplySubject } }
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
