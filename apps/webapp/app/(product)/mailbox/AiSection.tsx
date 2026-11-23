"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { AiPane, useAiDoor, type AiDoor, type AiCredits } from "@ohmail/app/settings/ai";
import { aiSettings } from "../../api-client";
import { SELF_HOST_BUILD, serverHello } from "../../hello";
import { TextFromIntl } from "../../shell/LocaleContext";
import { useRefusalSentence } from "../refusal-sentence";

/** The account's AI switches, with any budget already supplied by the access read. */
export function AiSection({ owner, draftReplies, credits, toPlans }: {
  owner?: string | null;
  credits?: AiCredits | null;
  toPlans?: () => void;
  draftReplies?: { enabled: boolean; set(next: boolean): Promise<void> };
}) {
  const tr = useTranslations("aiRefusal");
  const sentence = useRefusalSentence();
  const door = useMemo<AiDoor | null>(() => owner === null ? null : ({
    read: async () => (await aiSettings.get(owner)).aiEnabled,
    set: async (next) => (await aiSettings.set(next, owner)).aiEnabled,
    model: async () => SELF_HOST_BUILD ? (await serverHello())?.features.ai ?? null : null,
    messageFor: sentence,
  }), [owner, sentence]);
  return <TextFromIntl><AccountAi door={door} {...{ owner, draftReplies, credits, toPlans }} noModelSaid={tr("noModel")} /></TextFromIntl>;
}

function AccountAi({ owner, door, draftReplies, credits, toPlans, noModelSaid }: Parameters<typeof AiSection>[0] & {
  door: AiDoor | null;
  noModelSaid: string;
}) {
  const { model, saveDraft } = useAiDoor(door);
  return <AiPane
    model={model}
    noModelSaid={noModelSaid}
    credits={credits}
    toPlans={toPlans}
    draftReplies={draftReplies && {
      enabled: draftReplies.enabled, toggle: (next) => saveDraft(() => draftReplies.set(next)),
    }}
    cloudModel={!SELF_HOST_BUILD && owner != null && model.enabled === true && model.problem === null}
  />;
}
