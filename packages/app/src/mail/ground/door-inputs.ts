"use client";

/**
 * WHAT THE GROUND HANDS THE TWO DOORS OF A LETTER, read off the host, the consent row above and the frame. This is
 * the one place a host's answers become the doors' inputs, and nothing here can default:
 *
 * - THE PICTURE DOOR'S WIRE is the host's `wires.images` and no other. Where the host answers `none` the door is
 *   handed `none`: no door stands, so no address is minted for a picture, no press is recorded and nothing is
 *   fetched. The ground has no wire of its own to put in its place.
 * - WHETHER A LETTER LOADS ITS PICTURES BY ITSELF is the consent row's own two answers, of this frame's one row.
 *   The row rests at blocked, so before its live answer, over a host with no consent wire and after a failed read
 *   every picture waits for a person's press and no tracking pixel is fetched.
 * - THE FILE DOOR ASKS FOR NO LIST BY ITSELF. A pane that draws a letter holds that letter's list while it draws it
 *   (the reader's files do), and the last hold's release lets the list go: the addresses the engine minted for its
 *   bytes are revoked then. The shell that saves by id is the host's `device.saveFile`, `none` in a browser.
 *
 * What a door has to say goes to the frame's one report, in the catalogue's sentences.
 */
import type { EngineMessage } from "@ohmail/client-engine";
import { useConsent } from "@ohmail/app-logic/consent";
import { useEngine } from "@ohmail/app-logic/engine";
import { syncMayRead } from "@ohmail/app-logic/session/sync-scheduler";
import { useFrame, useReport } from "../../frame/index.js";
import type { HostDevice, HostWires } from "../../host/index.js";
import { useText } from "../../text/index.js";

export interface DoorInputs {
  readonly files: {
    /** No letter is the door's own ask: every list is a pane's hold. */
    readonly messageId: null;
    readonly options: {
      readonly conversationOf: (messageId: string) => EngineMessage[];
      readonly onDownloadAllFailed: () => void;
      readonly onSavedToDownloads: (count: number) => void;
      readonly onSaveRefused: (why: "no-downloads-folder" | "not-saved", count: number) => void;
      readonly shell: HostDevice["saveFile"];
    };
  };
  readonly pictures: {
    readonly wire: HostWires["images"];
    readonly mode: "auto" | "manual";
    readonly loadPixels: boolean;
    readonly mayRead: () => boolean;
    readonly onFailed: (sentence: string) => void;
  };
}

/** The door sweeps no conversation of its own: with no letter of its own to ask for, it is never called. */
const NO_SIBLINGS = (): EngineMessage[] => [];

export function useDoorInputs(): DoorInputs {
  const { host } = useFrame();
  const engine = useEngine();
  const row = useConsent();
  const report = useReport();
  const t = useText("ohbox");
  return {
    files: {
      messageId: null,
      options: {
        conversationOf: NO_SIBLINGS,
        onDownloadAllFailed: () => report(t("toastDownloadAllFailed")),
        onSavedToDownloads: (count) => report(t("toastSavedToDownloads", { count })),
        onSaveRefused: (why, count) =>
          report(
            why === "no-downloads-folder" ? t("toastSaveNoDownloads") : t("toastSaveRefused", { count }),
          ),
        shell: host.device.saveFile,
      },
    },
    pictures: {
      wire: host.wires.images,
      mode: row.blockRemoteImages ? "manual" : "auto",
      loadPixels: !row.blockTrackingPixels,
      /* The address of a picture is asked for by the renderer itself, past every other guard of the account's
         boundary: so it is minted only while this window may still read for the account its engine was opened for. */
      mayRead: () => syncMayRead(engine),
      onFailed: (sentence) => report(sentence),
    },
  };
}
