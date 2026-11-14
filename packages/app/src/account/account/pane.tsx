/**
 * SETTINGS › ACCOUNT, REGISTERED: the section over what a host alone can hand it, its doors. It is the way out: who
 * is signed in, the password, sign this browser out, and the way to the page that deletes the account. A host can
 * also offer the sign-out alone or hand account management to the browser.
 *
 * THE PATTERN OF A PANE OVER A HOST'S OWN PARTS (the first of its kind; a pane's mount copies it):
 * 1. The pane's folder types what only a host can hand it (`<Pane>PaneParts`): each member a hook that answers a
 *    door, a slot the host fills, or `none`. A hook, because a door is made under the host's own providers (its
 *    reader's language, its way back to a live session) and must be the same door at every draw.
 * 2. `<pane>Pane(parts)` is its registration (`paneOf(id, …)`), made once per mount by the mail's panes record
 *    (`mail/panes.ts`), never by a host and never in a render.
 * 3. Which body is drawn is the host's ANSWER (`accountBodies(host)`), never the build or the surface; the section
 *    is listed only where that answer has a body these parts can draw.
 * 4. The body calls the part's hook once and the pane's own model hook over it. Nothing of a shell is read.
 */
import type { ReactNode } from "react";
import { useFrame } from "../../frame/index.js";
import { NONE, type HostCapabilities, type HostContract, type None } from "../../host/index.js";
import type { PaneSheet, SettingsPane } from "../../settings/contract.js";
import { PANE_FACTS, paneOf } from "../../settings/facts.js";
import { accountBodies } from "../bodies.js";
import type { FactorSlot } from "../contract.js";
import { useWayOut, WayOutPane, type WayOutDoor } from "../way-out/index.js";
import { AccountPane } from "./AccountPane.js";
import type { AccountDoor } from "./model.js";
import type { PasswordDoor } from "./password.js";
import { useAccount } from "./use-account.js";
import { usePassword } from "./use-password.js";

interface SessionParts {
  /** The session's door on this host: who is signed in, sign-out, the ways out of the page. The same door at every draw. */
  readonly useDoor: () => AccountDoor;
  /**
   * The password form's door and the factor's dialog, where the host shows the whole pane. `none`: this host changes
   * no password here, and only the sign-out alone can be drawn.
   */
  readonly password: { readonly useDoor: () => PasswordDoor; readonly factor: FactorSlot } | None;
}

type BrowserParts = { readonly useBrowserDoor: () => WayOutDoor };

/** The session controls or the browser action this host supplies to the Account section. */
export type AccountPaneParts = SessionParts | BrowserParts;

type Whole = SessionParts & { readonly password: Exclude<SessionParts["password"], None> };

/** The body these parts can draw for this host's answer, or null: the section is then not listed. */
function paneBodyOf(host: HostContract, parts: AccountPaneParts): "pane" | "signOutOnly" | "card" | null {
  const asked = accountBodies(host).account;
  if ("useBrowserDoor" in parts) return asked === "card" ? asked : null;
  if (asked === "signOutOnly") return asked;
  return asked === "pane" && parts.password !== NONE ? asked : null;
}

function WholePane({
  parts,
  service,
  sheet,
}: {
  readonly parts: Whole;
  readonly service: HostCapabilities["service"];
  readonly sheet?: PaneSheet;
}): ReactNode {
  const model = useAccount(parts.useDoor(), "pane");
  const password = usePassword(parts.password.useDoor());
  return (
    <AccountPane
      body="pane"
      sheet={sheet}
      service={service}
      model={model}
      password={password}
      factor={parts.password.factor}
    />
  );
}

function SignOutOnly({ parts }: { readonly parts: SessionParts }): ReactNode {
  return <AccountPane body="signOutOnly" model={useAccount(parts.useDoor(), "signOutOnly")} />;
}

function InBrowser({ parts }: { readonly parts: BrowserParts }): ReactNode {
  return <WayOutPane model={useWayOut(parts.useBrowserDoor(), "account")} />;
}

/** The Account section over one host's doors. Call it once per mount: a registration made again is a pane mounted again. */
export function accountPane(parts: AccountPaneParts): SettingsPane {
  function Body({ sheet }: { readonly sheet?: PaneSheet } = {}): ReactNode {
    const { host } = useFrame();
    const body = paneBodyOf(host, parts);
    if (body === "pane" && "password" in parts && parts.password !== NONE) {
      return <WholePane parts={parts as Whole} service={host.capabilities.service} sheet={sheet} />;
    }
    const content =
      "useBrowserDoor" in parts && body === "card" ? (
        <InBrowser parts={parts} />
      ) : "useDoor" in parts && body === "signOutOnly" ? (
        <SignOutOnly parts={parts} />
      ) : null;
    return sheet ? sheet(content) : content;
  }
  return {
    ...paneOf("account", { Body }),
    hasFoot: true,
    listed: (host) => PANE_FACTS.account.listed(host) && paneBodyOf(host, parts) !== null,
  };
}
