/**
 * THE FIRST RUN'S WORDS, BY DATA. What differs between the shells is said by total tables keyed by the host's own
 * answers (which first run it walks, whose service it is), never by a branch on a shell's name. Every key is written
 * by its full path, `namespace.key`: the stage reads five namespaces (its own `onboarding`, the Mailboxes place's
 * `mailboxes`, the join's `join`, and the Screener's `seed` and `screener`), one convention for all of them.
 */
import type { OnboardingDoor } from "@ohmail/app-logic/doors/onboarding";
import type { HostCapabilities } from "../../host/index.js";
import type { Text } from "../../text/index.js";

/** The namespaces the stage reads. */
export const FIRST_RUN_NAMESPACES = ["onboarding", "mailboxes", "join", "seed", "screener"] as const;

/** A sentence by its full path, with its values. */
export type Say = (path: string, values?: Record<string, string | number>) => string;

/** The reader over the five namespaces, for one render. */
export function sayOf(lookup: (namespace: string) => Text): Say {
  return (path, values) => {
    const at = path.indexOf(".");
    return lookup(path.slice(0, at))(path.slice(at + 1), values);
  };
}

/** The opening screen's title, by the first run this shell walks. */
export const WELCOME_TITLE: Readonly<Record<OnboardingDoor, string>> = {
  cloud: "onboarding.welcomeCloudTitle",
  local: "onboarding.welcomeTitle",
  selfhost: "onboarding.welcomeTitle",
};

/** "Yes" to AI, and what it means: a model to choose here, the plan's credits, or the operator's key. */
export const AI_YES: Readonly<Record<OnboardingDoor, { readonly label: string; readonly why: string }>> = {
  local: { label: "onboarding.aiYes", why: "onboarding.aiYesWhy" },
  cloud: { label: "onboarding.aiYesCloud", why: "onboarding.aiYesCloudWhy" },
  selfhost: { label: "onboarding.aiYesSelfhost", why: "onboarding.aiYesSelfhostWhy" },
};

/**
 * The provider's step: a model to choose with the shell's own form, the service's sentence, or the operator's.
 * `form`: the step draws the shell's `aiProvider` slot under the AI question's title.
 */
export const PROVIDER_STEP: Readonly<
  Record<
    OnboardingDoor,
    { readonly form: true } | { readonly title: string; readonly body: (on: boolean) => string }
  >
> = {
  local: { form: true },
  cloud: { title: "onboarding.providerCloudTitle", body: () => "onboarding.providerCloudBody" },
  selfhost: {
    title: "onboarding.providerSelfhostTitle",
    body: (on) => (on ? "onboarding.providerSelfhostOn" : "onboarding.providerSelfhostOff"),
  },
};

/** The password's own hint under the connect form, by whose service this is. */
export const PASSWORD_HINT: Readonly<Record<HostCapabilities["service"], string>> = {
  ownComputer: "onboarding.passwordHint",
  managed: "onboarding.passwordHintCloud",
  self: "onboarding.passwordHintCloud",
};

/** Whether the holder's sentence is the managed service's, by whose service this is. */
export const HOLDER_MANAGED: Readonly<Record<HostCapabilities["service"], boolean>> = {
  ownComputer: false,
  managed: true,
  self: false,
};

/** The five places a decision files a sender into, as the Screener names them, with the key each wears. */
export const PLACES = [
  { to: "ohbox", key: "o", name: "screener.pileOhbox", line: "onboarding.decideOhbox" },
  { to: "reads", key: "r", name: "screener.pileReads", line: "onboarding.decideReads" },
  { to: "receipts", key: "c", name: "screener.pileReceipts", line: "onboarding.decideReceipts" },
  { to: "screened", key: "n", name: "screener.pileScreenOut", line: "onboarding.decideScreened" },
  { to: "spam", key: "x", name: "screener.pileSpam", line: "onboarding.decideSpam" },
] as const;

/** The history's rungs, as the window step offers them. */
export const RUNGS = [
  { value: "90", label: "onboarding.win90" },
  { value: "180", label: "onboarding.win180" },
  { value: "365", label: "onboarding.win365" },
  { value: "all", label: "onboarding.winAll" },
] as const;
