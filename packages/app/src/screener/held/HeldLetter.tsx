/**
 * ONE HELD LETTER, the Screener's own composition: the kit's message sheet around the body the shell hands the reader.
 * A held letter is shown, never read: nothing marks it read, it has no letter menu, and its pictures stay blocked
 * (`reading` and `presented` are false: no automatic load, no embedded picture asked) until the person presses the
 * body's own Show pictures. A body that failed offers Retry, the one way past a server that refused. A letter in
 * Waiting shows its invitation above the body.
 */
import type { EmailAddress, EngineMessage } from "@ohmail/wire";
import { useEffect, useState } from "react";
import { usePresentedMirror } from "@ohmail/app-logic/reading";
import { isProtected, letterPictures, useLetterBody } from "@ohmail/app-logic/reader";
import { HELD_BODY_STALL_MS } from "@ohmail/app-logic/screener";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { RefusalLine } from "@ohmail/ui/base";
import { BlockedImages, LetterViews, Message, MessageHead } from "@ohmail/ui/mail";
import { useFrame } from "../../frame/commands.js";
import { useSignal } from "../../frame/feeds.js";
import { NONE } from "../../host/index.js";
import { LetterFiles } from "../../reader/files/Files.js";
import type { LetterControl, LetterNotice } from "../../reader/index.js";
import { useText } from "../../text/index.js";
import { useScreenerBeside, type ScreenerSegment } from "../contract.js";
import type { HeldParts } from "../ports.js";
import { HeldInvitation } from "./HeldInvitation.js";
import { HeldUnsubscribe } from "./HeldUnsubscribe.js";

export interface HeldLetterOf {
  readonly id: string;
  readonly subject: string;
  readonly time: string;
  readonly snippet?: string;
}

/** What the body reads of a letter: its id and the line shown until its text lands. */
const asMessage = (letter: HeldLetterOf): EngineMessage =>
  ({ id: letter.id, snippet: letter.snippet ?? "" }) as EngineMessage;

/** The element id of a held letter's sheet: the kit's jump to a message, which the column's anchor takes. */
export const heldMark = (id: string): string => `sc-held-${id}`;

interface HeldLetterProps {
  letter: HeldLetterOf;
  position?: { at: number; total: number };
  showBody?: boolean;
  from: EmailAddress;
  /** What ohmail measured about the sender: a claim keeps every picture back. */
  checked: unknown;
  segment: ScreenerSegment;
  /** False where an invitation is never offered: a letter that failed its sender check. */
  invites: boolean;
  onPerson: (anchor: HTMLElement) => void;
  onRetry: (id: string) => void;
}

export function HeldLetter(props: HeldLetterProps) {
  const { letters } = useScreenerBeside();
  if (props.showBody === false) {
    const { letter, from, onPerson, position } = props;
    return (
      <Message
        id={position ? heldMark(letter.id) : undefined}
        position={position}
        head={<HeldHead letter={letter} from={from} onPerson={onPerson} />}
        subject={letter.subject}
      >
        {null}
      </Message>
    );
  }
  return <HeldLetterContent {...props} letters={letters} />;
}

function HeldHead({
  letter,
  from,
  onPerson,
  note,
}: Pick<HeldLetterProps, "letter" | "from" | "onPerson"> & { note?: React.ReactNode }) {
  const address = displayAddress(from.address);
  return (
    <MessageHead
      sender={{ name: from.name?.trim() || address, address, onPress: onPerson }}
      note={note}
      stamp={{ when: letter.time, full: false, title: letter.time }}
    />
  );
}

function HeldLetterContent({
  letter,
  from,
  position,
  checked,
  segment,
  invites,
  onPerson,
  onRetry,
  letters,
}: HeldLetterProps & { letters: HeldParts | typeof NONE }) {
  const t = useText("screener");
  const bodyWords = useText("body");
  const { host } = useFrame();
  const scheme = useSignal(host.device.appearance).scheme;
  const body = useLetterBody(asMessage(letter));
  const { waiting, failed, retry } = useHeldBodyStall(letter.id, body.state, onRetry);
  const presented = usePresentedMirror();
  const message = presented?.get<EngineMessage>("message", letter.id);
  const { invitation } = useScreenerBeside();
  const readerInvitation = letters === NONE ? undefined : letters.invitation;
  const Invitation = invites && segment === "waiting" ? (readerInvitation ?? NONE) : NONE;
  const [notice, setNotice] = useState<LetterNotice | null>(null);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [controls, setControls] = useState<readonly LetterControl[]>([]);
  const views = controls.filter((c) => c.id !== "history");
  let text;
  if (letters === NONE) text = <p className="oh-text">{body.text}</p>;
  else {
    const Body = letters.body;
    text = (
      <Body
        {...letterPictures(
          { id: letter.id, senderCheck: checked },
          false,
          letters.pictures,
          letters.files,
          false,
          false,
        )}
        messageId={letter.id}
        text={body.text}
        html={body.html}
        subject={letter.subject}
        scheme={scheme}
        owner={host.session.scope}
        onNotice={setNotice}
        onControls={setControls}
      />
    );
  }
  return (
    <Message
      id={heldMark(letter.id)}
      position={position}
      head={
        <HeldHead
          letter={letter}
          from={from}
          onPerson={onPerson}
          note={
            notice ? (
              <BlockedImages
                describe
                caption={notice.caption}
                sentence={notice.text}
                open={noticeOpen}
                onOpen={() => setNoticeOpen(true)}
                onClose={() => setNoticeOpen(false)}
              />
            ) : undefined
          }
        />
      }
      subject={letter.subject}
      lead={
        <>
          {views.length > 0 ? (
            <LetterViews
              label={t("place.views")}
              views={views.map((c) => ({ id: c.id, label: c.label, onPress: c.onPress }))}
            />
          ) : null}
          {Invitation !== NONE ? (
            <Invitation
              messageId={letter.id}
              invitationWithoutEvent={message?.invitationWithoutEvent === true}
              text={body.text}
              full={body.state === "full"}
            />
          ) : invites && invitation !== NONE ? (
            <HeldInvitation messageId={letter.id} segment={segment} />
          ) : null}
        </>
      }
      files={
        letters !== NONE && message && !isProtected(message) ? (
          <LetterFiles messageId={letter.id} parts={letters} />
        ) : null
      }
    >
      {failed ? (
        <RefusalLine way={{ label: t("retry"), onPress: retry }}>{t("place.bodyFailed")}</RefusalLine>
      ) : null}
      {waiting && !failed ? (
        <p className="oh-text" role="status">
          {bodyWords("loading")}
        </p>
      ) : null}
      {body.state === "withheld" && body.withheld === "too_large" ? (
        <RefusalLine>{bodyWords("withheldTooLarge")}</RefusalLine>
      ) : null}
      {text}
      {/* A kept-out sender's letter, once its text (and so its headers' posture) has arrived. */}
      {segment !== "waiting" && body.state === "full" ? (
        <HeldUnsubscribe messageId={letter.id} state={body.unsubscribe} url={body.unsubscribeUrl} />
      ) : null}
    </Message>
  );
}

function useHeldBodyStall(
  id: string,
  state: ReturnType<typeof useLetterBody>["state"],
  onRetry: HeldLetterProps["onRetry"],
) {
  const [attempt, setAttempt] = useState(0);
  const [stalled, setStalled] = useState(false);
  const waiting = state === "loading";
  useEffect(() => {
    setStalled(false);
    if (!waiting) return;
    const timer = setTimeout(() => setStalled(true), HELD_BODY_STALL_MS);
    return () => clearTimeout(timer);
  }, [id, waiting, attempt]);
  const failed = state === "failed" || (waiting && stalled);
  const retry = () => {
    setAttempt((n) => n + 1);
    onRetry(id);
  };
  return { waiting, failed, retry };
}
