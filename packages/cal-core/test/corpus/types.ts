/** One calendar text of the corpus, as its unfolded-or-folded physical lines. */
export interface Fixture {
  /** `<where it comes from>/<what it is>`. */
  readonly name: string;
  readonly lines: readonly string[];
}
