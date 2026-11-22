"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AiPane } from "@ohmail/app/settings/ai";
import { aiSettings } from "../../api-client";
import { SELF_HOST_BUILD, serverHello } from "../../hello";
import { TextFromIntl } from "../../shell/LocaleContext";
import { useRefusalSentence } from "../refusal-sentence";

/** The account's AI switches, with any budget already supplied by the access read. */
export function AiSection({ owner, draftReplies, credits, toPlans }: {
  owner?: string | null;
  credits?: { remaining: number; total?: number } | null;
  toPlans?: () => void;
  draftReplies?: { enabled: boolean; set(next: boolean): Promise<void> };
}) {
  const t = useTranslations("settings");
  const tr = useTranslations("aiRefusal");
  const sentence = useRefusalSentence();
  /**
   * A SELF-HOSTED SERVER WITH NO MODEL, from `/hello` — `true` only once the server says so. The
   * switch still reads the account's flag; this says why nothing will answer while it is on.
   * Compiled away on the managed build, which pays no round trip for it.
   */
  const [noModel, setNoModel] = useState(false);
  /** `null` = the server has not answered. The switch is drawn and NOT pressable until it has. */
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The pane can be navigated away from mid-write; nothing may set state after that. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, [owner]);

  useEffect(() => {
    if (owner === null) return;
    let current = true;
    void aiSettings.get(owner)
      .then(({ aiEnabled }) => { if (current) setEnabled(aiEnabled); })
      /* Left UNKNOWN rather than guessed. A switch drawn OFF for an account that has it ON is a
         false statement about what that account is doing, on the one screen that exists to state
         it — so an unread flag renders as an unpressable switch and a sentence, not a position.
         The CATALOGUE's sentence, not the error's: a failed read has nothing specific to say and
         the remedy is the same either way. A refused WRITE does, and shows the server's own. */
      .catch(() => { if (current) setError(t("aiUnreadable")); });
    return () => { current = false; };
  }, [owner, t]);

  useEffect(() => {
    if (!SELF_HOST_BUILD) return;
    void serverHello().then((h) => { if (alive.current && h?.features.ai === false) setNoModel(true); });
  }, []);

  const toggle = useCallback((next: boolean) => {
    if (owner === null) return;
    setError(null);
    const previous = enabled;
    setEnabled(next);                 // optimistic: the switch must answer the press at once
    void (async () => {
      try {
        const { aiEnabled } = await aiSettings.set(next, owner);
        // THE SERVER'S ANSWER WINS, not ours — it is the value every AI call site will read.
        if (alive.current) setEnabled(aiEnabled);
      } catch (err) {
        if (!alive.current) return;
        setEnabled(previous);         // …and a refusal puts the switch back where it was
        setError(sentence(err));
      }
    })();
  }, [enabled, owner, sentence]);

  const [savingDraftReplies, setSavingDraftReplies] = useState(false);
  function toggleDraftReplies(next: boolean) {
    if (!draftReplies || savingDraftReplies) return;
    setError(null);
    setSavingDraftReplies(true);
    void draftReplies.set(next).catch((err: unknown) => {
      if (alive.current) setError(sentence(err));
    }).finally(() => setSavingDraftReplies(false));
  }

  return (
    <TextFromIntl>
      <AiPane model={{ enabled, problem: error, noModel, toggle }} noModelSaid={tr("noModel")} credits={credits} toPlans={toPlans} draftReplies={draftReplies && { enabled: draftReplies.enabled, toggle: toggleDraftReplies }} cloudModel={!SELF_HOST_BUILD && owner != null && enabled === true && error === null} />
    </TextFromIntl>
  );
}
