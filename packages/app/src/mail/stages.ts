/**
 * THE MAIL STAGES, ONE LIST FOR EVERY HOST: the registration of each body that stands over the whole app, by its id.
 * A shell that shows mail takes its stages from here, as it takes its places from `mailPlaces()`.
 *
 * A stage is not a place: it has no entry in the rail and no columns to stand above. The frame draws it over the app
 * while the address names it, under the ground, so its body reads the ground's readers like any pane. What a stage
 * reads of the ground is its own seat's to assemble (a hook its body calls once a render), and its seat is named
 * HERE, in the stage's one line, never by a host.
 *
 * WHAT A HOST ALONE CAN HAND A STAGE (`MailStageParts`) is the one thing that differs by host: the parts that are
 * another feature's or the host's own, each a function or `none`. A host names every one of them, once, in a record
 * it keeps for the life of its page; the stages are made from it once per mount.
 *
 * A stage adds ONE line to the record below: `<id>: <its registration, over the host's parts and its own seat>`.
 */
import type { FrameStages } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { firstRunStage, useFirstRunSeat, type FirstRunParts } from "../mailboxes/first-run/index.js";

/** What a host alone can hand the mail's stages, by stage. */
export interface MailStageParts {
  readonly firstRun: FirstRunParts;
}

/**
 * A host that can hand the stages nothing of its own (the demo; the paired page; the desktop until its own panes
 * hand its pairing and its model form): every part `none`, said once here, never a part left out by a host.
 */
export const NO_STAGE_PARTS: MailStageParts = {
  firstRun: { factor: NONE, pair: NONE, aiProvider: NONE, calendar: NONE },
};

/** The mail's stages over one host's parts. Call it once per mount: an entry made again is a body mounted again. */
export function mailStages(parts: MailStageParts): FrameStages {
  return {
    firstRun: firstRunStage({ ...parts.firstRun, ground: useFirstRunSeat }),
  };
}
