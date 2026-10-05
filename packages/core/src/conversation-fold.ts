/**
 * THE CONVERSATION FOLD OVER A RESURFACE PIN — which conversations a pin brings back as one row.
 * Import-free and read by two graphs that share nothing else: the client engine builds the Ohbox's
 * resurfaced rows with it (`resurfacedThreads`) and the server's "New for you" holds their members
 * out with it (`MessageService.list`, `TriageService.powerThrough`). One membership rule, so an
 * unread reply in a brought-back thread is absent from the group on every door or on none.
 */

/** One message as the fold reads it; each door derives the fields from its own row. */
export interface FoldMember {
  id: string;
  threadId: string | null;
  /** The instant the row sorts by (`sortAt ?? date ?? arrivedAt`), or `null` when none is readable. */
  arrivedMs: number | null;
  /** A person wrote it: not the account's own mail, not the away responder's, not a calendar ack. */
  fromSomeone: boolean;
  unread: boolean;
  /** The message's winning triage state, and when it was set. */
  state: string | null;
  setAtMs: number | null;
  /**
   * The message stands where a decision or the person put it — not held at the gate, screened out
   * or quarantined. Required, so neither door can forget it; each fills it from its own folder
   * (`isHeldFolder`), because this module imports nothing (the worker loads it under plain Node).
   */
  placed: boolean;
}

export interface ResurfacedFold<M extends FoldMember> {
  /** The thread id, or `msg:<id>` for a message with none. */
  key: string;
  members: M[];
  /** The members carrying a `resurfaced` or `bubbled_up` state. */
  pinned: M[];
  /** The newest pin's `setAt`, the moment the row asks about. */
  sinceMs: number | null;
  /** Unread mail somebody wrote after that moment — the row's badge. */
  newSince: M[];
  /** No member is `resurfaced`: the row stands because somebody wrote into a parked thread. */
  pulledForward: boolean;
}

/** WHICH CONVERSATION A MESSAGE BELONGS TO: its thread, or itself (`msg:` never meets a thread id). */
export function conversationKey(m: Pick<FoldMember, "id" | "threadId">): string {
  return m.threadId ?? `msg:${m.id}`;
}

/**
 * The conversations the pins bring back. A conversation is a row when a member is `resurfaced`,
 * or when a member is `bubbled_up` and somebody wrote into it after that pin (the PULL-FORWARD:
 * read state is not the question, a read reply still moved the thread on). Members keep the
 * caller's order; rows come out in first-seen order, and ranking them is the caller's.
 */
export function resurfacedFolds<M extends FoldMember>(members: readonly M[]): ResurfacedFold<M>[] {
  const byKey = new Map<string, M[]>();
  for (const m of members) {
    // A held message is no member: a header another sender wrote threads it, its place does not.
    // The person's own pin places it wherever it sits.
    if (!m.placed && m.state !== "resurfaced" && m.state !== "bubbled_up") continue;
    const key = conversationKey(m);
    const held = byKey.get(key);
    if (held) held.push(m);
    else byKey.set(key, [m]);
  }
  const out: ResurfacedFold<M>[] = [];
  for (const [key, group] of byKey) {
    const pinned = group.filter((m) => m.state === "resurfaced" || m.state === "bubbled_up");
    if (pinned.length === 0) continue;
    const hasResurfaced = pinned.some((m) => m.state === "resurfaced");
    let sinceMs: number | null = null;
    for (const m of pinned) if (m.setAtMs !== null && (sinceMs === null || m.setAtMs > sinceMs)) sinceMs = m.setAtMs;
    const after = (m: M): boolean => m.fromSomeone && m.arrivedMs !== null && sinceMs !== null && m.arrivedMs > sinceMs;
    if (!hasResurfaced && !group.some(after)) continue;
    out.push({ key, members: group, pinned, sinceMs, newSince: group.filter((m) => m.unread && after(m)), pulledForward: !hasResurfaced });
  }
  return out;
}

/** Every member id of every row {@link resurfacedFolds} returns — what a group beside it holds out. */
export function heldOutByFolds(members: readonly FoldMember[]): Set<string> {
  const out = new Set<string>();
  for (const f of resurfacedFolds(members)) for (const m of f.members) out.add(m.id);
  return out;
}
