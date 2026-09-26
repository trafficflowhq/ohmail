"use client";

import { useTranslations } from "next-intl";

/**
 * THE ACCOUNT WAS DELETED ELSEWHERE — the whole page, in the `.gate` shell every full-screen
 * sentence here stands in. Two sentences: what happened and the mailbox's standing. The copy in
 * this browser is already being dropped (`erased-door.ts`); `blocked` says when another tab still
 * holds it open. The way on is a full page load, which starts from a clean module state.
 */
export function ErasedWall({ blocked }: { blocked: boolean }) {
  const t = useTranslations("accessLock");
  return (
    <main className="gate">
      <div className="gate-card wall-card">
        <span className="wordmark">
          <b>
            <em>oh</em>mail
          </b>
        </span>
        <h1>{t("erasedTitle")}</h1>
        <p className="wall-lead">{t("erasedBody")}</p>
        {blocked ? <p className="wall-fine" role="status">{t("erasedBlocked")}</p> : null}
        <div className="gate-actions">
          <a className="btn" href="/">{t("erasedHome")}</a>
        </div>
      </div>
    </main>
  );
}
