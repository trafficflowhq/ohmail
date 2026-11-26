/** What a door's form shares with every other: the sentences under the page's own, and Sign out asked again. */
import type { ReactNode } from "react";
import { Button } from "@ohmail/ui/base";
import type { PendingSignOutDoor } from "../sign-in/door.js";

/** The sentences under a page's own: one or two, or none. */
export type Refusal = readonly [string] | readonly [string, string] | undefined;

/** A pending sign-out's sentence first, then the step's refusal. */
export function refusalOf(pending: PendingSignOutDoor, refusal: string | null): Refusal {
  const said = [pending.said, refusal].filter((s): s is string => s !== null);
  return said.length === 0 ? undefined : said.length === 1 ? [said[0]!] : [said[0]!, said[1]!];
}

/** Sign out, asked again, where a sign-out this browser asked for ended unconfirmed. */
export function SignOutAgain({ pending, busy }: { pending: PendingSignOutDoor; busy: boolean }): ReactNode {
  return pending.said === null || pending.act === null ? null : (
    <Button kind="two" size="l" disabled={busy || pending.signingOut} onPress={pending.again}>
      {pending.act}
    </Button>
  );
}
