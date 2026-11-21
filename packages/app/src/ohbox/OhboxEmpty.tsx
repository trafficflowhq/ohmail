/**
 * THE OHBOX WITH NO ROWS says one true thing: a mailbox to connect, mail still on its way, nothing here, or where
 * the mail went instead. Nothing is said about mail before the Ohbox may say it; while it is still owed, the shell's
 * rows as shape stand where the rows will be.
 */
import { useContext } from "react";
import type { OhboxListModel } from "@ohmail/app-logic/ohbox";
import { useLoadingGrace } from "@ohmail/app-logic/session/loading-grace";
import { Empty } from "@ohmail/ui/base";
import { useText } from "../text/index.js";
import { OhboxShapeContext, type OhboxBeside } from "./beside.js";

export function OhboxEmpty({ model, beside }: { model: OhboxListModel; beside: OhboxBeside }) {
  const t = useText("ohbox");
  const places = useText("place");
  const owed = model.surface !== "empty";
  const shape = useContext(OhboxShapeContext);
  const speak = useLoadingGrace(owed);
  if (beside.mail.mailboxes === 0) {
    const { mailboxesHref: href, mailboxes } = beside.go;
    const way = href !== undefined ? { href } : { onPress: mailboxes };
    return <Empty label={t("connectTitle")} act={{ label: t("connectAction"), ...way }} />;
  }
  if (owed) {
    return (
      <>
        {speak ? (
          <Empty label={t("empty.loading")} />
        ) : (
          <div className="ob-wait" role="status" aria-busy="true" />
        )}
        {beside.shape ?? shape}
      </>
    );
  }
  if (!beside.mail.screenerCandidate) return <Empty label={t("empty.nothing")} />;
  const waiting = beside.doorbell.count;
  return waiting > 0 ? (
    <Empty
      label={t("empty.nothingYet")}
      hot
      act={{ label: places("screener"), onPress: beside.go.screener }}
    />
  ) : (
    <Empty label={t("empty.nothing")} />
  );
}
