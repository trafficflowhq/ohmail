import type { EventTime, ZoneSource } from "@ohmail/cal-core";
import type {
  CalendarRef,
  CalendarWriter,
  ChangeItem,
  Connection,
  EventDraft,
  WriteAnswer,
  WriteKey,
  WriteTarget,
} from "@ohmail/cal-providers";
import { alreadyHolds, portableCalendarText } from "@ohmail/cal-providers";
import type { CalendarTransfer, CalendarTransferProgress } from "@trafficflow/db/calendar";
import { draftOf } from "./write-request.js";

type Upsert = Extract<ChangeItem, { kind: "upsert" }>;
type Refusal = Extract<WriteAnswer, { ok: false }>;
export interface TransferCalendar {
  readonly writer: CalendarWriter;
  readonly connection: Connection;
  readonly cal: CalendarRef;
  readonly markDue?: () => Promise<void>;
}

interface TransferInput {
  readonly source: TransferCalendar;
  readonly destination: TransferCalendar | null;
  readonly final?: boolean;
  readonly transfer: CalendarTransfer;
  readonly originalVersion: string;
  readonly sourceWritable?: boolean;
  readonly key: WriteKey;
  readonly zones: ZoneSource;
  readonly signal: AbortSignal;
  readonly remember: (progress: CalendarTransferProgress) => Promise<boolean>;
}

export const retryTransfer = { pending: true } as const;
export type MoveRefusal = "move_copy_left" | "move_unresolved" | "move_destination_unavailable";
export const moveRefusal = (reason: MoveRefusal) => ({ moveRefusal: reason });
type TransferAnswer = WriteAnswer | typeof retryTransfer | ReturnType<typeof moveRefusal>;
const refused = (reason: Refusal["reason"]): Refusal => ({ ok: false, reason, retryAfterMs: null });
const retryable = new Set([
  "throttled",
  "unavailable",
  "timeout",
  "connection_failed",
  "host_unresolved",
  "unknown",
  "unreadable",
]);

function one(answer: WriteAnswer, id?: string) {
  if (!answer.ok || answer.items.length !== 1) return null;
  const item = answer.items[0]!;
  return item.kind !== "cancelled_occurrence" && (id === undefined || item.id === id) ? item : null;
}

function personal(item: Upsert) {
  const event = item.event;
  const organizer = event.organizer?.email;
  return (
    !item.audienceIncomplete &&
    (!event.organizer || !!organizer) &&
    event.attendees.every((attendee) => !!organizer && attendee.email === organizer)
  );
}

function clockOf(time: EventTime | null) {
  if (time?.kind !== "zoned") return time?.kind;
  return time.tzid === "UTC" || time.tzid === "Etc/UTC" ? "instant" : time.tzid;
}

function matches(item: Upsert, draft: EventDraft, zones: ZoneSource) {
  const event = item.event;
  return (
    personal(item) &&
    (item.text === null ? item.portableCopy === true : portableCalendarText(item.text)) &&
    !event.recurrenceId &&
    !event.duration &&
    !event.added.length &&
    !event.excluded.length &&
    !event.categories.length &&
    (!event.status || event.status === "CONFIRMED") &&
    event.classification !== "CONFIDENTIAL" &&
    clockOf(event.start) === clockOf(draft.start) &&
    clockOf(event.end) === clockOf(draft.end) &&
    alreadyHolds(draft, { ...event, attendees: [] }, zones)
  );
}

function target(item: Upsert): WriteTarget {
  const organizer = item.event.organizer?.email ?? null;
  return {
    id: item.id,
    version: item.version,
    text: item.text,
    occurrence: null,
    audience: { organizer, guests: [] },
    ...(item.event.rules.length > 0 && { recurringSeries: true }),
  };
}

function read(site: TransferCalendar, id: string, signal: AbortSignal) {
  return site.writer.readForMove!(site.connection, site.cal, id, signal);
}

function remove(site: TransferCalendar, item: Upsert, signal: AbortSignal) {
  return site.writer.remove(site.connection, site.cal, target(item), signal);
}

type Copy = Upsert | { readonly kind: "gone"; readonly id: string };
type KnownCopy = Extract<CalendarTransferProgress, { id: string }>;

const applied = (source: string): WriteAnswer => ({ ok: true, items: [{ kind: "gone", id: source }] });

/** Resolve a spent move with reads and conditional compensation alone. */
async function finish(
  input: TransferInput,
  destination: TransferCalendar,
  original: Copy | null,
  progress: CalendarTransferProgress,
) {
  const { signal, key } = input;
  const found =
    progress.phase === "creating"
      ? await destination.writer.findMoveCopy?.(destination.connection, destination.cal, key, signal)
      : await read(destination, progress.id, signal);
  const copy = found && one(found, progress.phase === "creating" ? undefined : progress.id);
  if (!copy) return moveRefusal("move_unresolved");
  if (copy.kind === "gone") return refused("version_stale");
  try {
    if (
      progress.phase === "creating" &&
      copy.version &&
      !(await input.remember({ phase: "verifying", id: copy.id, version: copy.version }))
    )
      return moveRefusal("move_unresolved");
    if (!original) return moveRefusal("move_unresolved");
    if (original.kind === "gone" && progress.phase === "removing") return applied(original.id);
    return await compensate(input, destination, original, copy, true);
  } finally {
    if (progress.phase === "creating") await wake(destination);
  }
}

async function compensate(
  input: TransferInput,
  destination: TransferCalendar,
  original: Copy,
  copy: Upsert,
  final: boolean,
): Promise<TransferAnswer> {
  const reason = original.kind === "upsert" ? "move_copy_left" : "move_unresolved";
  if (!personal(copy) || !copy.version) return final ? moveRefusal(reason) : retryTransfer;
  if (!(await input.remember({ phase: "rollback", id: copy.id, version: copy.version })))
    return final ? moveRefusal(reason) : retryTransfer;
  const removed = await remove(destination, copy, input.signal);
  if (removed.ok) return refused("version_stale");
  if (!final) return retryTransfer;
  const latest = one(await read(destination, copy.id, input.signal), copy.id);
  if (latest?.kind === "gone") return refused("version_stale");
  return moveRefusal(latest || !retryable.has(removed.reason) ? reason : "move_unresolved");
}

async function wake(destination: TransferCalendar | null) {
  try {
    await destination?.markDue?.();
  } catch {
    // A read of the destination is already scheduled by the sync loop.
  }
}

/** The durable copy, verification and compensation steps of the original move write. */
export async function transferPersonalEvent(input: TransferInput): Promise<TransferAnswer> {
  const { source, destination, transfer, originalVersion, key, zones, signal, remember, final } = input;
  let progress = transfer.progress;
  let sawCopy = progress !== undefined && progress.phase !== "creating";
  try {
    if (!source.writer.readForMove) return progress ? moveRefusal("move_unresolved") : refused("unsupported");
    if (!destination?.writer.readForMove) {
      if (!progress) return moveRefusal("move_destination_unavailable");
      const original = one(await read(source, transfer.source, signal), transfer.source);
      if (original?.kind === "upsert") return moveRefusal("move_destination_unavailable");
      return final ? moveRefusal("move_unresolved") : retryTransfer;
    }
    if (final && progress) {
      const original = one(await read(source, transfer.source, signal), transfer.source);
      return await finish(input, destination, original, progress);
    }
    if (final) return refused("version_stale");
    const draft = draftOf(transfer.fields, null);
    if (!draft) return progress ? moveRefusal("move_unresolved") : refused("unsupported");
    const fresh = !progress;
    if (!progress) {
      const checked = await read(source, transfer.source, signal);
      if (!checked.ok) return checked;
      const original = one(checked, transfer.source);
      if (
        original?.kind !== "upsert" ||
        original.version !== originalVersion ||
        !matches(original, draft, zones) ||
        input.sourceWritable === false
      )
        return refused("version_stale");
      progress = { phase: "creating" };
      if (!(await remember(progress))) return retryTransfer;
    }

    if (progress.phase === "creating") {
      // On recovery only, make sure the original still stands before retrying creation.
      if (!fresh) {
        const original = one(await read(source, transfer.source, signal), transfer.source);
        if (!original) return retryTransfer;
        if (
          original.kind === "gone" ||
          original.version !== originalVersion ||
          input.sourceWritable === false
        )
          return await finish(input, destination, original, progress);
      }
      const created = await destination.writer.create(
        destination.connection,
        destination.cal,
        { key, event: draft, recover: !fresh },
        signal,
      );
      if (!created.ok) {
        if (retryable.has(created.reason)) return retryTransfer;
        if (fresh) return created;
        const original = one(await read(source, transfer.source, signal), transfer.source);
        return original ? await finish(input, destination, original, progress) : retryTransfer;
      }
      const copy = one(created);
      if (copy?.kind !== "upsert" || !copy.version) return retryTransfer;
      sawCopy = true;
      progress = { phase: "verifying", id: copy.id, version: copy.version };
      if (!(await remember(progress))) return retryTransfer;
    }

    return await verify(input, destination, progress, draft);
  } finally {
    if (sawCopy) await wake(destination);
  }
}

async function verify(
  input: TransferInput,
  destination: TransferCalendar,
  progress: KnownCopy,
  draft: EventDraft,
): Promise<TransferAnswer> {
  const { source, transfer, originalVersion, zones, signal, remember } = input;
  const copy = one(await read(destination, progress.id, signal), progress.id);
  const original = one(await read(source, transfer.source, signal), transfer.source);
  if (!copy || !original) return retryTransfer;
  if (copy.kind === "gone") return refused("version_stale");
  if (original.kind === "gone" && progress.phase === "removing") return applied(original.id);
  if (
    original.kind === "upsert" &&
    progress.phase !== "rollback" &&
    input.sourceWritable !== false &&
    original.version === originalVersion &&
    matches(original, draft, zones) &&
    matches(copy, draft, zones)
  ) {
    if (
      (progress.phase !== "removing" || copy.version !== progress.version) &&
      !(await remember({ phase: "removing", id: copy.id, version: copy.version }))
    )
      return retryTransfer;
    const removed = await remove(source, original, signal);
    if (removed.ok) return applied(original.id);
    if (retryable.has(removed.reason)) return retryTransfer;
    const stillThere = one(await read(source, original.id, signal), original.id);
    if (!stillThere) return retryTransfer;
    if (stillThere.kind === "gone") return applied(stillThere.id);
    return compensate(input, destination, stillThere, copy, false);
  }
  return compensate(input, destination, original, copy, false);
}
