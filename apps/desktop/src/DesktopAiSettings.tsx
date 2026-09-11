/**
 * SETTINGS → DESKTOP → the model, if you want one — the DOOR decision, and nothing else. A
 * standalone install has no account: the routing suggestion and the reply draft run against a
 * model you supply, at your own direct cost. The form lives in `AiProviderForm` (the
 * first-run flow asks the same question, and two forms over `/local/ai` would be two write
 * paths to one settings file); what is left here is the one decision about the PANE — whether
 * a local model is a thing this install has at all. THE HOSTED DOOR SHOWS NOTHING, where it
 * used to show "Model — latest Frontier Models": nothing on this pane sets it or can test it,
 * and a settings row that names no setting is a claim dressed as a control — the account's AI
 */

/*
 * belongs to the account. THE THIRD STATE IS NOT AN ERROR: nothing configured is a complete,
 * supported way to run this app — mail is filed, first contact held, search works — and the
 * form says what is missing, plainly, rather than nagging.
 */

import { useTranslations } from "next-intl";
import { SettingsSubhead } from "@ohmail/ui";

import { AiProviderForm } from "./AiProviderForm.js";
import type { LocalAiStatus } from "./local-ai.js";

export function DesktopAiSettings({
  /**
   * Which door this install came in by. The form is offered on the standalone door only — an
   * install pointed at a hosted account has no local model settings, because the AI that account
   * has belongs to that account.
   */
  door,
  /** Published upward so the Screener's own control can read the same state. */
  onStatus,
}: {
  door: "local" | "cloud" | null;
  onStatus?: (status: LocalAiStatus | null) => void;
}) {
  /* THE DOOR TEST COMES BEFORE ANY HOOK, so a hosted install mounts nothing here — not even a
     component that reads a catalogue it is never going to render from. That is why the pane's own
     heading lives one level down: `useTranslations` cannot be called conditionally, so keeping it
     in this function would make every hosted mount depend on an intl provider for a subhead it
     does not draw. */
  if (door !== "local") return null;
  return <LocalAiPane {...(onStatus ? { onStatus } : {})} />;
}

function LocalAiPane({ onStatus }: { onStatus?: (status: LocalAiStatus | null) => void }) {
  const t = useTranslations("aiProvider");
  return (
    <>
      <SettingsSubhead>{t("subhead")}</SettingsSubhead>
      <AiProviderForm {...(onStatus ? { onStatus } : {})} />
    </>
  );
}
