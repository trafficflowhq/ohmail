"use client";

import { useState, type ReactElement } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";
import { buildId } from "../build-id";

/**
 * The in-pane failure card — `ViewBoundary`'s fallback. Every recurring incident starts with
 * "it just shows an error", so the card carries the facts a report needs — the build and the
 * view — and a press that copies them with the error's CLASS. Never the message: a thrown value
 * can hold whatever the view was rendering when it threw (a subject, an address).
 */
export function ViewFailCard({ view, error }: { view: string; error: unknown }): ReactElement {
  const t = useTranslations("viewError");
  const [copied, setCopied] = useState(false);
  const kind = error instanceof Error ? error.name : typeof error;
  const details = `${kind} · ${buildId()} · view ${view}`;
  return (
    <section className="view view-fail">
      <div className="view-fail-card">
        <h1>{t("title")}</h1>
        <p>{t("body")}</p>
        {/* A reload and not a re-render of the tree that just threw — `(product)/error.tsx`'s
            reasoning, kept in step. */}
        <Button
          onClick={() => {
            if (typeof window !== "undefined") window.location.reload();
          }}
        >
          {t("action")}
        </Button>
        <p className="page-fail-fact">
          <code>{details}</code>{" "}
          <button
            type="button"
            className="page-fail-copy"
            onClick={() => {
              // Refused outright in an insecure context and deniable at any time. It must not
              // throw, and it need not succeed: the details are selectable text either way.
              try {
                void navigator.clipboard?.writeText(details).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? t("copied") : t("copyDetails")}
          </button>
        </p>
      </div>
    </section>
  );
}
