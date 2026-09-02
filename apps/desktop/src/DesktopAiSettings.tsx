/**
 * SETTINGS → DESKTOP → the model, if you want one — the DOOR decision, and nothing else.
 *
 * A standalone install is free and has no account, so the two things that need a model — a routing
 * suggestion for a first-contact sender, and a reply draft — run against one you supply. There is
 * no purchase here and no allowance to top up: whatever the model costs, it costs you directly,
 * under your own key or on your own machine.
 *
 * ── THE FORM LIVES IN `AiProviderForm`, AND THAT IS THE POINT OF THIS FILE BEING THIN ───────
 *
 * The first-run flow asks the same question at its provider step, and two forms over `/local/ai`
 * would be two write paths to one settings file. So the form is its own component and this one is
 * the door test around it. What is left here is the single decision that is genuinely about the
 * PANE rather than about the form: whether a local model is a thing this install has at all.
 *
 * ── THE HOSTED DOOR SHOWS NOTHING, WHERE IT USED TO SHOW A ROW ──────────────────────────────
 *
 * It carried "Model — latest Frontier Models", which is not a fact about this install: nothing on
 * this pane sets it, nothing here can test it, and the words describe whatever the hosted service
 * happens to run this quarter. A settings row that names no setting is a claim dressed as a
 * control. The account's AI belongs to the account, and the panes that are about the account say
 * so; here the honest amount to say is none.
 *
 * ── THE THIRD STATE IS NOT AN ERROR ─────────────────────────────────────────────────────────
 *
 * Nothing configured is a complete, supported way to run this app. Mail is still filed, first
 * contact is still held at the Screener, search still works. What is missing is advice about
 * senders and a first draft of a reply — so the form says that, plainly, rather than nagging.
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
