/**
 * THE NEW LETTER, in the reading column: the kit's reading sheet with the composer filling it, its people and
 * subject at the head, the shell's editor as its text, what happened to it over its lines, and its verbs at the foot.
 * Every word, person and file lives in the composition; this view holds the open lines and nothing of the letter.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Composer, SendStatus, Sheet, type RecipientsProps } from "@ohmail/ui/mail";
import { canSend, SEND_IN_FLIGHT_PHASES } from "@ohmail/app-logic/writing/mail-send";
import type { RichValue } from "@ohmail/app-logic/writing/rich-text";
import type { PaneProps } from "../frame/contract.js";
import type { EditorHandle } from "./ports.js";
import { useText } from "../text/index.js";
import { useWriteBeside, useWriting } from "./above.js";
import { People } from "./head/People.js";
import { useWriteParts } from "./parts.js";
import { useLetterSendLines } from "./status/Status.js";
import { useMarks } from "./text/Marks.js";
import { FilesNote, useFiles } from "./files/Files.js";
import { ForwardRefusal, useForwarded } from "./files/Forwarded.js";
import { letterCap } from "@ohmail/app-logic/write/files";
import { Verbs } from "./verbs/Verbs.js";
import { Later } from "./verbs/Later.js";
import { useFromLine } from "./head/From.js";
import { useLetterKeys } from "./keys.js";
import { useSignature } from "./text/Signature.js";
import { unwritten } from "./text/unwritten.js";
import { useLetterDraftOffer } from "./draft/Draft.js";

export function Letter({ keysHere }: PaneProps) {
  const t = useText("write");
  const w = useWriting();
  const beside = useWriteBeside();
  const { editor: Editor } = useWriteParts();
  const { compose, plan } = w;
  const going = SEND_IN_FLIGHT_PHASES.has(w.composeSend.phase);
  const locked = w.composeLocked !== null || going;
  const files = useFiles({
    list: compose.attachments ?? [],
    onList: (attachments) => w.onComposeFields({ ...compose, attachments }),
    cap: letterCap(w.composeFrom.maxMessageBytes, beside.surface),
    locked,
    forward: Boolean(compose.forwardOf),
  });
  const forwarded = useForwarded(w.composeForwardFiles, locked);
  const fromLine = useFromLine(w.composeFrom, locked, (fromMailboxId) =>
    w.onComposeFields({ ...compose, fromMailboxId }),
  );
  const [laterOpen, setLaterOpen] = useState(false);
  /* A file still being read is not on the letter yet: Send waits for it, and the line over the foot says so. */
  const mayGo =
    w.composeLocked === null && files.model.attaching.length === 0 && canSend(w.composeSend, plan.mutation);
  const send = useCallback(() => w.sendCompose(), [w]);
  const [handle, setHandle] = useState<EditorHandle | null>(null);
  const go = useMemo(
    () => ({ send: () => (mayGo ? send() : undefined), leave: w.closeCompose }),
    [mayGo, send, w],
  );
  const { signature, then } = useSignature(
    {
      state: compose.sig,
      mailboxId: w.composeFrom.mailboxId,
      set: (sig) => w.onComposeFields({ ...compose, sig }),
    },
    go,
  );
  const marks = useMarks(handle, !locked);
  const lines = useLetterSendLines();
  const draft = useLetterDraftOffer();
  const drafting = draft?.drafting === true;
  /* With Send later open, Mod+Enter is the card's: it schedules, it never sends now. */
  useLetterKeys(
    keysHere,
    mayGo && !laterOpen,
    () => then("send"),
    () => then("leave"),
  );
  const onText = (next: RichValue): void =>
    w.onComposeFields({ ...compose, body: next.text, html: next.html });
  return (
    <Sheet
      kind="reading"
      label={t("letter")}
      foot={
        <Verbs
          canSend={mayGo}
          going={going}
          onSend={() => then("send")}
          later={{ open: laterOpen, onPress: () => setLaterOpen(true) }}
          onDiscard={w.discardCompose}
        />
      }
    >
      <Composer
        label={t("letter")}
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
        note={letterNote(lines.foot, draft?.notice ?? null, forwarded.refusal, files.note)}
        onFiles={files.onFiles}
        foot={{
          label: t("foot"),
          attach: files.attach,
          format: marks.format,
          ...(draft === null ? {} : { draft: draft.control }),
        }}
        placeholder={unwritten({ text: compose.body, html: compose.html }) ? t("placeholder") : undefined}
      >
        <Editor
          value={{ text: compose.body, html: compose.html }}
          onChange={onText}
          label={t("text")}
          placeholder={t("placeholder")}
          editable={!locked && !drafting}
          focusAtMount={keysHere}
          onSendKey={() => {
            if (mayGo && !laterOpen) then("send");
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

/** The lines over the foot: what happened to the send, the drafter's sentence, a forward's refusal, the files'. */
function letterNote(
  send: ReactNode | null,
  notice: string | null,
  refusal: string | null,
  files: string | null,
): ReactNode {
  if (send === null && notice === null && refusal === null && files === null) return undefined;
  return (
    <>
      {send}
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
