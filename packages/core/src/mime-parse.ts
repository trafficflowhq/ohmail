import { MailParser, type ParsedMail } from "mailparser";

/**
 * How long a parse may go WITHOUT PROGRESS before it is refused: the splitter reading a line or the
 * parser finishing a chunk is progress. It counts looks the loop actually took, so a loaded machine
 * (a loop held elsewhere fires one late look) never refuses a busy parse, only one that STOPPED.
 * A synchronous computation is one look too, which is `MAX_HTML_TO_TEXT_CHARS`'s job.
 */
export const MIME_PARSE_DEADLINE_MS = 30_000;

/** Wall time for the whole operation, both parses included, so a parse always settles. */
export const MIME_PARSE_CEILING_MS = 10 * 60_000;

const LOOKS = 30;

/** The budget ran out before the parse settled. `MimeParseError` reads it as `parse_timeout`. */
export class ParseDeadlineExceeded extends Error {
  readonly name = "ParseDeadlineExceeded";
  constructor(readonly ms: number) {
    super(`the parse did not settle within its ${ms} ms bound`);
  }
}

/**
 * One budget for a whole operation, shared by every parse inside it: a budget per parse would let
 * the fallback re-parse start a second ceiling. Each parse subscribes while it runs; on expiry
 * every live subscriber is told once, with the bound that fired, and `clear` stops both timers.
 */
export interface ParseBudget {
  readonly ms: number;
  onExpire(fn: (ms: number) => void): () => void;
  progress(): void;
  clear(): void;
}

const unref = (t: unknown): void => { (t as { unref?: () => void }).unref?.(); };

// setTimeout and clearTimeout only: the phone's engine runs on Hermes (no `refresh()`, no clock reads).
export function startParseBudget(
  ms: number = MIME_PARSE_DEADLINE_MS,
  ceilingMs: number = MIME_PARSE_CEILING_MS,
): ParseBudget {
  const waiting = new Set<(ms: number) => void>();
  let expiredBy: number | null = null;
  let looks = 0;
  let lastProgress = 0;
  let look: ReturnType<typeof setTimeout> | undefined;
  let ceiling: ReturnType<typeof setTimeout> | undefined;
  const expire = (bound: number): void => {
    if (expiredBy !== null) return;
    expiredBy = bound;
    clearTimeout(look);
    clearTimeout(ceiling);
    for (const fn of [...waiting]) fn(bound);
    waiting.clear();
  };
  const next = (): void => {
    look = setTimeout(() => {
      looks++;
      if (looks - lastProgress >= LOOKS) expire(ms);
      else next();
    }, ms / LOOKS);
    unref(look);
  };
  next();
  ceiling = setTimeout(() => expire(ceilingMs), ceilingMs);
  unref(ceiling);
  return {
    ms,
    onExpire(fn) {
      if (expiredBy !== null) { fn(expiredBy); return () => {}; }
      waiting.add(fn);
      return () => { waiting.delete(fn); };
    },
    progress() { lastProgress = looks; },
    clear() { clearTimeout(look); clearTimeout(ceiling); waiting.clear(); },
  };
}

interface ParserInternals {
  readData(): unknown;
  processChunk(data: unknown, done: (err?: unknown) => void): unknown;
  hasFailed: boolean;
}
const baseReadData = (MailParser.prototype as unknown as ParserInternals).readData;
const GUARDED = Symbol("parse-guarded");
type Emitting = {
  emit: (...args: unknown[]) => unknown;
  pipe?: (dest: unknown, ...rest: unknown[]) => unknown;
  [GUARDED]?: true;
};

/**
 * mailparser runs its work in callbacks with no caller to land in: `readData` from the splitter's
 * `readable` event and from `setImmediate`, a text part's content-stream listeners, the charset and
 * flowed decoders piped from it, an attachment's stream. A throw in any of them escaped as an
 * uncaught exception, which exits the worker and the desktop engine. Each of those emitters is
 * guarded at its `emit` (decoders when created, pipe targets when piped), and every throw leaves by
 * {@link refuse}: the parser's own `error`, which the parse turns into a rejection.
 */
class SettlingMailParser extends MailParser {
  progress: () => void = () => {};

  constructor(options: BoundedParseOptions) {
    super(options);
    // The splitter reads lines for up to 16 KB of input per turn and emits nothing while it does.
    const splitter = (this as unknown as { splitter?: { processLine?: unknown } }).splitter;
    const processLine = splitter?.processLine;
    if (splitter && typeof processLine === "function") {
      splitter.processLine = (...args: unknown[]): unknown => {
        try { this.progress(); } catch { /* progress never fails a line */ }
        return processLine.apply(splitter, args);
      };
    }
  }

  // The one door: the first throw fails the parse, a later one finds it already failed.
  refuse(err: unknown): void {
    const self = this as unknown as ParserInternals;
    if (!self.hasFailed) {
      self.hasFailed = true;
      this.emit("error", err);
    }
  }

  guard(s: Emitting | null): void {
    if (!s || s[GUARDED]) return;
    s[GUARDED] = true;
    const { emit, pipe } = s;
    const parser = this;
    s.emit = function (...args: unknown[]): unknown {
      try {
        return emit.apply(this, args);
      } catch (err) {
        parser.refuse(err);
        return false;
      }
    };
    if (pipe) {
      s.pipe = function (dest: unknown, ...rest: unknown[]): unknown {
        parser.guard(dest as Emitting);
        return pipe.call(this, dest, ...rest);
      };
    }
  }

  readData(): unknown {
    try {
      return baseReadData.call(this);
    } catch (err) {
      this.refuse(err);
      return false;
    }
  }

  // Each part's decoder is guarded as it is made; the prototype is read per call so a seam on it holds.
  processChunk(data: unknown, done: (err?: unknown) => void): unknown {
    const node = data as { getDecoder?: () => Emitting } | null;
    const make = node?.getDecoder;
    if (make) node!.getDecoder = () => { const d = make.call(node); this.guard(d); return d; };
    // Progress on completion, not entry: a chunk that never completes is a stopped parse.
    const finished = (err?: unknown): void => { this.progress(); done(err); };
    return (MailParser.prototype as unknown as ParserInternals).processChunk.call(this, data, finished);
  }
}

/** The options this module's callers pass: cid links are always kept, so no image rewrite runs. */
export type BoundedParseOptions = {
  keepCidLinks: true;
  maxHtmlLengthToParse: number;
  skipHtmlToText?: boolean;
};

const HEADER_FIELDS = [
  "subject", "references", "date", "to", "from", "cc", "bcc", "message-id", "in-reply-to", "reply-to",
] as const;

/**
 * mailparser's `simpleParser`, over {@link SettlingMailParser}, settling exactly once: with the
 * mail, with the first error the parser or an attachment stream reports, or with
 * {@link ParseDeadlineExceeded} when the budget runs out. The parser is destroyed on every
 * refusal so nothing it scheduled can settle anything later.
 */
export function parseBounded(
  raw: Buffer | string,
  options: BoundedParseOptions,
  budget: ParseBudget,
): Promise<ParsedMail> {
  return new Promise<ParsedMail>((resolve, reject) => {
    const parser = new SettlingMailParser(options);
    parser.progress = () => budget.progress();
    const mail: Record<string, unknown> & { attachments: unknown[] } = { attachments: [] };
    let settled = false;
    let unsubscribe: () => void = () => {};
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      try { parser.destroy(); } catch { /* the refusal is already decided */ }
      reject(err);
    };
    unsubscribe = budget.onExpire((ms) => fail(new ParseDeadlineExceeded(ms)));
    if (settled) return;

    parser.on("error", fail);
    parser.on("headers", (headers) => {
      mail.headers = headers;
      mail.headerLines = (parser as unknown as { headerLines: unknown }).headerLines;
    });

    let reading = false;
    const reader = (): void => {
      reading = true;
      const data = parser.read() as null | (Record<string, unknown> & { type: string });
      if (data === null) { reading = false; return; }
      if (data.type === "text") {
        for (const key of ["text", "html", "textAsHtml"]) if (key in data) mail[key] = data[key];
        reader();
        return;
      }
      if (data.type === "attachment") {
        mail.attachments.push(data);
        const content = data.content as NodeJS.ReadableStream;
        parser.guard(content as unknown as Emitting);
        const chunks: Buffer[] = [];
        let length = 0;
        content.on("readable", () => {
          let chunk: Buffer | null;
          while ((chunk = content.read() as Buffer | null) !== null) { chunks.push(chunk); length += chunk.length; }
        });
        content.once("error", fail);
        content.on("end", () => {
          data.content = Buffer.concat(chunks, length);
          (data.release as () => void)();
          reader();
        });
        return;
      }
      reader();
    };
    parser.on("readable", () => { if (!reading) reader(); });

    parser.on("end", () => {
      if (settled) return;
      const headers = mail.headers as Map<string, unknown> | undefined;
      for (const key of HEADER_FIELDS) {
        if (headers?.has(key)) mail[key.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = headers.get(key);
      }
      settled = true;
      unsubscribe();
      resolve(mail as unknown as ParsedMail);
    });

    try {
      parser.end(typeof raw === "string" ? Buffer.from(raw) : raw);
    } catch (err) {
      // A synchronous throw from the first chunk is the same refusal, handed to the one settle.
      fail(err);
    }
  });
}
