"use client";

import { useTranslations } from "next-intl";
import { Button, Spinner } from "@ohmail/ui";
import type { LiveBodyRefusal, LiveBodyState } from "@ohmail/app-logic/reading/live-body";

/** Where Settings → Storage lives in the shell's routes, on every door. */
export const STORAGE_PANE_HREF = "#/settings/storage";

const REFUSAL_KEY: Record<LiveBodyRefusal, string> = {
  gone: "liveGone", too_large: "liveTooLarge", busy: "liveBusy", unreachable: "liveUnreachable", failed: "liveFailed",
};

/**
 * A LETTER WHOSE TEXT WAS EMPTIED FOR SPACE, where the mail server can still be asked: the sentence,
 * Load it now and Storage settings. Loaded, the text is the reader's (`MessagePane` draws it through
 * the same body renderer) and this says where it came from. Nothing here writes anything.
 */
export function EmptiedLetter({ sentence, live, onLoad }: {
  /** The withheld sentence (`withheldCopyKey`'s). */
  sentence: string;
  live: LiveBodyState;
  onLoad: () => void;
}) {
  const t = useTranslations("body");
  if ("kind" in live && live.kind === "loaded") {
    return (
      <p className="live-from" role="status">
        <span>{t("liveLoaded")}</span>
        <a href={STORAGE_PANE_HREF}>{t("liveSettings")}</a>
      </p>
    );
  }
  const loading = "state" in live && live.state === "loading";
  return (
    <div className="emptied" role="status">
      <p className="emptied-lead">{sentence}</p>
      {"kind" in live && live.kind === "refused" ? <p className="emptied-warn" role="alert">{t(REFUSAL_KEY[live.reason])}</p> : null}
      <div className="emptied-acts">
        <Button variant="primary" disabled={loading} onClick={onLoad}>
          {loading ? <><Spinner className="emptied-spin" />{t("liveLoading")}</> : t("liveLoad")}
        </Button>
        <a className="btn" href={STORAGE_PANE_HREF}>{t("liveSettings")}</a>
      </div>
      <small className="emptied-note">{t("liveNote")}</small>
    </div>
  );
}
