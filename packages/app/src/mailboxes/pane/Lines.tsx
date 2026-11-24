import type { ReactNode } from "react";
import { RefusalLine } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import type { PaneModel } from "@ohmail/app-logic/mailboxes/pane/use-pane";
import { lineOf } from "@ohmail/app-logic/mailboxes/pane/lines";
import { MicrosoftApproval } from "../connect/MicrosoftApproval.js";
import { useLine, useSay } from "./say.js";

/**
 * WHAT THE PANE SAYS ABOVE ITS ROWS: that it is reading, that there is none, that a write has not been read back yet,
 * that a sign-in is finishing, the refusal and the outcome of the last press, and that a factor landed after Cancel.
 * A failed read is never "none yet", and "reading" is said only while a read is out. A refusal is an alert; an
 * outcome is a status.
 */
export function PaneLines({
  model,
  microsoftApproval,
}: {
  readonly model: PaneModel;
  readonly microsoftApproval?: () => Promise<string | null>;
}): ReactNode {
  const say = useSay();
  const line = useLine();
  const { list, lines, gated } = model;
  const rows = list.rows;
  const needsApproval =
    lines.error !== null && "said" in lines.error && lines.error.said.key === "oauth_admin_consent_required";
  // A removal's refusal is said at its confirmation while that stands; every other one here.
  const atConfirmation =
    model.refused !== null && model.refused.act.verb !== "organize" && model.removal.removing !== null;
  const refused = model.refused === null || atConfirmation ? null : model.refused.refusal;
  const gatedLine =
    refused === null
      ? null
      : refused.word === "sign_in"
        ? say({ ns: "devices", key: "stepUpExpired" })
        : refused.word === "said"
          ? refused.said
          : refused.word === "mismatch"
            ? say({ key: "removeEraseMismatch" })
            : say({ key: "probe_unknown" });
  const trying = gated.state.at === "trying" ? gated.state.act : null;
  return (
    <>
      {rows === null && list.refused === null ? <SettingNote>{say({ key: "loading" })}</SettingNote> : null}
      {rows !== null && rows.length === 0 && !list.behind ? (
        <SettingNote>{say({ key: "noneYet" })}</SettingNote>
      ) : null}
      {list.behind ? (
        <div role="status">
          <SettingNote>{say({ key: "listBehind" })}</SettingNote>
        </div>
      ) : null}
      {model.finishing ? (
        <div role="status">
          <SettingNote>{say({ key: "oauthFinishing" })}</SettingNote>
        </div>
      ) : null}
      {list.refused !== null ? <RefusalLine alert>{line(lineOf(list.refused))}</RefusalLine> : null}
      {lines.error !== null ? <RefusalLine alert>{line(lines.error)}</RefusalLine> : null}
      {needsApproval && microsoftApproval ? <MicrosoftApproval read={microsoftApproval} /> : null}
      {gatedLine !== null ? <RefusalLine alert>{gatedLine}</RefusalLine> : null}
      {/* A note that warns is a status by itself. */}
      {lines.nothingRan ? <SettingNote warn>{say({ key: "cancelledNothingChanged" })}</SettingNote> : null}
      {lines.notice !== null ? (
        <div role="status">
          <SettingNote>{line(lines.notice)}</SettingNote>
        </div>
      ) : null}
      {trying !== null && !list.behind ? (
        <div role="status">
          <SettingNote>
            {say({
              key:
                trying.verb === "organize"
                  ? "working"
                  : trying.verb === "erase"
                    ? "removeEraseWorking"
                    : "removeWorking",
            })}
          </SettingNote>
        </div>
      ) : null}
    </>
  );
}
