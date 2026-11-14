/**
 * ONE HELD LETTER, the Screener's own composition: the kit's message sheet around the body the shell hands the reader.
 * A held letter is shown, never read: nothing marks it read, it has no letter menu, and its pictures stay blocked
 * (`reading` and `presented` are false: no automatic load, no embedded picture asked) until the person presses the
 * body's own Show pictures. A body that failed offers Retry, the one way past a server that refused. Under a letter of
 * Waiting stands the calendar's part for an invitation.
 */
import { useState } from "react";
import type { EmailAddress, EngineMessage } from "@ohmail/client-engine";
import { letterPictures, useLetterBody } from "@ohmail/app-logic/reader";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { RefusalLine } from "@ohmail/ui/base";
import { LetterViews, Message, MessageHead } from "@ohmail/ui/mail";
import { useFrame } from "../../frame/commands.js";
import { useSignal } from "../../frame/feeds.js";
import { NONE } from "../../host/index.js";
import type { LetterControl } from "../../reader/index.js";
import { useText } from "../../text/index.js";
import { useScreenerBeside, type ScreenerSegment } from "../contract.js";
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

export function HeldLetter({
  letter,
  from,
  checked,
  segment,
  invites,
  onPerson,
  onRetry,
}: {
  letter: HeldLetterOf;
  from: EmailAddress;
  /** What ohmail measured about the sender: a claim keeps every picture back. */
  checked: unknown;
  segment: ScreenerSegment;
  /** False where an invitation is never offered: a letter that failed its sender check. */
  invites: boolean;
  onPerson: (anchor: HTMLElement) => void;
  onRetry: (id: string) => void;
}) {
  const t = useText("screener");
  const { letters } = useScreenerBeside();
  const { host } = useFrame();
  const scheme = useSignal(host.device.appearance).scheme;
  const body = useLetterBody(asMessage(letter));
  const [controls, setControls] = useState<readonly LetterControl[]>([]);
  const views = controls.filter((c) => c.id !== "history");
  const who = from.name?.trim() || displayAddress(from.address);
  let text;
  if (letters === NONE) text = <p className="oh-text">{body.text}</p>;
  else {
    const Body = letters.body;
    text = (
      <Body
        {...letterPictures(
          { id: letter.id, senderCheck: checked },
          body.loadedRemoteContent,
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
        onNotice={() => undefined}
        onControls={setControls}
      />
    );
  }
  return (
    <Message
      id={heldMark(letter.id)}
      head={
        <MessageHead
          sender={{ name: who, address: displayAddress(from.address), onPress: onPerson }}
          stamp={{ when: letter.time, full: false, title: letter.time }}
        />
      }
      subject={letter.subject}
      lead={
        views.length > 0 ? (
          <LetterViews
            label={t("place.views")}
            views={views.map((c) => ({ id: c.id, label: c.label, onPress: c.onPress }))}
          />
        ) : undefined
      }
      after={invites ? <HeldInvitation messageId={letter.id} segment={segment} /> : undefined}
    >
      {body.state === "failed" ? (
        <RefusalLine way={{ label: t("retry"), onPress: () => onRetry(letter.id) }}>
          {t("place.bodyFailed")}
        </RefusalLine>
      ) : null}
      {text}
      {/* A kept-out sender's letter, once its text (and so its headers' posture) has arrived. */}
      {segment !== "waiting" && body.state === "full" ? (
        <HeldUnsubscribe messageId={letter.id} state={body.unsubscribe} />
      ) : null}
    </Message>
  );
}
