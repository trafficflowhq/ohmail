/**
 * WHAT A LETTER'S BODY IS HANDED FOR ITS PICTURES, decided per letter with that letter's own id. The seam is the
 * shell's one picture door or `none`; `none`, and every unknown, mean blocked. The reader builds no seam, reads no
 * consent of its own, mints no address: it passes the shell's answers to the body.
 */
import { isHeldFolder } from "@trafficflow/core/destinations";

/** The shell's picture door, as the reader calls it (structurally the web shell's `RemoteImagesChrome`). */
export interface PictureSeam {
  /** The address of one remote picture of this letter: the id is the authorisation. */
  readonly proxyFor: (messageId: string) => (url: string) => string;
  readonly consented: (messageId: string) => boolean;
  readonly consent: (messageId: string) => void;
  /** The account loads pictures without being asked. */
  readonly auto: boolean;
  /** A tracking pixel may ride the proxy with the pictures. */
  readonly loadPixels: boolean;
  readonly resolvedFor: (messageId: string) => ReadonlyMap<string, string>;
  readonly needRemote: (messageId: string, urls: string[]) => void;
}

/** The embedded pictures' half of the file door. */
export interface EmbeddedPictureSeam {
  readonly cidImagesOf: (messageId: string) => ReadonlyMap<string, string>;
  readonly needCidImages: (messageId: string, contentIds: string[]) => void;
}

export interface LetterOfSeams {
  readonly id: string;
  readonly senderCheck?: unknown;
  readonly folder?: string;
  readonly physicalFolder?: string;
}

/**
 * DOES THIS LETTER LOAD ITS PICTURES ON OPEN: the account's `auto`, never for a sender whose name claims a company
 * the address does not belong to (an `unverified` line holds nothing back), never for a sender not let in, held
 * where the letter is shown or where it is filed. The one copy: today's reader reads this very function.
 */
export function autoLoadsImages(
  chrome: Pick<PictureSeam, "auto"> | undefined,
  m: { senderCheck?: unknown; folder?: string; physicalFolder?: string },
): boolean {
  if (isHeldFolder(m.folder) || isHeldFolder(m.physicalFolder)) return false;
  const reason = (m.senderCheck as { reason?: unknown } | null | undefined)?.reason;
  return (chrome?.auto ?? false) && (!m.senderCheck || reason === "unverified");
}

export interface LetterPictureInputs {
  readonly remoteLoaded: boolean;
  readonly imageProxy: ((url: string) => string) | null;
  readonly onLoadRemote?: () => void;
  readonly loadTrackingPixels: boolean;
  readonly resolvedRemoteImages?: ReadonlyMap<string, string>;
  readonly onRemoteImages?: (urls: string[]) => void;
  readonly cidImages?: ReadonlyMap<string, string>;
  readonly onCidImages?: (contentIds: string[]) => void;
}

/**
 * The picture inputs of ONE letter's body, as today's reader hands them. `reading` is false for a letter only
 * peeked at: it asks for no embedded picture (a mailbox connection each). `presented` is false where the letter was
 * not read off the presented mirror: the hold a list would show is unknown, so it loads nothing by itself.
 */
export function letterPictures(
  letter: LetterOfSeams,
  loadedRemoteContent: boolean,
  pictures: PictureSeam | "none",
  embedded: EmbeddedPictureSeam | "none",
  reading: boolean,
  presented: boolean,
): LetterPictureInputs {
  const id = letter.id;
  const cid =
    embedded === "none"
      ? {}
      : {
          cidImages: embedded.cidImagesOf(id),
          ...(reading
            ? { onCidImages: (contentIds: string[]) => embedded.needCidImages(id, contentIds) }
            : {}),
        };
  if (pictures === "none") {
    return { remoteLoaded: false, imageProxy: null, loadTrackingPixels: false, ...cid };
  }
  const auto = presented && autoLoadsImages(pictures, letter);
  return {
    remoteLoaded: loadedRemoteContent || auto || pictures.consented(id),
    imageProxy: pictures.proxyFor(id),
    ...(auto ? {} : { onLoadRemote: () => pictures.consent(id) }),
    loadTrackingPixels: pictures.loadPixels,
    resolvedRemoteImages: pictures.resolvedFor(id),
    onRemoteImages: (urls: string[]) => pictures.needRemote(id, urls),
    ...cid,
  };
}
