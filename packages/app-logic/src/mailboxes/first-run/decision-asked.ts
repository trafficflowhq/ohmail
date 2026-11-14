/**
 * WHETHER THIS LAUNCH HAS ASKED THE ORGANIZE DECISION of a mailbox nobody decided about, for one account (the scope
 * its frame is mounted under). A first run that drew a step has asked; a run with nothing to draw has not, and leaves.
 * One answer per launch and account: a person who closes setup is not asked again until the app is opened again, and
 * another account signed in in the same tab is asked about its own mailboxes.
 */
const asked = new Set<string>();

/** The stage drew a step for this account: this launch has asked. */
export function markDecisionAsked(scope: string): void {
  asked.add(scope);
}

/** Has this launch asked, for this account. */
export function decisionAsked(scope: string): boolean {
  return asked.has(scope);
}

/** For a test: the next case is a fresh launch. */
export function resetDecisionAskedForTests(): void {
  asked.clear();
}
