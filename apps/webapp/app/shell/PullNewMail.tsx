"use client";

/**
 * "Pull new mail" — the one button that makes the WORKER look at the mail server now. The press, its
 * single flight, the honest settle and the one sentence it says moved to the behaviour package
 * (`@ohmail/app-logic/session/pull-new-mail`), so the rail's foot on the mail ground presses the same
 * binding. Today's shell binds it here over its own capsule and its own words; its two placements
 * (rail foot, topbar; `app.css` shows one at a time) share the one binding: the HOOK is called once in
 * the shell — two hooks would each carry their own `pulling`, and a resize mid-pull would reveal an
 * idle-looking copy that accepts a second POST while the hidden one still polls.
 */
import { useTranslations } from "next-intl";
import { Icon, useToast } from "@ohmail/ui";
import type { MailboxProbe } from "@ohmail/app-logic/mail-state/mail-state-binding";
import {
  usePullNewMail as usePull,
  type PullBinding,
  type PullWords,
} from "@ohmail/app-logic/session/pull-new-mail";

export type { PullBinding };

/** Today's shell's binding of the one Pull new mail: its outcome said in the capsule, in the web's own words. */
export function usePullNewMail(probe?: MailboxProbe): PullBinding {
  const toast = useToast();
  const t = useTranslations("sync");
  return usePull(probe, toast, t as unknown as PullWords);
}

/** One shared binding, two renderers — see the header for why the hook must not live in here. */
export function PullNewMail({ variant, binding }: { variant: "rail" | "topbar"; binding: PullBinding }) {
  const t = useTranslations("sync");
  const { available, pulling, pull } = binding;
  if (!available) return null;

  if (variant === "topbar") {
    return (
      <button
        type="button"
        className={pulling ? "tb-btn pull-busy" : "tb-btn"}
        aria-label={t("pullAria")}
        aria-busy={pulling}
        onClick={pull}
      >
        <Icon name="refresh" />
      </button>
    );
  }
  return (
    <button
      type="button"
      className={pulling ? "rail-pull pull-busy" : "rail-pull"}
      aria-busy={pulling}
      onClick={pull}
    >
      <Icon name="refresh" />
      <span>{pulling ? t("pulling") : t("pull")}</span>
    </button>
  );
}
