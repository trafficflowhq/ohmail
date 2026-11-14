/**
 * A CLOSED SET IS A UNION HERE AND A LIST WHERE IT RUNS. This package exports no value, so each side
 * that needs the set at run time keeps its own `as const` list and proves it against the union:
 *
 *     const KINDS = ["a", "b"] as const satisfies readonly Kind[];   // nothing in the list is foreign
 *     const kindsComplete: Complete<Kind, typeof KINDS> = true;       // nothing of the union is missing
 *
 * `satisfies` refuses a member the union does not have. `Complete` refuses the other direction: it
 * is `true` while every member of the union is in the list, and otherwise an object type whose one
 * key names what is missing, so the compile error on the line that assigns `true` says which.
 */
export type Complete<Union, List extends readonly unknown[]> =
  [Exclude<Union, List[number]>] extends [never]
    ? true
    : { "missing from the list": Exclude<Union, List[number]> };

/**
 * Two types that must stay the same set, proven in both directions. `true` while they are; an
 * object type naming the difference otherwise. For a list derived elsewhere (a column's own closed
 * set) that the wire spells out again.
 */
export type Same<A, B> =
  [Exclude<A, B>] extends [never]
    ? [Exclude<B, A>] extends [never]
      ? true
      : { "only in the second": Exclude<B, A> }
    : { "only in the first": Exclude<A, B> };

/**
 * Holds a proof at compile time without a value: `type _KindsComplete = Assert<Complete<Kind,
 * typeof KINDS>>` fails to compile the moment the proof is not `true`, and emits nothing.
 */
export type Assert<T extends true> = T;
