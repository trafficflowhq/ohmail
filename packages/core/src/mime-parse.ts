import { MailParser, type ParsedMail } from "mailparser";

/**
 * How long one `normalizeMime` call may take to settle, both parses included. Real mail parses
 * in milliseconds and the slowest html-to-text shape measured costs about 5.5 s, so 30 s never
 * fires on real mail. It bounds a parse that STOPPED, not one that is busy: a synchronous
 * computation holds the timer too, which is `MAX_HTML_TO_TEXT_CHARS`'s job.
 */
export const MIME_PARSE_DEADLINE_MS = 30_000;

/** The budget ran out before the parse settled. `MimeParseError` reads it as `parse_timeout`. */
export class ParseDeadlineExceeded extends Error {
  readonly name = "ParseDeadlineExceeded";
  constructor(readonly ms: number) {
    super(`the parse did not settle within ${ms} ms`);
  }
}

/**
 * One deadline for a whole operation, shared by every parse inside it: a clock per parse would
 * let the fallback re-parse start a second 30 s. Each parse subscribes while it runs; on expiry
 * every live subscriber is told once, and `clear` releases the timer on the way out.
 */
export interface ParseBudget {
  readonly ms: number;
  onExpire(fn: () => void): () => void;
  clear(): void;
}

export function startParseBudget(ms: number = MIME_PARSE_DEADLINE_MS): ParseBudget {
  const waiting = new Set<() => void>();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    for (const fn of [...waiting]) fn();
    waiting.clear();
  }, ms);
  (timer as { unref?: () => void }).unref?.();
  return {
    ms,
    onExpire(fn) {
      if (expired) { fn(); return () => {}; }
      waiting.add(fn);
      return () => { waiting.delete(fn); };
    },
    clear() { clearTimeout(timer); waiting.clear(); },
  };
}

interface ParserInternals {
  readData(): unknown;
  hasFailed: boolean;
}
const baseReadData = (MailParser.prototype as unknown as ParserInternals).readData;

/**
 * mailparser runs its header and body processing in `readData`, called from the splitter's
 * `readable` event and from `setImmediate` — so a throw there (measured: a TypeError in header
 * processing for any head longer than one chunk) has no caller to land in. It escaped as an
 * uncaught exception, which exits the worker and the desktop engine, and the parse never settled.
 * Here the throw becomes the parser's own `error`, which the parse below turns into a rejection.
 */
class SettlingMailParser extends MailParser {
  readData(): unknown {
    try {
      return baseReadData.call(this);
    } catch (err) {
      (this as unknown as ParserInternals).hasFailed = true;
      this.emit("error", err);
      return false;
    }
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
    unsubscribe = budget.onExpire(() => fail(new ParseDeadlineExceeded(budget.ms)));
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
