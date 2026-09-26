/* THE ONE BASE EVERY REQUEST IS COMPOSED OFF — see `request-base.ts`. */
import { requestBase } from "./request-base";

/**
 * A SETTINGS DOCUMENT ANOTHER OHMAIL SAVED IN THE MAILBOX — the four calls the web's card and
 * Settings row make (`/mailboxes/:id/profile-import`, `/decline`, `/replace`), on this session's
 * transport only: the engine in this app on the standalone door, the paired server otherwise.
 * No origin of its own. A read that could not be made answers `null`, never `none`: an organizer
 * with an open question files no stranger and writes no decision until somebody answers it.
 */

/**
 * The two members of a `ConnectedSession` these calls use — its door and where its API is.
 * Structural, so the seam imports nothing from the pairing layer.
 */
export interface ProfileImportSession {
  readonly profile: { readonly origin: string; readonly apiBase: string | null };
  fetch(url: string, init?: unknown): Promise<Response>;
}

export interface ProfileImportCounts {
  screener: number;
  rules: number;
  notifyRules: number;
  tags: number;
  awayResponder: boolean;
}

/** What the door answered, narrowed to the three shapes a person is asked about. */
export type ProfileImportQuestion =
  | { state: "none" }
  | {
    /** `found` is the open question; `declined` is a "Not now" whose document still stands. */
    state: "found" | "declined";
    fingerprint: string;
    updatedAt: string;
    producer: { kind: string; version: string };
    counts: ProfileImportCounts;
  }
  | { state: "newer"; v: number };

/** What a press settled. `message` is the door's own sentence for a refusal, when it wrote one. */
export type ProfileImportAnswer =
  | { kind: "done"; imported: ProfileImportCounts | null; skippedRules: number }
  | { kind: "refused"; status: number | null; message: string | null };

function countsOf(raw: unknown): ProfileImportCounts | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  for (const k of ["screener", "rules", "notifyRules", "tags"] as const) {
    if (typeof c[k] !== "number") return null;
  }
  if (typeof c.awayResponder !== "boolean") return null;
  return {
    screener: c.screener as number, rules: c.rules as number, notifyRules: c.notifyRules as number,
    tags: c.tags as number, awayResponder: c.awayResponder,
  };
}

/**
 * THE TOLERANT READER, the web card's `asOffer` rule: only a fully formed answer asks anything.
 * `too_large` and every shape this build does not know read as `none` — nothing is offered that
 * the door did not fully describe.
 */
export function questionOf(dto: unknown): ProfileImportQuestion {
  if (typeof dto !== "object" || dto === null) return { state: "none" };
  const d = dto as Record<string, unknown>;
  if (d.state === "newer" && typeof d.v === "number" && Number.isInteger(d.v)) return { state: "newer", v: d.v };
  if (d.state !== "found" && d.state !== "declined") return { state: "none" };
  if (typeof d.fingerprint !== "string" || d.fingerprint.length === 0) return { state: "none" };
  if (typeof d.updatedAt !== "string") return { state: "none" };
  const producer = d.producer as Record<string, unknown> | null | undefined;
  if (typeof producer !== "object" || producer === null) return { state: "none" };
  const counts = countsOf(d.counts);
  if (counts === null) return { state: "none" };
  return {
    state: d.state,
    fingerprint: d.fingerprint,
    updatedAt: d.updatedAt,
    producer: {
      kind: typeof producer.kind === "string" ? producer.kind : "unknown",
      version: typeof producer.version === "string" ? producer.version : "",
    },
    counts,
  };
}

const pathOf = (mailboxId: string): string => `/mailboxes/${encodeURIComponent(mailboxId)}/profile-import`;

/** Ask the door about one mailbox. `null` is "could not ask". */
export async function readProfileImport(session: ProfileImportSession, mailboxId: string): Promise<ProfileImportQuestion | null> {
  try {
    const res = await session.fetch(`${requestBase(session)}${pathOf(mailboxId)}`, { method: "GET" });
    if (res.status !== 200) return null;
    return questionOf(await res.json());
  } catch {
    return null;
  }
}

/** The door's own sentence, when its refusal carried one. */
async function refusalOf(res: Response): Promise<ProfileImportAnswer> {
  let message: string | null = null;
  try {
    const said = ((await res.json()) as { error?: { message?: unknown } }).error?.message;
    if (typeof said === "string" && said.trim().length > 0) message = said;
  } catch {
    /* Not JSON, or an empty body: the status is all there is. */
  }
  return { kind: "refused", status: res.status, message };
}

/**
 * ANSWER THE QUESTION — `import` applies the exact document shown (the fingerprint is the
 * consent), `notNow` records the decline durably for that document or that newer format,
 * `save` puts this ohmail's settings in the mailbox in place of the declined document.
 */
export async function answerProfileImport(
  session: ProfileImportSession,
  mailboxId: string,
  verb: "import" | "notNow" | "save",
  subject: { fingerprint: string } | { v: number },
): Promise<ProfileImportAnswer> {
  const tail = verb === "import" ? "" : verb === "notNow" ? "/decline" : "/replace";
  let res: Response;
  try {
    res = await session.fetch(`${requestBase(session)}${pathOf(mailboxId)}${tail}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(subject),
    });
  } catch {
    return { kind: "refused", status: null, message: null };
  }
  if (res.status !== 200) return refusalOf(res);
  if (verb !== "import") return { kind: "done", imported: null, skippedRules: 0 };
  try {
    const body = (await res.json()) as Record<string, unknown>;
    return {
      kind: "done",
      imported: countsOf(body.imported),
      skippedRules: typeof body.skippedRules === "number" ? body.skippedRules : 0,
    };
  } catch {
    return { kind: "done", imported: null, skippedRules: 0 };
  }
}
