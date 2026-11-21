"use client";

/**
 * WHAT EVERY BROWSER HOST MOUNTS FOR MAIL, the same on the web, the desktop's window and the page it serves a phone:
 * the frame over what the mail entry hands (`useMailSupplies`: each seated place, the stages, Settings over the
 * registered sections and the mail ground above them), made from this browser's window and the look of the theme the
 * host stands under. A host names what only it can hand (`MailHostParts`) once, as a constant of its own module, and
 * builds its own answer to the host contract around the supplies; nothing of a shell's composition stands above the
 * frame.
 *
 * THE READER is the same on the three: the letter's own renderer over the ground's two doors. No look at a file's
 * bytes is handed: a press on a file saves it, until the reader's own part draws the look.
 */
import type { ReactNode } from "react";
import { ChunkLoadContext, Frame, lazyView } from "@ohmail/app/frame";
import { OhboxShapeContext } from "@ohmail/app/ohbox";
import { PdfLookContext } from "@ohmail/app/reader";
import { usePdfLook } from "@ohmail/app/host/browser";
import { type FrameSupplies, type HostContract, type HostSession } from "@ohmail/app/host";
import { browserClipboard, browserLinkOut } from "@ohmail/app/host/browser";
import {
  mailReader, NO_STAGE_PARTS, prepareWriting, useMailSupplies, useThemeLook, type MailHostParts, type MailPaneParts,
} from "@ohmail/app/mail";
import { mailboxesNotices } from "@ohmail/app/mailboxes";
import { letterBody } from "@ohmail/app/reader/body";
import { HelpContactPane, type HelpContactProps } from "@ohmail/app/settings/help";
import { BootSkeleton } from "./BootSkeleton";
import { TextFromIntl } from "./LocaleContext";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { navigatorOs } from "@ohmail/app-logic/writing/support";
import { ReaderInvitation } from "../components/ReaderInvitation";

export type { GapLettersWire, OrganizerNoticeWire } from "@ohmail/app/host";
export type { JunkWire } from "@ohmail/app-logic/screener/junk-window";
export type { AwayTransport } from "../api-client";

export { NO_STAGE_PARTS, type MailHostParts, type MailPaneParts } from "@ohmail/app/mail";

/** A browser host's reader over the mail ground: one for the page's life. */
export const BROWSER_READER = mailReader({
  body: letterBody, look: { usePdf: usePdfLook }, invitation: ReaderInvitation, copy: (text) => browserCopy(text),
});

/**
 * The parts of a browser host that hands the stages nothing of its own (the demo; the desktop's window and the page
 * it serves, until their own sections hand a pairing or a model form): its reader, and its doors of Settings'
 * sections. Call it once, at the host's module scope.
 */
export function browserMailParts(paneParts: MailPaneParts): MailHostParts {
  return { reader: BROWSER_READER, stageParts: NO_STAGE_PARTS, paneParts };
}

/**
 * WHAT A BROWSER HOST's MAILBOXES ENTRY SAYS in the frame's notice slot: the organizer's change and the gap's offer,
 * over the host's two wires and the ground's mail state. A host that lists the section hands it as the entry's
 * `notice`; one for the page's life.
 */
export const MAILBOXES_NOTICES = mailboxesNotices(useMailState);

/**
 * The way to an address the app itself makes (`device.openLink`): a new tab with no way back to this page. In the
 * desktop's window the same call is the new-window request its shell opens in the person's own browser, and only
 * inside the person's own press.
 */
export const browserOpenLink = (href: string): void => browserLinkOut(window)(href);

/** The clipboard (the reader's `copy`: a person's address from their card): `true` only once it took the text. */
export const browserCopy = (text: string): Promise<boolean> => browserClipboard(window)(text);

export type BrowserHelpContactProps = Omit<HelpContactProps, "os" | "copyText">;

export function BrowserHelpContactPane(props: BrowserHelpContactProps) {
  const os = navigatorOs(typeof navigator === "undefined" ? undefined : navigator);
  return <HelpContactPane {...props} os={os} copyText={(text) => navigator.clipboard ? browserCopy(text) : undefined} />;
}

/** What a browser host hands the frame for mail, over its own parts and its way back. Made where the frame mounts. */
export function useBrowserMail(recover: HostSession["recover"], own: MailHostParts): FrameSupplies {
  return useMailSupplies(window, useThemeLook(), recover, own);
}

const bootRows = <BootSkeleton active />;
const ReadyFrame = lazyView(async () => {
  await prepareWriting();
  return { default: Frame };
});

/** The frame over a browser host's contract. */
export function MailFrame({ host }: { host: HostContract }): ReactNode {
  return (
    <TextFromIntl>
      <PdfLookContext.Provider value={usePdfLook}>
        <OhboxShapeContext.Provider value={bootRows}>
          <BrowserChunkLoads><ReadyFrame host={host} /></BrowserChunkLoads>
        </OhboxShapeContext.Provider>
      </PdfLookContext.Provider>
    </TextFromIntl>
  );
}

export const page = { reload: (): void => { window.location.reload(); } };
const remedy = { replaced: buildReplaced, reload: () => page.reload() };

export function BrowserChunkLoads({ children }: { children: ReactNode }) {
  return <ChunkLoadContext.Provider value={remedy}>{children}</ChunkLoadContext.Provider>;
}


/**
 * AFTER A SERVER UPGRADE an open tab asks for its own build's chunks, and the new server answers 404:
 * the network is fine and Try again fetches the same missing file. A chunk is judged gone only when
 * the server says so (404/410 to a fresh HEAD); a probe that cannot reach it is the connection.
 */
async function buildReplaced(cause: unknown): Promise<boolean> {
  const url = chunkUrl(cause);
  if (url == null) return false;
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(5_000) });
    return res.status === 404 || res.status === 410;
  } catch {
    return false;
  }
}

/** The chunk a failed import names: webpack's `request`, or the URL in a browser's import error (or its cause's). */
function chunkUrl(cause: unknown, depth = 0): string | null {
  const c = cause as { request?: unknown; message?: unknown; cause?: unknown } | null | undefined;
  const raw = typeof c?.request === "string" ? c.request
    : typeof c?.message === "string" ? /(?:https?:\/\/|\/_next\/)[^\s)]+/.exec(c.message)?.[0] : undefined;
  return (raw ? ownOrigin(raw) : null) ?? (c?.cause != null && depth < 3 ? chunkUrl(c.cause, depth + 1) : null);
}

/** Where Next serves the build's chunks; next.config sets no basePath or assetPrefix. */
const CHUNK_PREFIX = "/_next/static/";

/** Only this app's own build chunks are asked about: never an /api path or any other URL an error names. */
function ownOrigin(raw: string): string | null {
  if (typeof location === "undefined") return null;
  try {
    const url = new URL(raw, location.href);
    return url.origin === location.origin && url.pathname.startsWith(CHUNK_PREFIX) ? url.href : null;
  } catch {
    return null;
  }
}
