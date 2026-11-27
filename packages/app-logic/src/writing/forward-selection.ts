import type { ComposeAttachment, DraftForwardSource, EngineMessage } from "@ohmail/wire";
import { forwardSubject, MutationRejectedError, threadOf, type EntityReader } from "@ohmail/client-engine";
import { FORWARD_MAX_RAW_BYTES, SEND_MAX_ATTACHMENT_PARTS } from "@trafficflow/core/attachment-limits";
import { sha256Hex } from "@trafficflow/core/diagnostics";
import { readAsBase64 } from "../write/file-rules.js";

function messageTime(message: EngineMessage): number {
  for (const date of [message.date, message.sortAt, message.arrivedAt]) {
    const time = Date.parse(date ?? "");
    if (Number.isFinite(time)) return time;
  }
  return 0;
}

export function selectedMessages(
  read: EntityReader,
  picked: readonly EngineMessage[],
  conversations: readonly string[],
): EngineMessage[] {
  const byId = new Map(picked.map((message) => [message.id, message]));
  for (const id of conversations) {
    for (const member of threadOf(read, id)) byId.set(member.id, member);
  }
  return [...byId.values()].sort((a, b) => messageTime(a) - messageTime(b) || a.id.localeCompare(b.id));
}

export function selectionSubject(messages: readonly EngineMessage[], countLabel: () => string): string {
  const first = messages[0]?.subject ?? "";
  return forwardSubject(messages.every(({ subject }) => subject === first) ? first : countLabel());
}

/** A draft keeps the reference and its label. The original bytes are read from the account. */
export type ForwardSource = Omit<DraftForwardSource, "sha256"> & { sha256?: string };

const sourcesOfFiles = new WeakMap<ComposeAttachment, DraftForwardSource>();

export function forwardSourceOf(file: ComposeAttachment): DraftForwardSource | undefined {
  return sourcesOfFiles.get(file);
}

export function sourcesFromDraft(input: unknown): ForwardSource[] | undefined {
  if (!Array.isArray(input) || input.length > SEND_MAX_ATTACHMENT_PARTS) return;
  if (
    !input.every(
      (source: Partial<ForwardSource> | null) =>
        typeof source?.id === "string" &&
        typeof source.filename === "string" &&
        typeof source.sender === "string" &&
        typeof source.subject === "string",
    )
  )
    return;
  return input.map(({ id, filename, sender, subject, sha256 }) => ({
    id,
    filename,
    sender,
    subject,
    ...(typeof sha256 === "string" && /^[0-9a-f]{64}$/.test(sha256) ? { sha256 } : {}),
  }));
}

export function forwardSourcesForSave(
  sources: ForwardSource[] | undefined,
): DraftForwardSource[] | undefined {
  return sources?.every((source): source is DraftForwardSource => source.sha256 !== undefined)
    ? sources
    : undefined;
}

/** Keep original attachments in the draft's order, including when some were already in memory. */
export function withForwardFiles(sources: readonly ForwardSource[], files: readonly ComposeAttachment[]) {
  const byId = new Map<string, ComposeAttachment>();
  const ordinary: ComposeAttachment[] = [];
  for (const file of files) {
    const source = forwardSourceOf(file);
    if (source) byId.set(source.id, file);
    else ordinary.push(file);
  }
  const attachments: ComposeAttachment[] = [];
  const forwardSources = sources.map((source) => {
    const file = byId.get(source.id);
    if (!file) return source;
    const loaded = forwardSourceOf(file)!;
    if (source.sha256 !== undefined && source.sha256 !== loaded.sha256) return source;
    attachments.push(file);
    return loaded;
  });
  return { forwardSources, attachments: [...attachments, ...ordinary] };
}

async function originalDigest(blob: Blob, base64: string): Promise<string> {
  const bytes =
    typeof blob.arrayBuffer === "function"
      ? new Uint8Array(await blob.arrayBuffer())
      : Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  if (!globalThis.crypto?.subtle) return sha256Hex(bytes);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function forwardSourcesOf(
  messages: readonly EngineMessage[],
  noSubject: () => string,
): ForwardSource[] {
  return messages.map((message) => {
    const sender = (message.from.name || message.from.address).slice(0, 255);
    const subject = (message.subject || noSubject()).slice(0, 255);
    const filename =
      `${sender} — ${subject}`.replace(/[\u0000-\u001f\u007f/\\]/g, " ").slice(0, 251) + ".eml";
    return { id: message.id, filename, sender, subject };
  });
}

export async function loadForwardSources(
  sources: readonly ForwardSource[],
  cap: number,
  fetchSource: (id: string, maxBytes: number) => Promise<Blob>,
  stillHere: () => boolean,
): Promise<ComposeAttachment[] | null> {
  const attachments: ComposeAttachment[] = [];
  let remaining = cap;
  for (const source of sources) {
    if (remaining <= 0) throw new MutationRejectedError("Attachment limit reached", { status: 413 });
    const blob = await fetchSource(source.id, Math.min(remaining, FORWARD_MAX_RAW_BYTES));
    if (!stillHere()) return null;
    if (blob.size > remaining) throw new MutationRejectedError("Attachment limit reached", { status: 413 });
    remaining -= blob.size;
    const file = {
      filename: source.filename,
      contentType: "message/rfc822",
      contentBase64: await readAsBase64(blob),
    };
    const sha256 = await originalDigest(blob, file.contentBase64);
    if (source.sha256 !== undefined && source.sha256 !== sha256) throw new Error("Original message changed");
    sourcesOfFiles.set(file, { ...source, sha256 });
    attachments.push(file);
    if (!stillHere()) return null;
  }
  return attachments;
}
