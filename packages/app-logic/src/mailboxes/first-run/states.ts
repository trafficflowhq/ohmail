/**
 * THE FIRST RUN'S STATES, one row for each the design's registry draws of its onboarding screen that is this stage's
 * (the sign-in, scan, account, verify, factor, codes and plan rows are the doors' and the phone's; the provider tiles
 * and the credentials page are the connect form's own rows). A row says what makes the state: the route's words, the
 * door, and the facts of the mailbox the run is about. The states page draws a state from its row, so a state cannot
 * be drawn in a shape the stage would not take.
 */
import type { OnboardingDoor, OnboardingMailbox, OnboardingStep } from "../../doors/onboarding.js";

export interface FirstRunStateRow {
  /** The registry's key of the onboarding screen. */
  readonly key: string;
  /** The step the stage stands on for it. */
  readonly step: OnboardingStep;
  readonly how: "run" | "again" | "add";
  readonly door: OnboardingDoor;
  /** The mailbox the run is about, or none. */
  readonly mailbox: OnboardingMailbox | null;
  readonly ai: "unset" | "off" | "on-unconfigured" | "on";
  /** Senders waiting in the queue, and the pull's numbers where the step draws them. */
  readonly queued: number;
  readonly pull?: {
    readonly pulled: number;
    readonly serverMessageCount?: number;
    readonly unreachable?: boolean;
  };
  /** A self-hosted server's operator set a model. */
  readonly operatorModel?: boolean;
  /** The step hands a first mailbox off to the page where it is connected (the web's join). */
  readonly handOff?: boolean;
}

const fresh: OnboardingMailbox = {
  organizerRole: "organizer",
  organizedBy: null,
  organizerChecked: true,
  organizeConsentedAt: null,
  initialImportCompletedAt: null,
  importOver: false,
};
const consented: OnboardingMailbox = { ...fresh, organizeConsentedAt: "2026-11-02T08:00:00Z" };
const imported: OnboardingMailbox = {
  ...consented,
  initialImportCompletedAt: "2026-11-02T09:00:00Z",
  importOver: true,
};
const held: OnboardingMailbox = {
  ...fresh,
  organizerRole: "reader",
  organizedBy: { kind: "local", name: "Studio desk", since: "2026-10-01T08:00:00Z" },
  organizerState: "held",
};

const row = (
  key: string,
  step: OnboardingStep,
  mailbox: OnboardingMailbox | null,
  more: Partial<Omit<FirstRunStateRow, "key" | "step" | "mailbox">> = {},
): FirstRunStateRow => ({ key, step, how: "run", door: "cloud", mailbox, ai: "unset", queued: 0, ...more });

/** The registry's order. */
export const FIRST_RUN_STATES: readonly FirstRunStateRow[] = [
  row("screen=onboarding&step=elsewhere", "elsewhere", held),
  row("screen=onboarding&step=agree", "window", fresh),
  row("from=settings&screen=onboarding&step=agree", "window", consented, { how: "again", ai: "on" }),
  row("screen=onboarding&step=ai", "ai", consented),
  row("screen=onboarding&state=off&step=ai", "ai", consented, { door: "selfhost", operatorModel: false }),
  row("screen=onboarding&state=mid&step=wait", "pull", consented, {
    ai: "off",
    pull: { pulled: 4200, serverMessageCount: 9800 },
  }),
  row("screen=onboarding&state=dropped&step=wait", "pull", consented, {
    ai: "off",
    pull: { pulled: 4200, serverMessageCount: 9800, unreachable: true },
  }),
  row("screen=onboarding&state=done&step=wait", "pull", consented, {
    ai: "off",
    pull: { pulled: 9800, serverMessageCount: 9800 },
  }),
  row("screen=onboarding&step=decide", "decide", imported, { ai: "off", queued: 12 }),
  row("screen=onboarding&state=one&step=decide", "decide", imported, { ai: "off", queued: 1 }),
  row("screen=onboarding&step=handoff", "mailbox", null, { handOff: true }),
  row("screen=onboarding&step=pair", "pair", imported, { door: "local", ai: "off" }),
];

/**
 * Registry rows of the onboarding screen this stage does not draw, each by a named class, with its reason, for the
 * studio. Never a row that fits no class.
 */
export const FIRST_RUN_NOT_DRAWN: Readonly<Record<string, readonly string[]>> = {
  /* The design lists the mailboxes connected so far and offers another; the shipped run is about one mailbox and an
     add is a run of its own, from Settings → Mailboxes. */
  "a list of mailboxes the shipped run does not walk": [
    "screen=onboarding&step=mailboxes",
    "screen=onboarding&state=two&step=mailboxes",
    "screen=onboarding&state=five&step=mailboxes",
    "screen=onboarding&state=reader&step=mailboxes",
    "screen=onboarding&state=paired&step=mailboxes",
    "from=settings&screen=onboarding&step=mailboxes",
  ],
  /* Two and no-AI decisions: the guided step is one decision by construction, and it is offered with AI off too. */
  "more than one guided decision": [
    "screen=onboarding&state=two&step=decide",
    "screen=onboarding&state=noai&step=decide",
  ],
};
