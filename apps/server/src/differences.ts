import { apiRoutes, type Route } from "@trafficflow/api";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import { OWED_COPY_CLOUD, OWED_COPY_SELF_HOST } from "@trafficflow/services";
import type { Settings } from "./settings.js";

/**
 * HOW THE MANAGED SERVICE DIFFERS FROM A SELF-HOSTED SERVER: the whole list.
 *
 * One program serves both (`program.ts`). Which of the two a configuration is, is decided once,
 * from the name that leads it (`managedBy` in `settings.ts`). Everything that follows from it is a
 * line here, and is read from here in both places that could ask: the settings take each block
 * that differs from its line (`loadSettings`), and the wiring is typed against {@link Wiring},
 * which has no `managed` member, and takes each choice from {@link Chosen}.
 * `test/differences.test.ts` holds that every line reads differently on the two and shows each
 * one through the loaded settings or the built program. What differs between a long-running
 * process and a function is not here: that is the door's own input (`DoorInput`).
 * `docs/one-server.md` says each in words.
 */
export const DIFFERENCES = [
  {
    id: "routes", plain: selfHostRoutes as Route[], managed: apiRoutes as Route[],
    says: "the route table: pairing and first-run setup, or the staff door, the funnel and the scheduled passes",
  },
  {
    id: "flavor", plain: "selfhost", managed: "managed",
    says: "what /hello says the service is",
  },
  {
    id: "origin", plain: "one-origin", managed: "listed-origins",
    says: "the browser origins: the operator's one origin, its host the passkey id and the only cookie host; or listed origins, with a passkey id and cookie hosts from a compiled list",
  },
  {
    id: "database", plain: "owned", managed: "pooled",
    says: "the database: one pool on the operator's own Postgres, which also holds the LISTEN; or the managed one through its pooler, with a session connection apart",
  },
  {
    id: "firstAccount", plain: "setup-token", managed: "none",
    says: "the first account: a setup token minted at start and whenever no account exists, or no such ceremony",
  },
  {
    id: "migrations", plain: "at-start", managed: "by-the-deploy",
    says: "who migrates the database: the server before it listens, or the deploy before the server starts",
  },
  {
    id: "requireVerified", plain: false, managed: true,
    says: "whether a costly route needs a verified address: a pairing invite verifies nobody by mail",
  },
  {
    id: "signup", plain: "pairing-invites", managed: "configured",
    says: "how later accounts arrive: pairing invites only, or invites and the configured open sign-up",
  },
  {
    id: "metering", plain: "never", managed: "entitlements",
    says: "limits and AI credits: the operator's own disk and keys, or the entitlements program where one is configured",
  },
  {
    id: "owedCopy", plain: OWED_COPY_SELF_HOST, managed: OWED_COPY_CLOUD,
    says: "an owed Sent copy: kept until filed with its files, or without them (attachment bytes are never written down)",
  },
  {
    id: "staffDoor", plain: "none", managed: "blind-role",
    says: "cross-account reads: the alert pass alone on the server's own handle, or the staff door on the content-blind role",
  },
  {
    id: "ai", plain: "operator", managed: "metered",
    says: "the model: the operator's provider and bill, or the shipped models inside the plan's credits",
  },
  {
    id: "privateDials", plain: "operator-switch", managed: "never",
    says: "dialling a private address (mail probe, wake endpoint): the operator's two switches, or never",
  },
  {
    id: "deviceCodeDoor", plain: true, managed: false,
    says: "Microsoft's device-code sign-in with a public client: mounted, or not",
  },
  {
    id: "events", plain: "always", managed: "behind-flag",
    says: "/events: always served, asking every 5 s; or served only where TF_SSE says so, asking every 8 s",
  },
  {
    id: "sendClock", plain: "own-chain", managed: "poked",
    says: "who keeps the sending and alert clocks: the server's own chain, or a scheduler that pokes the internal routes",
  },
  {
    id: "pager", plain: "optional", managed: "expected",
    says: "a missing pager on /health: unlisted where nobody armed one, or always listed, empty included",
  },
  {
    id: "funnel", plain: false, managed: true,
    says: "the waitlist, mailbox discovery by DNS, connect records and the lifecycle mails",
  },
  {
    id: "mailLinks", plain: "the-origin", managed: "configured",
    says: "where the links in a mail point: the one origin and nowhere else, or the configured app, site and console addresses",
  },
  {
    id: "keyRetirement", plain: "refused", managed: "read",
    says: "a key version marked retired: a refused start, or read and checked on /health against every stored secret",
  },
  {
    id: "buildIdentity", plain: "reported", managed: "required-in-production",
    says: "a build that cannot say which it is: named on /health when its label came from a variable, or failing /health in production without an identity of its own",
  },
  {
    id: "paymentVariables", plain: "not-read", managed: "refused",
    says: "a payment provider's variable in the environment: not looked at, or a refused start",
  },
] as const;

type Line = (typeof DIFFERENCES)[number];

/** What the marker chose: one member per line of {@link DIFFERENCES}. */
export type Chosen = { readonly [L in Line as L["id"]]: L["plain"] | L["managed"] };

/** The one place the marker is read: `loadSettings` and {@link wiringOf} both ask here. */
export function chosenFor(managed: boolean): Chosen {
  return Object.fromEntries(DIFFERENCES.map((line) => [line.id, managed ? line.managed : line.plain])) as Chosen;
}

/** The settings as the wiring sees them: every block, the choices, and no marker. */
export type Wiring = Omit<Settings, "managed"> & { readonly chosen: Chosen };

export function wiringOf(settings: Settings): Wiring {
  const { managed, ...rest } = settings;
  return { ...rest, chosen: chosenFor(managed) };
}
