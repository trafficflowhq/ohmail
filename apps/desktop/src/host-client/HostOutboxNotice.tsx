/**
 * "Changes made while your computer is out of reach are not kept on this device" — the paired
 * page's strip when this browser refuses the database the queued changes live in. The shell's
 * durability strip, in its shape and its slot; the sentence is this door's, because what is not
 * kept here is a change waiting for the host, not a decision.
 */
import { useTranslations } from "next-intl";

export function HostOutboxNotice({ onDismiss }: { onDismiss: () => void }) {
  const t = useTranslations("pairLanding");
  return (
    <div className="upd-bar ohx-durability" role="status">
      <span>{t("outboxNotKept")}</span>
      <button type="button" className="upd-later" onClick={onDismiss}>
        {t("outboxNotKeptDismiss")}
      </button>
    </div>
  );
}
