/** Default platform wake-up for the public engine constructor. An embedding surface can supply its own. */
export function scheduleSentReplyCheck(delayMs: number, check: () => Promise<void>): () => void {
  const timer = setTimeout(
    () => {
      void check();
    },
    Math.min(2_147_483_647, delayMs),
  );
  if (typeof timer === "object") timer.unref?.();
  return () => clearTimeout(timer);
}
