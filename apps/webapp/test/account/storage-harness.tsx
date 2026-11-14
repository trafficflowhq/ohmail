import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { act } from "@testing-library/react";
import { fillOver, TextProvider, type Messages } from "@ohmail/app/text";
import en from "../../messages/en.json";
import de from "../../messages/de.json";
import ownEn from "../../../../packages/app/messages/account-storage.en.json";
import ownDe from "../../../../packages/app/messages/account-storage.de.json";

/**
 * WHAT SETTINGS › STORAGE'S CASES STAND ON over the web's real filling: a server that answers by route and records
 * every request as its method, its path and its body's keys (values are kept only for the case to read, never
 * compared), the tab's navigations caught before jsdom would follow them, and the two readers of words the shell
 * mounts. The API base is set here, before any case imports the client: a client imported without it has no server.
 */
process.env.NEXT_PUBLIC_API_BASE = "/api";

export interface Sent {
  /** `<METHOD> <path>`. */
  readonly line: string;
  /** The body's keys, sorted; none for a request without a body. */
  readonly keys: readonly string[];
  readonly body: unknown;
}
export interface Left {
  readonly href: string;
  readonly rel: string;
  readonly target: string;
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** The server's refusal envelope, its sentence a placeholder no case reads. */
export const refusal = (status: number, code: string): Response => json({ error: { code, message: "refused" } }, status);
/** The request never reached a server. */
export const OFFLINE = "offline";

/** The server the cases talk to: an answer queued per line is taken first; the access read answers `access`. */
export function serve(access: () => unknown) {
  const sent: Sent[] = [];
  const left: Left[] = [];
  const queued = new Map<string, (Response | typeof OFFLINE)[]>();
  const realFetch = globalThis.fetch;
  const realClick = HTMLAnchorElement.prototype.click;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const line = `${(init?.method ?? "GET").toUpperCase()} ${new URL(String(url), "http://localhost").pathname}`;
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const keys = body !== null && typeof body === "object" ? Object.keys(body).sort() : [];
    sent.push({ line, keys, body });
    const answer = queued.get(line)?.shift();
    if (answer === OFFLINE) throw new TypeError("Failed to fetch");
    if (answer !== undefined) return answer;
    if (line === "GET /api/account/access") return json(access());
    return json({});
  }) as typeof fetch;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    left.push({ href: this.href, rel: this.rel, target: this.target });
  };
  return {
    sent,
    left,
    /** Answers for one line, taken in turn before its default. */
    answer(line: string, ...answers: (Response | typeof OFFLINE)[]) {
      queued.set(line, [...(queued.get(line) ?? []), ...answers]);
    },
    /** What was sent on one line. */
    on: (line: string) => sent.filter((s) => s.line === line),
    /** Forget what was sent so far: what follows is the visit. */
    forget() {
      sent.length = 0;
    },
    restore() {
      globalThis.fetch = realFetch;
      HTMLAnchorElement.prototype.click = realClick;
    },
  };
}
export type Server = ReturnType<typeof serve>;

/** The pane's catalogue: the shell's, with this pane's own place file beside it until the catalogue holds it. */
const TEXT: Readonly<Record<"en" | "de", Messages>> = {
  en: { ...en, ...ownEn } as Messages,
  de: fillOver({ ...en, ...ownEn } as Messages, { ...de, ...ownDe } as Messages),
};

/** The two readers of words the shell mounts: the framework's, which the filling and the old pane read, and the app's. */
export function Words({ lang = "en", children }: { readonly lang?: "en" | "de"; readonly children: ReactNode }) {
  return (
    <NextIntlClientProvider locale={lang} messages={lang === "en" ? en : de} timeZone="UTC">
      <TextProvider locale={lang} messages={TEXT[lang]} timeZone="UTC">
        {children}
      </TextProvider>
    </NextIntlClientProvider>
  );
}

/** The access answer the shell would have read, published to the tab's feed before a pane is drawn. */
export async function published(): Promise<void> {
  const { account, forgetAccess } = await import("../../app/api-client");
  forgetAccess();
  await act(async () => {
    await account.access({ fresh: true });
  });
}

/** Every answer on its way taken in. */
export const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

export { en, de };
