/**
 * The mailbox providers the app offers to connect — RE-EXPORTED from the client engine. The table moved to
 * `packages/client-engine/src/providers.ts` when the phone's standalone door became the fourth surface that needs it:
 * the React Native bundler cannot import the shared shell (it is not a package), and a vendor name must never appear
 * in the phone app's own sources.
 */

/**
 * The engine is the one module every client already depends on. This file stays so that nothing had to move: the
 * shell, the Mailboxes pane, the join screen, the desktop's local door and four test files import the table from
 * here, by this path.
 */
export {
  PROVIDERS,
  hostsFor,
  portMeansImplicitTls,
  presetForAddress,
  providerById,
  providerLabel,
  serverGuessFor,
  type ProviderPreset,
  type ServerGuess,
} from "@ohmail/client-engine";
