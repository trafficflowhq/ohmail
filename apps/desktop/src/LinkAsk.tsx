/**
 * THE ASK BEFORE A MARKED LINK OPENS, ON THE DESKTOP. A message link whose label names another site
 * (`markElsewhere` in `MessageBody.tsx`) reaches the shell's new-window door like any other; the
 * shell holds the person's press and hands this window a token and the address (`link:ask`). The
 * window names where the link goes, outside the letter, where its styles cannot reach. Open sends
 * the token back (`link_ask_open`) and the shell opens what it holds; Cancel and Escape send nothing.
 * The window never names an address to the shell.
 */
import { useWindowReport } from "@ohmail/app/frame";
import { Dialog } from "@ohmail/ui/base";
import { MAIL_BODY_COPY as COPY } from "@ohmail/letter-body";
import { useModalGate } from "@ohmail/app-logic/session/modal-gate";
import { linkAskOpen, type LinkAsk as HeldPress } from "./native.js";

/** The ask over whichever screen the gate shows. The layer claims the window while it is up. */
export function LinkAsk({ ask, onClose }: { ask: HeldPress; onClose: () => void }) {
  const report = useWindowReport();
  useModalGate(true);
  const host = new URL(ask.url).hostname;
  const open = (): void => {
    onClose();
    linkAskOpen(ask.token).catch(() => report?.(COPY.linkAskGone));
  };
  return (
    <div className="oh-root">
      <Dialog
        open
        alert
        inline
        hot
        title={COPY.linkAskHeading(host)}
        line={COPY.linkAskElsewhere}
        announceLine
        keysOn="cancel"
        dismissOnScrim={false}
        confirm={{ label: COPY.linkAskOpen(host), onPress: open }}
        cancel={{ label: COPY.linkAskCancel }}
        onClose={onClose}
      >
        <p className="oh-text">{ask.url}</p>
      </Dialog>
    </div>
  );
}
