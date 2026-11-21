/**
 * UNSUBSCRIBE, FOR ONE LETTER OF A SENDER KEPT OUT (Screened out, Spam): said only once the letter's text has
 * arrived, because the posture is read from its headers, and only where the shell hands the request. A one-click
 * route is one explicit press, sent by the server and at most once; the sentence after it follows what the server
 * answered, and a press that can go through again stays. A route by email is said and declined: ohmail never sends
 * mail for the person. An offered HTTPS page opens through the host's normal link policy.
 */
import type { UnsubscribeHeaderState } from "@ohmail/wire";
import { useState } from "react";
import { linkHref, useRenderedLinks } from "@ohmail/letter-body/links";
import { Button } from "@ohmail/ui/base";
import { NONE } from "../../host/index.js";
import { useText } from "../../text/index.js";
import { useScreenerBeside } from "../contract.js";

/** A refused list's fallback, validated before it becomes a link. */
function refusalSite(error: unknown): string | null {
  const candidate = (error as { details?: { siteUrl?: unknown } } | null)?.details?.siteUrl;
  if (typeof candidate !== "string") return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function HeldUnsubscribe({
  messageId,
  state,
  url,
}: {
  messageId: string;
  state: UnsubscribeHeaderState;
  url: string | null;
}) {
  const t = useText("screener");
  const { unsubscribe } = useScreenerBeside();
  const [busy, setBusy] = useState(false);
  /** `again`: the press stays where pressing again can go through. */
  const [result, setResult] = useState<{ text: string; again: boolean; site?: string | null } | null>(null);
  const candidate = state === "not_one_click" && url ? linkHref(url) : null;
  const href = candidate?.startsWith("https:") ? candidate : null;
  useRenderedLinks([href, result?.site].filter((link): link is string => typeof link === "string"));
  if (state === "not_one_click") {
    return (
      <p className="oh-text">
        {t("unsubOffered")}{" "}
        {href !== null ? (
          <a href={href} target="_blank" rel="noreferrer">
            {t("unsubExternal")}
          </a>
        ) : null}
      </p>
    );
  }
  if (unsubscribe === NONE || state === "no_header") return null;
  if (state === "mailto_only")
    return (
      <p className="oh-text" role="status">
        {t("unsubMailtoOnly")}
      </p>
    );
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
      if (code === "unsubscribe_list_refused") {
        setResult({ text: t("unsubListRefused"), again: false, site: refusalSite(err) });
      } else
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
      {result?.site ? (
        <p className="oh-text">
          <a href={result.site} target="_blank" rel="noreferrer">
            {t("unsubExternal")}
          </a>
        </p>
      ) : null}
    </>
  );
}
