import { useEffect, useState } from "react";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { Dialog, Notice } from "@ohmail/ui/base";
import { useText } from "../../text/index.js";
import type { ScreenerJunk } from "../ports.js";

export function QuarantineMove({ sweep }: { sweep: NonNullable<ScreenerJunk["sweep"]> }) {
  const t = useText("screener");
  const [question, setQuestion] = useState<string | null>(null);
  const { preview, phase } = sweep;
  const confirmation = preview?.confirmation;
  const canMove =
    confirmation !== undefined && (preview?.movable ?? 0) > 0 && (phase === "offer" || phase === "failed");
  const open = canMove && !sweep.requesting && question === confirmation;
  const close = () => setQuestion(null);
  useEffect(() => {
    if (!open && question !== null) setQuestion(null);
  }, [open, question]);
  if (preview === null || phase === "unknown") return null;
  const { movable, mailboxes, confirmationRequired } = preview;
  const move = {
    label: t("junkSweepAction"),
    busy: sweep.requesting,
    onPress: () => setQuestion(confirmation ?? null),
  };
  const dismiss = {
    label: t("junkSweepDismiss"),
    disabled: sweep.requesting,
    onPress: () => {
      close();
      sweep.dismiss();
    },
  };
  return (
    <div className="sc-notices">
      {confirmationRequired && !canMove && <Notice place="bar" title={t("quarantineMove.confirmAgain")} />}
      {canMove || phase === "pending" ? (
        <Notice
          place="bar"
          title={t("quarantineMove.title", { count: movable })}
          hot={phase === "failed"}
          line={t(
            phase === "pending"
              ? "quarantineMove.queued"
              : phase === "failed"
                ? "quarantineMove.failed"
                : confirmationRequired
                  ? "quarantineMove.confirmAgain"
                  : "quarantineMove.hint",
          )}
          acts={canMove ? (confirmationRequired ? [move] : [move, dismiss]) : undefined}
        />
      ) : phase === "done" ? (
        <Notice place="bar" title={t("quarantineMove.done")} />
      ) : null}
      {mailboxes
        .filter((box) => !box.hasJunkFolder && box.candidates > 0)
        .map((box) => (
          <Notice
            key={box.id}
            place="bar"
            title={t("quarantineMove.stays", { count: box.candidates })}
            line={t("quarantineMove.noFolder", { address: displayAddress(box.address) })}
          />
        ))}
      <Dialog
        open={open}
        onClose={close}
        title={t("junkSweepAction")}
        line={t("quarantineMove.confirm")}
        keysOn="cancel"
        confirm={{
          label: t("junkSweepConfirm", { count: movable }),
          onPress: () => {
            close();
            if (open && confirmation !== undefined) sweep.request(confirmation);
          },
        }}
        cancel={{ label: t("junkSweepCancel") }}
      />
    </div>
  );
}
