import type { None } from "./contract.js";

/**
 * Closed sets of answers, resolved by the shell from its build, the server's feature words and
 * its door. A view reads these and never asks which setting it is in.
 */
export interface HostCapabilities {
  /**
   * Whose service this is. Replaces `managedService`. Every shell is one of the three and says
   * which; nothing may default it.
   */
  readonly service: "managed" | "self" | "ownComputer";
  /** Whether prices may be shown: as numbers alone, or as a way out to where they are. */
  readonly prices: "data" | "linkOut" | None;
  /** How much one send may carry: the strict limit, the mailbox's own, or a number of bytes. Replaces `sendSurfaceMaxTotalBytes`. */
  readonly sendCeiling: "strict" | "mailbox" | number;
  /** Where away replies leave from. Replaces `awayIsLocal` and `awayOnHost`. */
  readonly awayRunsOn: "service" | "thisComputer" | { readonly host: string } | None;
  /** Whether a rule that came from a suggestion can be told apart here. Replaces `actRulesUnmarked`. */
  readonly rulesMarked: boolean;
  /** Whose machine fetches a letter's pictures. Replaces the first fact of `imagesFromComputer`. */
  readonly imagesFrom: "service" | "computer" | None;
  /** Whose engine sends the one-click unsubscribe a screen-out asks for. The second fact of `imagesFromComputer`. */
  readonly unsubscribeFrom: "service" | "computer" | None;
  /** Whether the choice to use folders can be stored here. */
  readonly foldersStorable: boolean;
  /**
   * Which suggest control the Screener draws, and whether anything is bought here that nobody pressed for.
   * `priced`: the shared control, and the batch an account opted into is bought when its Screener opens.
   * `pressed`: the shared control, and nothing is ever bought here without a press, whatever the account's row says.
   * `ownModel`: the host's own control over the person's own model. Replaces `screenerSuggest`.
   */
  readonly suggest: "priced" | "pressed" | "ownModel" | None;
  /** How another device is paired from here. */
  readonly pairing: "hostMode" | "account" | "inBrowser" | None;
  /** What the Account pane is: the whole pane, a way out to the browser, or sign-out alone. */
  readonly account: "here" | "inBrowser" | "signOutOnly" | None;
  /** Which first run this shell walks. */
  readonly firstRunDoor: "local" | "cloud" | "selfhost" | None;
  /** What the Mailboxes pane may change: everything, a re-sync and a way out, or a re-sync alone. */
  readonly mailboxes: "here" | "resyncAndOut" | "resyncOnly" | None;
  /** How far a choice of language reaches. */
  readonly language: "account" | "install" | None;
  /**
   * What the store's search takes here: `people` where the server said so in its hello (a person on either side,
   * unread, the days, a question with no words); `words` everywhere else, and on a host that holds no hello where it
   * builds this. A server that never said it ignores those filters, and its rows would stand under a person's name.
   */
  readonly searchBy: "people" | "words";
  /**
   * Whether this shell offers the calendar beside mail: the switch between the two is drawn exactly where this is
   * `both` and the calendar's entry is handed in. A shell answers it from its server's word at seating.
   */
  readonly products: "both" | None;
}

/**
 * What a shell that cannot do the thing answers, per capability. `service` is not here: no
 * shell "cannot", each is one of its three members.
 */
export const CANNOT = {
  prices: "none",
  sendCeiling: "strict",
  awayRunsOn: "none",
  rulesMarked: false,
  imagesFrom: "none",
  unsubscribeFrom: "none",
  foldersStorable: false,
  suggest: "none",
  pairing: "none",
  account: "none",
  firstRunDoor: "none",
  mailboxes: "none",
  language: "none",
  searchBy: "words",
  products: "none",
} as const satisfies Omit<HostCapabilities, "service">;
