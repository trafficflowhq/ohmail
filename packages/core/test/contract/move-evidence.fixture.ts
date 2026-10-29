import { reconcile, type ReconcileAction } from "../../src/reconciler.js";
import { classifyDedup, type DedupInput } from "../../src/dedup.js";
import type { FolderStateRow, MoveEvidence, StoredMessage } from "../../src/ports.js";

/**
 * THE MOVE-EVIDENCE CONTRACT, PINNED WHERE THE COMPILER CAN SEE IT.
 *
 * `adopt_external` is the only action that overwrites the user's `desired_folder` with a value we
 * did not choose. Before this slice it fired on nothing but "reality changed under us" — and a
 * stranger can change reality, by delivering a second copy of a message the user already holds. So
 * `evidence` is the missing PREMISE, not a refinement, and it must be impossible to omit.
 *
 * ── WHY A COMPILER AND NOT AN ASSERTION ────────────────────────────────────────────────────
 *
 * Requiredness has no runtime shadow. A `reconcile(state, observed)` call with the third argument
 * dropped would receive `undefined` and — depending on how the guard were written — either throw or
 * silently take a branch; neither is a thing an `expect` can pin as a CONTRACT, and "it happens to
 * throw today" is one refactor away from "it happens to default". `tsc` is the only thing that can
 * say "this call does not exist".
 *
 * The same argument applies to `DedupInput.evidence`: `classifyDedup` is a pure function over an
 * object literal, so a caller that forgets the field gets `undefined`, `permitsAdoption` returns
 * false on it, and the result is `external_copy` — the SAFE answer, which is exactly what makes the
 * omission invisible to every test. A caller who MEANT to pass `correlated_move` and forgot would
 * silently stop adopting real user moves, and nothing would go red.
 *
 * CLAUDE.md, gap almost no test file is typechecked, and `packages/core/test` is one of the
 * ones that is not — a `@ts-expect-error` written in `dedup.test.ts` would be inert. This directory
 * is compiled by the package's contract tsconfig, the root tsconfig references that project,
 * and the rules contract test invokes the same build so a failure arrives with a
 * test name attached.
 */

/** Invariant type equality — distinguishes `any`, and does not accept a mere subtype. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

/** The keys of `T` that a caller cannot omit. */
type RequiredKeys<T> = { [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K }[keyof T];

/**
 * ONE — the evidence union is EXACTLY three members.
 *
 * Stated as the whole set of `kind`s rather than as "appearance_only exists", because both
 * directions are failures. A fourth member added without deciding which side of the consent
 * boundary it is on would compile (`permitsAdoption`'s `never` arm is the runtime half of that);
 * DELETING `verified_absence` would break user-always-wins in the other direction — every real
 * user move `correlateMoves` cannot pair would stop being adopted and `reconcileFolders` would drag
 * it back.
 */
export type MoveEvidenceKindsArePinned = Expect<
  Equal<MoveEvidence["kind"], "correlated_move" | "verified_absence" | "appearance_only">
>;

/** TWO — `reconcile` takes exactly three parameters, and the third is the evidence. */
export type ReconcileTakesEvidence = Expect<
  Equal<Parameters<typeof reconcile>, [FolderStateRow, string, MoveEvidence]>
>;

/**
 * THREE — `DedupInput.evidence` is REQUIRED, not optional-with-a-default.
 *
 * Asserted separately from the key set below, because `Partial<DedupInput>` would satisfy a key-set
 * check and defeat the whole point.
 */
export type DedupEvidenceIsRequired = Expect<
  Equal<Extract<RequiredKeys<DedupInput>, "evidence">, "evidence">
>;

/** FOUR — and the input's shape is exactly these six fields. A seventh fails here; so does a missing one. */
export type DedupInputKeysArePinned = Expect<
  Equal<keyof DedupInput, "change" | "dedupKey" | "existing" | "pendingMoveFolders" | "evidence" | "sentFolder">
>;

const STATE: FolderStateRow = {
  desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener", lastSetBy: "us",
};

const STORED: StoredMessage = {
  id: "m", dedupKey: "fp1:0", nativeLocator: { folder: "INBOX", ref: "1:1" }, threadId: null,
  messageIdHeader: null, bodyHash: "h", subject: "s", fromAddress: "a@b.example",
};

/**
 * FIVE — `adopt_external` IS UNREACHABLE WITHOUT EVIDENCE, written out as the call.
 *
 * Stated twice on purpose. `@ts-expect-error` is satisfied by ANY error on the next line, so on its
 * own it can be kept green by a typo; the `Equal<Parameters<…>>` above it cannot. If the parameter
 * is ever made optional the directive becomes "Unused '@ts-expect-error' directive" (TS2578) and
 * assertion TWO fails in the same build.
 */
// @ts-expect-error — `evidence` is required: adoption must name the disappearance it saw.
export const reconcileWithoutEvidence: ReconcileAction = reconcile(STATE, "ohmail/News");

/** SIX — and so is the classifier's. */
// @ts-expect-error — `evidence` is required on DedupInput for the same reason.
export const classifyWithoutEvidence = classifyDedup({
  change: { type: "create", locator: { folder: "ohmail/News", ref: "1:2" } },
  dedupKey: "fp1:0", existing: STORED, pendingMoveFolders: new Set<string>(),
});

/**
 * SEVEN — a verdict nothing computes must not compile.
 *
 * The directive sits on the property rather than above the call: `@ts-expect-error` suppresses
 * errors on the IMMEDIATELY following line only, and TS2322 for a bad property value is reported at
 * that property, not at the call.
 */
export const reconcileWithAnInventedVerdict: ReconcileAction = reconcile(
  STATE, "ohmail/News",
  // @ts-expect-error — "condstore_modseq" orders observations and establishes NO causation. It is
  // not move evidence, and inventing a member is how it would become one.
  { kind: "condstore_modseq" },
);

/**
 * EIGHT — the shapes a real caller is written against still compile. Without this the refusals above
 * could be satisfied by a contract nothing can use.
 */
export const permittedReconcile: ReconcileAction = reconcile(
  STATE, "ohmail/News", { kind: "correlated_move" },
);
export const permittedReconcileOnAbsence: ReconcileAction = reconcile(
  STATE, "ohmail/News", { kind: "verified_absence" },
);
export const permittedClassify = classifyDedup({
  change: { type: "create", locator: { folder: "ohmail/News", ref: "1:2" } },
  dedupKey: "fp1:0", existing: STORED, pendingMoveFolders: new Set<string>(),
  evidence: { kind: "appearance_only" },
});

/**
 * NINE — `external_copy` is a member of the outcome union, so the commit path has to handle it.
 *
 * `DedupOutcome` is a discriminated union and `commitChange` branches on `plan.outcome`, which is
 * `DedupOutcome["kind"]`. Pinning the member here is what stops a future "simplification" that
 * folds `external_copy` back into `external_move` from being a two-line diff nobody reads.
 */
export type ExternalCopyIsAnOutcome = Expect<
  Equal<
    Extract<ReturnType<typeof classifyDedup>["kind"], "external_copy" | "external_move">,
    "external_copy" | "external_move"
  >
>;
