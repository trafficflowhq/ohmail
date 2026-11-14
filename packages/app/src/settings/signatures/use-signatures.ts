import type { ReactNode } from "react";
import { useConsent, type TravelledChangeWire } from "@ohmail/app-logic/consent";
import { useDemoMode } from "@ohmail/app-logic/engine";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { liveMailboxes } from "@ohmail/app-logic/mail-state/mail-state";
import { organizerRefusalOf, organizerRefusalSentence } from "@ohmail/app-logic/press/organizer-refusal";
import { useFrame } from "../../frame/commands.js";
import { useText } from "../../text/reader.js";
import type { SignaturesModel } from "./model.js";

interface SignatureParts {
  editor: SignaturesModel["editor"];
  changeNote(change: TravelledChangeWire | undefined): ReactNode;
}

/** A signature belongs to its live mailbox and the consent row shared with this frame's composer. */
export function useSignaturesModel(parts: SignatureParts): SignaturesModel | null {
  const demo = useDemoMode();
  const consent = useConsent();
  const { mailboxes } = useMailState();
  const { host } = useFrame();
  const why = useText("ohbox");
  const live = liveMailboxes(mailboxes);
  if (demo || !consent.signaturesKnown || !live?.length) return null;
  return {
    mailboxes: live.map((mailbox) => ({
      id: mailbox.id,
      address: mailbox.address,
      stored: { text: consent.signatures[mailbox.id] ?? "", html: consent.signaturesHtml[mailbox.id] ?? "" },
      reading: mailbox.organizerRole === "reader" && consent.signatureSources[mailbox.id] === "organizer",
      takeoverAsked: Boolean(mailbox.takeoverAuthorizedAt),
    })),
    write: consent.saveMailboxSignature,
    refusal: (error, starting) =>
      organizerRefusalSentence(
        organizerRefusalOf(error as Parameters<typeof organizerRefusalOf>[0], { starting }),
        why,
      ),
    holdLeave: (ask) => host.device.address.holdLeave(ask, "#/settings/signatures"),
    editor: parts.editor,
    changeNote: (id) => parts.changeNote(consent.signatureChanges[id]),
  };
}
