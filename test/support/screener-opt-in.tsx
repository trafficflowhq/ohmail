import { ScreenerPane, type ScreenerSuggest } from "../../packages/app/src/settings/screener/index.js";

export type { ScreenerSuggest };

/** The existing paid opt-in row alone, for tests of the account's consent and quote wires. */
export function ScreenerOptInFixture({ suggest }: { readonly suggest: ScreenerSuggest | null }) {
  return (
    <ScreenerPane
      model={{
        suggest,
        ohbox: null,
        window: null,
        ownSuggest: null,
        act: null,
        unsubscribe: null,
        review: null,
        filed: null,
      }}
    />
  );
}
