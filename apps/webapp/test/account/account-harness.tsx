import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { act } from "@testing-library/react";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { fillOver, TextProvider, type Messages } from "@ohmail/app/text";
import { vi } from "vitest";
import en from "../../messages/en.json";
import de from "../../messages/de.json";
import accountEn from "../../../../packages/app/messages/account-account.en.json";
import accountDe from "../../../../packages/app/messages/account-account.de.json";
import securityEn from "../../../../packages/app/messages/account-security.en.json";
import securityDe from "../../../../packages/app/messages/account-security.de.json";

/**
 * WHAT THE CASES OF SETTINGS › SECURITY AND › ACCOUNT STAND ON over the web's real fillings: a server that answers
 * by route and records every request as its method, its path and its body's keys (a body's values are kept only
 * for the case that reads them, never compared between panes), the tab's full loads caught before jsdom would
 * follow them, every line written to the console, and the two readers of words the shell mounts. The API base is
 * set here, before any case imports the client: a client imported without it has no server.
 */
process.env.NEXT_PUBLIC_API_BASE = "/api";

export interface Sent {
  /** `<METHOD> <path>`. */
  readonly line: string;
  /** The request's whole address, as it left. */
  readonly url: string;
  /** The body's keys, sorted; none for a request without a body. */
  readonly keys: readonly string[];
  readonly body: unknown;
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** The server's refusal envelope, its sentence a placeholder no case reads. */
export const refusal = (status: number, code: string, details?: unknown): Response =>
  json({ error: { code, message: "refused", ...(details === undefined ? {} : { details }) } }, status);
/** The request never reached a server. */
export const OFFLINE = "offline";
type Answer = Response | typeof OFFLINE;

/** A full session's answer for one account. */
export const session = (over: Record<string, unknown> = {}) => ({
  scope: "full",
  user: {
    userId: "user-under-test",
    accountId: "account-under-test",
    email: "mila@lichtgrat.example",
    displayName: "Mila",
    emailVerified: true,
    twofaEnrolled: { webauthn: true, totp: false, recoveryCodes: true },
    ...over,
  },
});

/** The server the cases talk to: an answer queued for a line is taken first; then the line's standing answer. */
export function serve(standing: Readonly<Record<string, () => Response>> = {}) {
  const sent: Sent[] = [];
  const queued = new Map<string, Answer[]>();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const line = `${(init?.method ?? "GET").toUpperCase()} ${new URL(String(url), "http://localhost").pathname}`;
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const keys = body !== null && typeof body === "object" ? Object.keys(body).sort() : [];
    sent.push({ line, url: String(url), keys, body });
    const answer = queued.get(line)?.shift();
    if (answer === OFFLINE) throw new TypeError("Failed to fetch");
    if (answer !== undefined) return answer;
    return (standing[line] ?? (() => json({})))();
  }) as typeof fetch;
  return {
    sent,
    /** Answers for one line, taken in turn before its standing answer. */
    answer(line: string, ...answers: Answer[]) {
      queued.set(line, [...(queued.get(line) ?? []), ...answers]);
    },
    /** What was sent on one line. */
    on: (line: string) => sent.filter((s) => s.line === line),
    /** Each request as the visit compares it: its line and its body's keys, never a value. */
    asked: () => sent.map((s) => `${s.line} {${s.keys.join(",")}}`),
    /** Forget what was sent so far: what follows is the visit. */
    forget() {
      sent.length = 0;
    },
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}
export type Server = ReturnType<typeof serve>;

/** The tab's full loads, caught: where the page would have gone, by `assign` or `replace`. */
export function catchLoads() {
  const real = window.location;
  const loads: string[] = [];
  const load = (to: string): void => {
    loads.push(to);
  };
  // Everything else the page reads of its address is the real one's. The stand-in is its own object: the real
  // address's two loads cannot be replaced on it.
  const caught = new Proxy(
    {},
    {
      get(_, property) {
        if (property === "assign" || property === "replace") return load;
        const value: unknown = Reflect.get(real, property, real);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(real) : value;
      },
    },
  );
  Object.defineProperty(window, "location", { configurable: true, value: caught });
  return {
    loads,
    restore() {
      Object.defineProperty(window, "location", { configurable: true, value: real });
    },
  };
}

/** Every line the page writes to the console, kept as text. */
export function catchConsole() {
  const lines: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...parts: unknown[]) => {
      lines.push(parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "));
    }),
  );
  return {
    lines,
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

/**
 * Where a secret may never be: a console line, either storage, the tab's title, its address, any attribute of any
 * node, any request's address. Each place a secret is found in is named; an empty list is a clean page.
 */
export function foundIn(
  secrets: readonly string[],
  server: Server,
  consoleLines: readonly string[],
): readonly string[] {
  const stored = (storage: Storage): string =>
    Array.from({ length: storage.length }, (_, i) => {
      const key = storage.key(i) ?? "";
      return `${key}=${storage.getItem(key) ?? ""}`;
    }).join("\n");
  const attributes = [...document.querySelectorAll("*")]
    .flatMap((el) => el.getAttributeNames().map((name) => `${name}=${el.getAttribute(name) ?? ""}`))
    .join("\n");
  const places: Readonly<Record<string, string>> = {
    console: consoleLines.join("\n"),
    localStorage: stored(localStorage),
    sessionStorage: stored(sessionStorage),
    title: document.title,
    address: document.URL,
    cookie: document.cookie,
    attributes,
    requests: server.sent.map((s) => s.url).join("\n"),
  };
  return secrets.flatMap((secret) =>
    Object.entries(places)
      .filter(([, text]) => text.includes(secret))
      .map(([place]) => `${secret} in ${place}`),
  );
}

/** The panes' catalogue: the shell's, with these panes' own place files beside it until the catalogue holds them. */
const EN = { ...en, ...accountEn, ...securityEn } as Messages;
const TEXT: Readonly<Record<"en" | "de", Messages>> = {
  en: EN,
  de: fillOver(EN, { ...de, ...accountDe, ...securityDe } as Messages),
};

/** The readers of words the shell mounts: the framework's, which a filling and a shipped section read, and the app's. */
export function Words({ lang = "en", children }: { readonly lang?: "en" | "de"; readonly children: ReactNode }) {
  return (
    <NextIntlClientProvider locale={lang} messages={lang === "en" ? en : de} timeZone="UTC">
      <TextProvider locale={lang} messages={TEXT[lang]} timeZone="UTC">
        <ThemeProvider>
          <ToastHost>{children}</ToastHost>
        </ThemeProvider>
      </TextProvider>
    </NextIntlClientProvider>
  );
}

/** Every answer on its way taken in. */
export const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

export { en, de };
