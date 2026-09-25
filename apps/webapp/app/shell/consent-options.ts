import type { ConsentOptions } from "@ohmail/client-engine";

/** What the shell knows about the account's cutline, as `consent-state.ts` holds it. */
export interface ShellConsentFacts {
  known: boolean;
  standalone: boolean;
  dormancyDays: number;
  screeningBaselineAt: string | null;
  screeningScope: "window" | "all_time";
  foldersEnabled: boolean;
}

/**
 * THE OPTIONS THE SHELL'S LISTS ARE PARTITIONED WITH — one builder, read by the lists
 * (`shell-derivations.ts`) and by a screening press's read-back (`press-verdict.ts`), so the
 * sentence after a press and the list it describes cannot place one row two ways.
 */
export function shellConsentOptions(
  consent: ShellConsentFacts, now: Date, ownAddresses: readonly string[],
): ConsentOptions {
  return {
    rulesOnly: !(consent.known || consent.standalone),
    now,
    dormancyDays: consent.dormancyDays,
    baselineAt: consent.screeningBaselineAt,
    // THE MODE, or the window it names is resolved and then ignored (mail 0083). The server's
    // router has honoured `all_time` since the column landed; this partition is what the Screener
    // queue and the History placement are built from on the client.
    screeningScope: consent.screeningScope,
    ownAddresses,
    // The History-lens gate (spec §16.5): the CONSENT answer, not the mirror's folder entities —
    // stale entities after a missed disable must not keep the lens on.
    foldersEnabled: consent.foldersEnabled,
  };
}
