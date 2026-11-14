/**
 * UNSUBSCRIBE, FOR ONE LETTER OF A SENDER KEPT OUT (Screened out, Spam): said only once the letter's text has
 * arrived, because the posture is read from its headers, and only where the shell hands the request. A one-click
 * route is one explicit press, sent by the server and at most once; the sentence after it follows what the server
 * answered, and a press that can go through again stays. A route by email is said and declined: ohmail never sends
 * mail for the person. A page on the sender's site is said; this folder draws no link from a letter's headers.
 */
import { useState } from "react";
import type { UnsubscribeHeaderState } from "@ohmail/client-engine";
import { Button } from "@ohmail/ui/base";
import { NONE } from "../../host/index.js";
import { useText } from "../../text/index.js";
import { useScreenerBeside } from "../contract.js";

export function HeldUnsubscribe({ messageId, state }: { messageId: string; state: UnsubscribeHeaderState }) {
  const t = useText("screener");
  const { unsubscribe } = useScreenerBeside();
  const [busy, setBusy] = useState(false);
  /** `again`: the press stays where pressing again can go through. */
  const [result, setResult] = useState<{ text: string; again: boolean } | null>(null);
  if (unsubscribe === NONE || state === "no_header") return null;
  if (state === "mailto_only")
    return (
      <p className="oh-text" role="status">
        {t("unsubMailtoOnly")}
      </p>
    );
  if (state === "not_one_click") return <p className="oh-text">{t("unsubOffered")}</p>;
  const run = async () => {
    if (busy || (result !== null && !result.again)) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await unsubscribe(messageId);
      /* The sentence follows the outcome: only a request that settled as sent is "already". */
      const text =
        res?.refusal === "already_recorded"
          ? t("unsubAlready")
          : res?.refusal === "previous_attempt_unsettled"
            ? t("unsubUnfinished")
            : res?.posted
              ? t("unsubSent")
              : t("unsubDone");
      setResult({ text, again: false });
    } catch (err) {
      /* By its code, never the server's English: a list that refused will answer the same again. */
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "unsubscribe_list_refused") setResult({ text: t("unsubListRefused"), again: false });
      else
        setResult({
          text: code === "unsubscribe_list_failed" ? t("unsubListFailed") : t("place.unsubFailed"),
          again: true,
        });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="oh-text">
        {t("unsubOffered")}{" "}
        {result === null || result.again ? (
          <Button kind="two" size="s" disabled={busy} onPress={() => void run()}>
            {busy ? t("unsubSending") : t("unsubscribe")}
          </Button>
        ) : null}
      </p>
      {result !== null ? (
        <p className="oh-text" role="status">
          {result.text}
        </p>
      ) : null}
    </>
  );
}
