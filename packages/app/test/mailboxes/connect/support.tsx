import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { reveal, Secret } from "@ohmail/app-logic/mailboxes/connect/secret";
import { NO_DETAILS } from "@ohmail/app-logic/mailboxes/connect/refusal";
import { mailboxIdOfAnswer } from "@ohmail/app-logic/mailboxes/connect/subject";
import type {
  Answered,
  CodeCeremony,
  Connected,
  ConnectProbed,
  MailboxId,
  Refusal,
  RefusalDetails,
  SignInReturn,
  SignInWays,
} from "@ohmail/app-logic/mailboxes/connect/types";
import { NONE, type ConnectWire, type None, type Signal } from "../../../src/host/index.js";
import { ConnectForm } from "../../../src/mailboxes/connect/index.js";
import type {
  ConnectAsk,
  ConnectResult,
  FactorAsk,
  FactorSlot,
} from "../../../src/mailboxes/connect/contract.js";
import { TextProvider } from "../../../src/text/index.js";
import account from "../../../messages/account.en.json" with { type: "json" };
import doors from "../../../messages/doors.en.json" with { type: "json" };
import mailboxes from "../../../messages/mailboxes.en.json" with { type: "json" };

/** The words the form reads, from the three places that hold them. */
export const WORDS = { ...account, ...doors, ...mailboxes };
export const M = mailboxes.mailboxes;
export const J = doors.join;
export const O = mailboxes.onboarding;
export const P = mailboxes.providerPicker;
export const D = account.devices;

/** The tile of the provider that signs in, by the name the provider table gives it. */
export const MICROSOFT = "Microsoft 365 & Outlook.com";

/** A value no sentence holds: finding it anywhere but the password field and a body's `pass` is a leak. */
export const MARKER = "zq-MARKER-pass-7Kd!\"<b>'";
export const id = (raw: string): MailboxId => mailboxIdOfAnswer(raw)!;

export const refusal = (
  code: string | null,
  details: Partial<RefusalDetails> = {},
  status = 422,
  message = "The server's own sentence.",
): Refusal => ({
  status,
  code,
  message,
  details: { ...NO_DETAILS, ...details },
});
export const no = (r: Refusal): Answered<never> => ({ ok: false, refusal: r });
export const WINDOW_CLOSED = no(refusal("step_up_required", {}, 403));
export const REFUSED_PASSWORD = no(refusal("mailbox_probe_failed", { reason: "auth", transport: "imap" }));
export const noEncryption = (leg: "imap" | "smtp") =>
  no(
    refusal("mailbox_probe_failed", {
      reason: "tls",
      transport: leg,
      tls: {
        kind: "tls_unavailable",
        plaintext: "offered",
        certHost: null,
        expectedHost: null,
        suggestedHost: null,
        trustVariable: null,
        certificate: null,
      },
    }),
  );
export const ownCertificate = (leg: "imap" | "smtp", sha256: string) =>
  no(
    refusal("mailbox_probe_failed", {
      reason: "tls",
      transport: leg,
      tls: {
        kind: "self_signed",
        certificate: sha256,
        plaintext: null,
        certHost: null,
        expectedHost: null,
        suggestedHost: null,
        trustVariable: null,
      },
    }),
  );

export function later<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function signal<T>(first: T): Signal<T> & { set(next: T): void; listeners(): number } {
  let value = first;
  const heard = new Set<() => void>();
  return {
    read: () => value,
    subscribe: (changed) => {
      heard.add(changed);
      return () => heard.delete(changed);
    },
    set: (next) => {
      value = next;
      for (const tell of [...heard]) tell();
    },
    listeners: () => heard.size,
  };
}

/** A body as the server would read it: every seal opened, as a wire's adapter opens it. */
function opened(value: unknown): unknown {
  if (value instanceof Secret) return reveal(value);
  if (Array.isArray(value)) return value.map(opened);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, opened(inner)]));
}

export interface Call {
  readonly verb: "probe" | "connect" | "edit" | "discover" | "ways" | "start" | "begin" | "stop";
  /** What was sent, seals opened. */
  readonly sent: unknown;
  /** The same with seals as they print, to read a body's keys in their order. */
  readonly sealed: string;
}

type Later<T> = T | Promise<T>;
export interface DoorScript {
  probe?: Later<Answered<ConnectProbed>>[];
  connect?: Later<Answered<Connected>>[];
  edit?: Later<Answered<null>>[];
  ways?: SignInWays | "none";
  start?: Later<Answered<"leaving" | "retired">>[];
  returned?: SignInReturn | null;
  code?: boolean;
  discover?: unknown | "none";
  localServerWait?: boolean;
}

/** A wire that answers as the case says and records every call. An unscripted call never answers. */
export function fakeDoor(script: DoorScript = {}) {
  const calls: Call[] = [];
  const note = (verb: Call["verb"], sent: unknown): void => {
    calls.push({ verb, sent: opened(sent), sealed: JSON.stringify(sent) });
  };
  const next = <T,>(queue: Later<T>[] | undefined): Promise<T> => {
    const answer = queue?.shift();
    return answer === undefined ? new Promise<T>(() => {}) : Promise.resolve(answer);
  };
  const returned = signal<SignInReturn | null>(script.returned ?? null);
  const live = signal<CodeCeremony | null>(null);
  const stillWanted: (() => boolean)[] = [];
  /* Read once: what the case scripted is one answer, the shell's own "no sign-in" or the ceremonies it runs. */
  const ways = script.ways ?? { microsoft: { redirect: false, device: false } };
  const signIn: ConnectWire["signIn"] =
    ways === "none"
      ? NONE
      : {
          ways: () => {
            note("ways", null);
            return Promise.resolve(ways);
          },
          start: (o) => {
            const { stillWanted: wanted, ...sent } = o;
            stillWanted.push(wanted);
            note("start", sent);
            return next(script.start);
          },
          returned,
          code: script.code
            ? {
                begin: (provider) => {
                  note("begin", provider);
                  return Promise.resolve({ ok: true, value: null });
                },
                live,
                stop: () => note("stop", null),
              }
            : NONE,
        };
  const door: ConnectWire = {
    probe: (input) => {
      note("probe", input);
      return next(script.probe);
    },
    connect: (input, mode) => {
      note("connect", { input, mode });
      return next(script.connect);
    },
    edit: (mailboxId, patch) => {
      note("edit", { mailboxId, patch });
      return next(script.edit);
    },
    discover:
      script.discover === "none"
        ? NONE
        : (domain) => {
            note("discover", domain);
            return Promise.resolve(script.discover ?? null);
          },
    signIn,
    localServerWait: script.localServerWait === true,
  };
  return {
    door,
    calls,
    returned,
    live,
    stillWanted,
    of: (verb: Call["verb"]) => calls.filter((call) => call.verb === verb),
  };
}

/** A stand-in for the second factor's dialog: its three answers as three buttons, and the line it was handed. */
export function factorButtons(seen: { asks: FactorAsk[] }): FactorSlot {
  return (ask) => {
    seen.asks.push(ask);
    return (
      <div role="dialog" aria-label="the second factor">
        <p>{ask.line}</p>
        <button type="button" onClick={ask.onVerified}>
          verify
        </button>
        <button type="button" onClick={ask.onCancel}>
          cancel
        </button>
        <button type="button" onClick={ask.onDiscarded}>
          discard
        </button>
      </div>
    );
  };
}

export interface Drawn extends RenderResult {
  readonly done: ConnectResult[];
  readonly asks: FactorAsk[];
  redraw(ask?: Partial<ConnectAsk>): void;
}

export function draw(
  door: ConnectWire,
  ask: Partial<ConnectAsk> & Pick<ConnectAsk, "purpose">,
  o: { factor?: FactorSlot | None | "buttons"; around?: (form: ReactNode) => ReactNode } = {},
): Drawn {
  const done: ConnectResult[] = [];
  const seen = { asks: [] as FactorAsk[] };
  const factor = o.factor === undefined || o.factor === "buttons" ? factorButtons(seen) : o.factor;
  const onDone = vi.fn((result: ConnectResult) => void done.push(result));
  const tree = (over: Partial<ConnectAsk> = {}): ReactNode => {
    const form = <ConnectForm ask={{ onDone, ...ask, ...over }} door={door} factor={factor} />;
    return (
      <TextProvider locale="en" messages={WORDS as never} timeZone="UTC">
        {o.around ? o.around(form) : form}
      </TextProvider>
    );
  };
  const view = render(tree());
  return { ...view, done, asks: seen.asks, redraw: (over) => view.rerender(tree(over)) };
}
