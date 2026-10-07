/**
 * THE BRIDGE DEADLINE FOR THE THREE CALLS THAT MAY WAIT ON A MAIL SERVER ON THIS COMPUTER — the
 * Test, the add and the seal. The engine gives a loopback host 150 s to answer a sign-in (the
 * sync dial's 15 + 15 + 120), the submission leg keeps its 20 s, and the seal waits 30 s for its
 * launch: 200 s, and a margin. Every other call keeps the one minute (`shell-deadline.ts`).
 */
export const LOCAL_SERVER_CALL_DEADLINE_MS = 240_000;
