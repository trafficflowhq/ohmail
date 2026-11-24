/**
 * ONE LETTER OF THE COLUMN: the kit's message sheet around the body the shell hands in. The wrapper carries the read
 * rule's facts; the text stands in its own block; the body's own controls stand in the head and above the text.
 */
import type { EngineMessage, MessageBody } from "@ohmail/wire";
import { useLayoutEffect, useState } from "react";
import {
  LetterHistory,
  LetterViews,
  Message,
  MessageHead,
  type MessageClip,
  TextNotKept,
} from "@ohmail/ui/mail";
import {
  emptiedForSpace,
  letterPictures,
  letterReady,
  letterStampInstant,
  readIsItsRelease,
  useJunkRefill,
  useLetterBody,
  withheldKeyOf,
} from "@ohmail/app-logic/reader";
import { useLiveBody } from "@ohmail/app-logic/reading";
import { endOpen } from "@ohmail/app-logic/session/ui-vitals";
import { useFrame } from "../frame/commands.js";
import { useSignal } from "../frame/feeds.js";
import { useMailboxStatus } from "../frame/room.js";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";
import { BodyLoadStatus } from "./BodyLoadStatus.js";
import type { ContactOf } from "./contact/Contact.js";
import { LetterFiles } from "./files/Files.js";
import { useLetterHeadPresentation, type LetterHeadProps } from "./LetterHead.js";
import { useParts } from "./parts.js";
import type { LetterControl, LetterNotice } from "./ports.js";

/** A load the mail server refused: its own sentence. */
const REFUSED = {
  gone: "liveGone",
  too_large: "liveTooLarge",
  busy: "liveBusy",
  unreachable: "liveUnreachable",
  failed: "liveFailed",
} as const;

/** The words of each reason the text is kept elsewhere: a short title, its sentence, its fine line (`body.kept.*`). */
const KEPT = {
  withheld: "emptied",
  withheldJunk: "junk",
  withheldExpunged: "expunged",
  withheldTooLarge: "tooLarge",
} as const;

export interface LetterViewProps {
  readonly message: EngineMessage;
  readonly onBodyLayout?: () => void;
  readonly offMirrorBody?: MessageBody;
  readonly retryBody?: () => void;
  readonly clip?: MessageClip;
  readonly streamCard?: "open";
  readonly markUnread?: LetterHeadProps["markUnread"];
  readonly showSubject?: boolean;
  readonly compactSubject?: boolean;
  /** A heading inside the latest sheet when the conversation heading can scroll out of view. */
  readonly subject?: string;
  /** The addressed letter, whose text ends the route’s opening measurement. */
  readonly opened: boolean;
  readonly current?: boolean;
  readonly previewSelection?: string;
  /** Unread as the column presents it. */
  readonly unread: boolean;
  /** `tint`: the sheet is washed and a hidden word says unread; `dot`: the head's dot. */
  readonly look: "tint" | "dot";
  /** Read, not only peeked at: its embedded pictures may be asked for. */
  readonly reading: boolean;
  /** The row is the presented mirror's; false: the hold is unknown and no picture loads by itself. */
  readonly presented: boolean;
  /** The head is narrow: its stamp prints the day and the month, the full form on a press. */
  readonly narrow?: boolean;
  readonly onPerson: (person: ContactOf) => void;
  /** The name whose card stands open (its `slot`), or null. */
  readonly card?: string | null;
}

export function Letter({
  message,
  onBodyLayout,
  offMirrorBody,
  retryBody,
  showSubject,
  compactSubject,
  clip,
  streamCard,
  markUnread,
  subject,
  opened,
  current = opened,
  previewSelection,
  unread,
  look,
  reading,
  presented,
  narrow,
  onPerson,
  card,
}: LetterViewProps) {
  const [t, messageText] = [useText("reader"), useText("message")];
  const {
    parts,
    body,
    refillExpired,
    live,
    notice,
    tinted,
    kept,
    copy,
    views,
    history,
    invitation,
    Body,
    renderedText,
    loaded,
    loadedRemote,
    scheme,
    owner,
    setNotice,
    setControls,
  } = useLetterContent({ message, offMirrorBody, opened, look, unread, reading, presented }, t);
  const text = (
    <Body
      {...letterPictures(message, loadedRemote, parts.pictures, parts.files, reading, presented, current)}
      onBodyLayout={onBodyLayout}
      messageId={message.id}
      text={renderedText}
      html={loaded ? loaded.html : body.html}
      subject={message.subject}
      scheme={scheme}
      owner={owner}
      onNotice={setNotice}
      onControls={setControls}
    />
  );
  const textState = (
    <TextState message={message} body={body} live={live} retry={retryBody} refillExpired={refillExpired} />
  );
  const files = (
    <LetterFiles
      messageId={message.id}
      selection={previewSelection}
      parts={parts}
      omit={parts.invitationFile?.(message)}
    />
  );
  return (
    <div
      className="rd-letter"
      data-conv-id={message.id}
      aria-current={current ? "true" : undefined}
      data-unseen={message.unread ? "" : undefined}
      data-body-ready={letterReady(message, body) ? "" : undefined}
    >
      {look === "tint" && unread ? <span className="oh-vh">{messageText("rowUnread")}</span> : null}
      <Message
        clip={clip}
        compactSubject={compactSubject}
        subject={clip || showSubject ? message.subject || undefined : subject}
        amount={clip || streamCard ? message.amount : undefined}
        head={
          <LetterHead
            message={message}
            unread={look === "dot" && unread}
            notice={notice}
            pictures={views.find((control) => control.id === "pictures")}
            copy={copy}
            narrow={narrow ?? false}
            streamCard={streamCard ?? (clip ? "open" : undefined)}
            markUnread={markUnread}
            onPerson={onPerson}
            card={card ?? null}
          />
        }
        unread={tinted}
        lead={
          views.length ? (
            <LetterViews
              label={t("views")}
              views={views.map((c) => ({ id: c.id, label: c.label, onPress: c.onPress }))}
            />
          ) : undefined
        }
        after={invitation || history ? <LetterAfter invitation={invitation} history={history} /> : undefined}
        files={files}
      >
        <div data-read-body="">
          {kept ? null : textState}
          {text}
          {kept ? textState : null}
        </div>
      </Message>
    </div>
  );
}

function LetterAfter({
  invitation,
  history,
}: Pick<ReturnType<typeof useLetterContent>, "invitation" | "history">) {
  return (
    <>
      {invitation && <div className="rd-invitation">{invitation}</div>}
      {history && <LetterHistory label={history.label} open={history.expanded} onPress={history.onPress} />}
    </>
  );
}

function useLetterContent(
  {
    message,
    offMirrorBody,
    opened,
    look,
    unread,
    reading,
    presented,
  }: Pick<
    LetterViewProps,
    "message" | "offMirrorBody" | "opened" | "look" | "unread" | "reading" | "presented"
  >,
  t: ReturnType<typeof useText>,
) {
  const parts = useParts();
  const { host } = useFrame();
  const scheme = useSignal(host.device.appearance).scheme;
  const mirrorBody = useLetterBody(message);
  const body = offMirrorBody ?? mirrorBody;
  const refillExpired = useJunkRefill(message, body);
  /* THE OPEN'S MEASURE ENDS HERE, in the commit that put the opened letter's text in the document: never on a text
     still owed (its snippet, its loading), which would report the wait as over. Held as on screen until it leaves. */
  useLayoutEffect(() => {
    if (!opened || body.state === "snippet" || body.state === "loading") return undefined;
    return endOpen(message.id);
  }, [opened, message.id, body.state]);
  const [notice, setNotice] = useState<LetterNotice | null>(null);
  const [controls, setControls] = useState<readonly LetterControl[]>([]);
  const liveWire = host.wires.liveBody;
  const live = useLiveBody(message.id, emptiedForSpace(body) && liveWire !== NONE ? liveWire : undefined);
  const loaded = "kind" in live.live && live.live.kind === "loaded" ? live.live : null;

  // The list treats a pin as unread until Done. The sheet follows the message’s actual read flag.
  const tinted = look === "tint" && (readIsItsRelease(message) ? message.unread : unread);
  const kept = body.state === "withheld" && loaded === null;
  const copy = parts.sentCopy === NONE ? null : parts.sentCopy(message.id);
  const views = controls.filter((c) => c.id !== "history");
  const history = controls.find((c) => c.id === "history");
  const Body = parts.body;
  const Invitation = parts.invitation;
  const renderedText = loaded ? loaded.text : body.text;
  /* What the shell says of the letter's invitation stands below and outside its text. */
  const invitation =
    Invitation === NONE ? null : (
      <Invitation
        messageId={message.id}
        message={message}
        invitationWithoutEvent={message.invitationWithoutEvent === true}
        text={renderedText}
        full={loaded !== null || body.state === "full"}
      />
    );
  return {
    parts,
    body,
    refillExpired,
    live,
    notice,
    tinted,
    kept,
    copy,
    views,
    history,
    invitation,
    Body,
    renderedText,
    loaded,
    loadedRemote: body.loadedRemoteContent,
    scheme,
    owner: host.session.scope,
    setNotice,
    setControls,
  };
}

/** The message head and its contextual menu share the letter's presentation state. */
export function LetterHead(props: LetterHeadProps) {
  const { head, stamp, full, setFull, menu } = useLetterHeadPresentation(props);
  return (
    <>
      <MessageHead
        {...head}
        stamp={{
          when: full ? stamp.full : props.narrow ? stamp.short : stamp.when,
          full,
          title: full ? stamp.when : stamp.full,
          at: letterStampInstant(props.message) ?? undefined,
          onPress: () => setFull((f) => !f),
        }}
      />
      {menu}
    </>
  );
}

/** What the column says of a letter's text that is not all here: on its way, not fetched, or not kept. */
function TextState({
  message,
  body,
  live,
  retry,
  refillExpired,
}: {
  message: EngineMessage;
  body: MessageBody;
  refillExpired: boolean;
  live: ReturnType<typeof useLiveBody>;
  retry?: () => void;
}) {
  const tb = useText("body");
  const { commands, host } = useFrame();
  const settings = host.features.places.settings;
  const status = useMailboxStatus()(message.mailboxId);
  const { load } = live;
  const now = live.live;
  const loaded = "kind" in now && now.kind === "loaded";
  const busy = "state" in now && now.state === "loading";
  const refused = "kind" in now && now.kind === "refused" ? now.reason : null;
  if (body.state === "snippet" || body.state === "loading" || body.state === "failed")
    return (
      <BodyLoadStatus
        state={body.state === "failed" ? "failed" : "loading"}
        messageId={message.id}
        retry={retry}
      />
    );
  const storage =
    settings !== NONE && settings !== undefined
      ? { label: tb("kept.storage"), onPress: () => commands.go({ place: "settings", sub: "storage" }) }
      : undefined;
  if (loaded) return <TextNotKept kind="loaded" line={tb("keptLoaded")} more={storage} />;
  if (body.state !== "withheld") return null;
  const key = withheldKeyOf(body, message.folder);
  /* A Junk letter on its way back from the Junk folder is text on its way: one fine line. */
  if (key === "withheldJunkLoading")
    return refillExpired ? (
      <TextNotKept kind="refused" warn={tb("kept.failed")} />
    ) : (
      <TextNotKept kind="fine" line={tb(key)} live />
    );
  const words = KEPT[key];
  const emptied = key === "withheld";
  /* Emptied in a mailbox ohmail no longer reads (the mailbox facts say `disabled`): its text does not come back, and
     nothing loads it. */
  const removed = emptied && status === "disabled";
  return (
    <TextNotKept
      kind="kept"
      label={tb(`kept.${words}Title`)}
      line={tb(removed ? "kept.removedLine" : `kept.${words}Line`)}
      warn={refused !== null ? tb(REFUSED[refused]) : undefined}
      act={
        load && !removed
          ? { label: busy ? tb("keptLoading") : tb("liveLoad"), busy, onPress: load }
          : undefined
      }
      more={emptied ? storage : undefined}
      fine={removed || words === "tooLarge" ? undefined : tb(`kept.${words}Fine`)}
    />
  );
}
