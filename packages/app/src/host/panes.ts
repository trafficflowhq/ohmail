import { NONE, type HostContract } from "./contract.js";

/** The Settings sections a host's answers can list or withhold. General, Notifications and Tags are always listed. */
export interface ListedPanes {
  readonly mailboxes: boolean;
  readonly screener: boolean;
  readonly ai: boolean;
  readonly away: boolean;
  readonly rules: boolean;
  readonly folders: boolean;
  readonly signatures: boolean;
  readonly desktop: boolean;
  readonly devices: boolean;
  readonly billing: boolean;
  readonly storage: boolean;
  readonly invites: boolean;
  readonly security: boolean;
  readonly account: boolean;
  readonly about: boolean;
  readonly help: boolean;
}

/**
 * Which Settings sections a host's answers allow, as far as the host decides it. What the
 * account's own state adds or takes away while the app runs is not the host's: Signatures needs
 * a mailbox, and a paired browser lists Mailboxes only while it has saved settings to show.
 */
export function panesOf(host: HostContract): ListedPanes {
  const { capabilities, features, wires } = host;
  const has = (feature: keyof typeof features) => features[feature] !== NONE;
  return {
    mailboxes: has("mailboxes"),
    // One Screener entry on every shell; the section goes only when every control's wire does.
    screener: has("screener")
      && (wires.screening !== NONE || wires.consent !== NONE || wires.autoFiled !== NONE || wires.ownModelAutoSuggest !== NONE),
    ai: has("ai"),
    away: wires.away !== NONE && capabilities.awayRunsOn !== NONE,
    rules: true,
    folders: wires.consent !== NONE && capabilities.foldersStorable,
    signatures: wires.consent !== NONE,
    desktop: has("desktop"),
    devices: has("devices"),
    billing: has("subscription"),
    storage: has("storage"),
    invites: has("invites"),
    security: has("security"),
    account: has("account"),
    about: has("about"),
    help: has("help"),
  };
}
