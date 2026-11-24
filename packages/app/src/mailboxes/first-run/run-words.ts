/**
 * THE RUN'S WORDS OFF THE ADDRESS: which first run it names (a first run, a re-run, an add) and the mailbox it names.
 * One reading for the stage's body and for its seat, so the two never answer about different runs. The mailbox is a
 * claim, as it is written there: the account's own rows answer it.
 */
import type { Route } from "../../frame/contract.js";

export interface RunWords {
  readonly how: "run" | "again" | "add";
  readonly word: string | null;
}

export function runWordsOf(route: Route): RunWords {
  const words = route.stage?.id === "firstRun" ? route.stage.words : {};
  return {
    how: words.how === "again" ? "again" : words.how === "add" ? "add" : "run",
    word: words.mailbox ?? null,
  };
}
