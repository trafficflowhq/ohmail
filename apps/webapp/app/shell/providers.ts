/**
 * The mailbox providers the app offers to connect. The table is the client engine's; the connect form's rules read it
 * beside themselves, and this path stays for the shell, the Mailboxes pane, the
 * desktop's local door and their tests, which import it from here: the names it offered, and only those.
 */
export {
  AUTH_HINTS,
  PROTON,
  PROVIDERS,
  appPasswordPresetFor,
  asAuthHint,
  authHintPreset,
  authHintWantsLinks,
  discoveryRequestFor,
  hostsFor,
  isProtonAddress,
  passwordLabelKey,
  portMeansImplicitTls,
  presetForAddress,
  providerById,
  providerLabel,
  readDiscovery,
  serverGuessFor,
  type AuthHint,
  type DiscoveredServer,
  type Discovery,
  type ProviderPreset,
  type ServerGuess,
} from "@ohmail/app-logic/mailboxes/moved";
