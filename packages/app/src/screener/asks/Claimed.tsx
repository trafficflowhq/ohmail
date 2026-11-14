/**
 * THE LETTERS THAT CLAIMED TO BE A COMPANY, reviewed: each with who and what, the claim's own sentence (at a domain
 * anyone can register, it says so), and Put back; Put back all for the batch. A press asks the model, which asks the
 * install that organizes the mailbox where this one does not; while one is in flight the presses wait.
 */
import { isSharedDomain, type ImpersonationFiledNotice } from "@ohmail/app-logic/screener";
import { Button, Dialog } from "@ohmail/ui/base";
import { useText } from "../../text/index.js";

const domainOf = (from: string | null): string => {
  const at = (from ?? "").lastIndexOf("@");
  return at < 0 ? "" : (from ?? "").slice(at + 1).toLowerCase();
};

export function Claimed({ notice }: { notice: ImpersonationFiledNotice }) {
  const t = useText("screener");
  const count = notice.items.length;
  return (
    <Dialog
      open={notice.open}
      onClose={notice.toggle}
      title={t("impersonationFiled", { count })}
      list
      confirm={{
        label: t("impersonationPutBackAll", { count }),
        disabled: notice.busy,
        onPress: () => notice.putBack(notice.items.map((i) => i.messageId)),
      }}
      keysOn="cancel"
      cancel={{ label: t("impersonationHide") }}
      said={
        notice.said === "failed"
          ? { line: t("impersonationFailed"), refused: true }
          : notice.said === "requested"
            ? { line: t("impersonationRequested") }
            : undefined
      }
    >
      {notice.items.map((i) => {
        const domain = domainOf(i.from);
        const values = { brand: i.brand ?? "", domain };
        return (
          <div key={i.messageId} role="listitem">
            <p className="oh-text">
              {t("impersonationRow", { from: i.from ?? "", subject: i.subject ?? "" })}
            </p>
            <p className="oh-text">
              {isSharedDomain(`x@${domain}`)
                ? t("senderCheck.impersonationShared", values)
                : t("senderCheck.impersonation", values)}
            </p>
            <Button kind="two" size="s" disabled={notice.busy} onPress={() => notice.putBack([i.messageId])}>
              {t("impersonationPutBack")}
            </Button>
          </div>
        );
      })}
    </Dialog>
  );
}
