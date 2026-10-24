/**
 * THE DIAGNOSTICS BLOCK OF A MAIL TO SUPPORT — Settings › Help & contact on the web, the desktop
 * and the phone. The person writes the mail from their own mailbox and sees the block in it, so
 * nothing is sent on its own. The facts go through the diagnostic file's own builder: the same
 * version and commit checks, the same closed OS and mailbox error sets. The block holds the app
 * version and build, the platform, an opaque account id, each mailbox's provider class and its
 * last sync error class; never an address, a host, a folder name or any mail content.
 */

import { buildDiagnosticBundle, type DiagnosticMailboxInput, type MailboxSection } from "./bundle.js";
import type { DiagnosticMailboxErrorCode, DiagnosticOs } from "./vocab.js";

export const SUPPORT_ADDRESS = "support@ohmail.app";
export const SUPPORT_SURFACES = ["web", "desktop", "phone"] as const;
export type SupportSurface = (typeof SUPPORT_SURFACES)[number];
/** The provider classes a block may name. `imap` is every mailbox not recognised as one of the others. */
export const SUPPORT_PROVIDERS = ["microsoft_oauth", "microsoft", "gmail", "icloud", "imap"] as const;
export type SupportProvider = (typeof SUPPORT_PROVIDERS)[number];
/** The most mailboxes one block lists. */
export const SUPPORT_MAILBOXES_MAX = 5;

/** A mailbox row: the diagnostic file's input, plus the two fields the provider class is read from. */
export interface SupportMailboxInput extends DiagnosticMailboxInput {
  readonly address?: unknown;
  readonly authKind?: unknown;
}

export interface SupportFactsInput {
  surface: SupportSurface;
  build: { version?: string | null; commit?: string | null };
  platform: { os?: string | null; osVersion?: string | number | null };
  /** The ohmail account id, where this surface has one. Anything not id-shaped is dropped. */
  account?: unknown;
  mailboxes?: readonly SupportMailboxInput[];
}

export interface SupportFacts {
  surface: SupportSurface;
  version: string | null;
  commit: string | null;
  os: DiagnosticOs | null;
  osVersion: string | null;
  account: string | null;
  mailboxes: { provider: SupportProvider; lastSyncError: DiagnosticMailboxErrorCode | null }[];
}

/** The words the block is written in; the surface supplies them in the app's language. */
export interface SupportWords {
  title: string;
  app: string;
  build: string;
  platform: string;
  account: string;
  mailbox: string;
  lastSync: string;
  none: string;
}

const ACCOUNT_RE = /^[A-Za-z0-9_-]{6,64}$/;
const DOMAIN_CLASSES: Array<[RegExp, SupportProvider]> = [
  [/^(?:gmail|googlemail)\.com$/, "gmail"],
  [/^(?:icloud|me|mac)\.com$/, "icloud"],
  [/^(?:outlook|hotmail|live|msn)\.[a-z.]+$/, "microsoft"],
];

/** Read from the sign-in kind and the address's domain; the address itself goes nowhere. */
function providerOf(m: SupportMailboxInput): SupportProvider {
  if (m.authKind === "oauth") return "microsoft_oauth";
  const at = typeof m.address === "string" ? m.address.lastIndexOf("@") : -1;
  const domain = at >= 0 ? (m.address as string).slice(at + 1).trim().toLowerCase() : "";
  return DOMAIN_CLASSES.find(([re]) => re.test(domain))?.[1] ?? "imap";
}

/** The facts, narrowed by the diagnostic file's builder. Pure. */
export function supportFacts(input: SupportFactsInput): SupportFacts {
  const mailboxes = (input.mailboxes ?? []).slice(0, SUPPORT_MAILBOXES_MAX);
  // The builder's install id keys hashes this block never writes; any valid one will do.
  const bundle = buildDiagnosticBundle({
    surface: input.surface === "phone" ? "phone" : "desktop",
    now: new Date(0),
    build: input.build,
    platform: { os: input.platform.os ?? null, arch: null, osVersion: input.platform.osVersion ?? null },
    install: { id: "0".repeat(32), mintedAt: new Date(0).toISOString() },
    mailboxes,
  });
  let version: string | null = null;
  let commit: string | null = null;
  let os: DiagnosticOs | null = null;
  let osVersion: string | null = null;
  const sections: MailboxSection[] = [];
  for (const s of bundle.sections) {
    if (s.k === "build") ({ version, commit } = s);
    else if (s.k === "platform") ({ os, osVersion } = s);
    else if (s.k === "mailbox") sections.push(s);
  }
  return {
    surface: input.surface,
    version,
    commit: commit === "dev" ? null : commit,
    os,
    osVersion,
    account: typeof input.account === "string" && ACCOUNT_RE.test(input.account) ? input.account : null,
    mailboxes: mailboxes.map((m, i) => ({ provider: providerOf(m), lastSyncError: sections[i]?.errorCode ?? null })),
  };
}

/** The block as text, one fact a line, headed by `words.title`. */
export function supportBlock(f: SupportFacts, words: SupportWords): string {
  const build = f.commit !== null ? ` · ${words.build} ${f.commit.slice(0, 9)}` : "";
  const platform = f.os === null ? words.none : f.osVersion !== null ? `${f.os} ${f.osVersion}` : f.os;
  const mailboxes = f.mailboxes.length === 0
    ? [`${words.mailbox}: ${words.none}`]
    : f.mailboxes.map((m) => `${words.mailbox}: ${m.provider} · ${words.lastSync}: ${m.lastSyncError ?? words.none}`);
  return [
    `— ${words.title} (ohmail) —`,
    `${words.app}: ohmail ${f.surface} ${f.version ?? words.none}${build}`,
    `${words.platform}: ${platform}`,
    `${words.account}: ${f.account ?? words.none}`,
    ...mailboxes,
  ].join("\n");
}

/** A new mail's starting body: an empty line to write on, then the block. */
export function supportBody(block: string): string {
  return `\n\n${block}`;
}

/** `text` without the block and the blank lines around it, or `null` when the block is not in it whole. */
export function withoutSupportBlock(text: string, block: string): string | null {
  const at = text.lastIndexOf(block);
  if (block === "" || at < 0) return null;
  const before = text.slice(0, at).replace(/\n+$/, "");
  const after = text.slice(at + block.length).replace(/^\n+/, "");
  return [before, after].filter((part) => part !== "").join("\n\n");
}

/** `text` with the block put back at the end. */
export function withSupportBlock(text: string, block: string): string {
  return text.trim() === "" ? supportBody(block) : `${text.replace(/\n+$/, "")}\n\n${block}`;
}

/** The `mailto:` for a surface that cannot open its own composer: the same subject and body. */
export function supportMailto(subject: string, body: string): string {
  const enc = (s: string): string => encodeURIComponent(s.replace(/\r?\n/g, "\r\n"));
  return `mailto:${SUPPORT_ADDRESS}?subject=${enc(subject)}&body=${enc(body)}`;
}
