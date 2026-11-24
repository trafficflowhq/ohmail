import { RENDER_ERROR_EVENT, RENDER_ERROR_SERVICE, SURFACES } from "../ui/error-boundary";

interface EventFields {
  readonly service: readonly string[];
  readonly numbers?: readonly string[];
  readonly flags?: readonly string[];
  readonly labels?: Readonly<Record<string, readonly string[]>>;
  readonly error?: boolean;
  readonly identifiers?: boolean;
}

const APP = ["app"];
const ENGINE = ["engine", "sidecar"];

const EVENTS: Readonly<Record<string, EventFields>> = {
  engine_vitals: {
    service: ENGINE,
    numbers: [
      "uptimeMs", "rss", "heapUsed", "heapTotal", "external", "arrayBuffers", "storeBytes",
      "loopDelayP99Ms", "loopDelayMaxMs", "loopUtilization", "storeFsyncs", "storeFsyncMs",
    ],
    labels: { memoryReading: ["process", "unavailable_in_this_runtime"] },
  },
  imap_connect_failed: { service: ENGINE, numbers: ["attempt", "durationMs"], error: true, identifiers: true },
  smtp_connect_failed: { service: ENGINE, numbers: ["attempt", "durationMs"], error: true, identifiers: true },
  sync_drain: { service: ENGINE, numbers: ["durationMs", "count"], error: true, identifiers: true },
  [RENDER_ERROR_EVENT]: {
    service: [RENDER_ERROR_SERVICE],
    labels: { surface: SURFACES },
    error: true,
  },
  attachment_refused: { service: APP },
  launch_replay: { service: APP, numbers: ["made", "refused", "expired", "said"] },
  send_withdraw_unsupported: { service: APP },
  network: { service: APP, labels: { state: ["online", "offline", "unknown"] } },
  backup_exclusion: {
    service: APP,
    flags: ["backup_excluded"],
    labels: { state: ["included", "excluded", "unknown"], platform: ["android", "ios"] },
  },
  posture_derived: { service: APP, numbers: ["width", "height", "folds"] },
  text_scale_refresh: { service: APP, numbers: ["surfaces", "fontScale"] },
  ui_vitals: {
    service: APP,
    numbers: [
      "derives", "deriveMsMax", "deriveMsP95", "notifies", "openP50Ms", "openP95Ms", "openCount",
      "openTimeouts", "switchP50Ms", "switchP95Ms", "switchCount", "switchTimeouts",
    ],
  },
};

const LEVELS = ["debug", "info", "warn", "error"];
const ERROR_CLASSES = ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AbortError"];
const ERROR_CATEGORIES: Readonly<Record<string, string>> = {
  ETIMEDOUT: "timeout",
  ECONNRESET: "connection",
  ECONNREFUSED: "connection",
  ENOTFOUND: "lookup",
  EAI_AGAIN: "lookup",
};

function category(value: unknown): string | undefined {
  return typeof value === "string" && Object.hasOwn(ERROR_CATEGORIES, value) ? ERROR_CATEGORIES[value] : undefined;
}

function member(values: readonly string[], value: unknown): string | undefined {
  return typeof value === "string" && values.includes(value) ? value : undefined;
}

function read(line: string): Record<string, unknown> | null {
  if (!line.trimStart().startsWith("{")) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Project the phone's ring before the shared builder hashes IDs and renders the file. */
export function phoneDiagnosticLines(lines: readonly string[]): readonly string[] {
  return lines.map((line) => {
    const raw = read(line);
    if (raw === null || typeof raw.event !== "string" || !Object.hasOwn(EVENTS, raw.event)) return "";
    const fields = EVENTS[raw.event]!;
    const service = member(fields.service, raw.service);
    if (service === undefined) return "";

    const result: Record<string, unknown> = { event: raw.event, service, ts: raw.ts, level: member(LEVELS, raw.level) };
    for (const field of fields.numbers ?? []) {
      const value = raw[field];
      if (typeof value === "number" && value >= 0 && value <= Number.MAX_SAFE_INTEGER) result[field] = value;
    }
    for (const field of fields.flags ?? []) {
      if (typeof raw[field] === "boolean") result[field] = raw[field];
    }
    for (const [field, values] of Object.entries(fields.labels ?? {})) {
      result[field] = member(values, raw[field]);
    }
    if (fields.error) {
      result.errorClass = member(ERROR_CLASSES, raw.errorClass);
      result.causeClass = member(ERROR_CLASSES, raw.causeClass);
      result.errorCode = category(raw.errorCode);
      result.causeCode = category(raw.causeCode);
    }
    if (fields.identifiers) {
      result.mailboxId = raw.mailboxId;
      result.accountId = raw.accountId;
    }
    return JSON.stringify(result);
  });
}
