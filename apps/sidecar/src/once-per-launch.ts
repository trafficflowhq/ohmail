/**
 * ONE TRY PER LAUNCH, ANSWERED OR FAILED. A launch-time repair that failed and was retried on every
 * drain logged one line per drain for the whole session over a failure that would not change; the
 * latch is taken before the work runs, so a failure is said once and the next launch asks again.
 */
export function oncePerLaunch(work: () => Promise<void>, failed: (err: unknown) => void): () => Promise<void> {
  let tried = false;
  return async () => {
    if (tried) return;
    tried = true;
    try {
      await work();
    } catch (err) {
      // Said through the caller's logger, once; the latch above keeps the next drain from asking.
      failed(err);
    }
  };
}
