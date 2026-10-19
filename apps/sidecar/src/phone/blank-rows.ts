/**
 * THE BLANK REPAIR'S STORE READ, NOT IN THIS BUILD — substituted for `./blank-rows.js` where
 * `packages/core/src/adapters/drizzle-repo.ts` imports it.
 *
 * `WorkerRepo.listBlankMessages` has one caller, the blank repair (`apps/worker/src/blank-repair.ts`),
 * and the phone carries no repair: its composition passes `blankRepair: "off"` and the pass itself is
 * a twin that refuses (`./blank-repair.ts`). The method stays on the repository and answers this
 * refusal, so nothing on a phone reads blank rows to act on them half way.
 */
export async function listBlankMessageRows(_db: unknown, _mailboxId: string, _placeLimit: number): Promise<never> {
  throw new Error("this build does not repair blank messages, so it lists none");
}
