import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, Menu, MenuItem, RefusalLine } from "@ohmail/ui/base";
import { ActionPanel, SettingActs, SettingNote, type PanelVerb } from "@ohmail/ui/mail";
import type { CodeCeremony } from "@ohmail/app-logic/mailboxes/connect/types";
import { deviceSignInFailureKey } from "@ohmail/app-logic/mailboxes/connect/sign-in";
import { useWays } from "@ohmail/app-logic/mailboxes/connect/use-sign-in";
import { NONE, type None, type ProviderSignInWire } from "../../host/index.js";
import { useText } from "../../text/index.js";
import { DeviceSignIn } from "../connect/DeviceSignIn.js";

const nothing = { read: () => null, subscribe: () => () => undefined };

export function OutlookConnect({
  signIn,
  resting,
  deviceReady,
  add,
  again,
  connected,
}: {
  signIn: ProviderSignInWire | None;
  resting: boolean;
  deviceReady: boolean;
  add(): void;
  again?(): void;
  connected(result: Extract<CodeCeremony, { kind: "connected" }>): void;
}): ReactNode {
  const words = useText("mailboxes");
  const { microsoft } = useWays(signIn);
  const [offer, setOffer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const press = useRef<symbol | null>(null);
  useEffect(
    () => () => {
      press.current = null;
    },
    [signIn],
  );

  const code =
    resting && deviceReady && microsoft.device && signIn !== NONE && signIn.code !== NONE
      ? signIn.code
      : null;
  const watched = code?.live ?? nothing;
  const result = useSyncExternalStore(watched.subscribe, watched.read, nothing.read);
  useEffect(() => code?.resume?.(), [code]);
  useEffect(() => {
    if (result?.kind !== "connected" || code === null || code.live.read() !== result) return;
    code.stop();
    connected(result);
  }, [code, connected, result]);

  const reset = (): void => {
    press.current = null;
    setOffer(false);
    setBusy(false);
    setError(null);
  };

  const start = async (): Promise<void> => {
    if (signIn === NONE || press.current !== null) return;
    const mine = Symbol();
    press.current = mine;
    const stillWanted = () => press.current === mine;
    setBusy(true);
    setError(null);
    const answer = microsoft.redirect
      ? await signIn.start({ provider: "microsoft", purpose: "add", stillWanted })
      : await code?.begin("microsoft", stillWanted);
    if (!stillWanted() || (answer?.ok && answer.value === "leaving")) return;
    if (answer?.ok && answer.value === null) {
      reset();
      return;
    }
    press.current = null;
    setBusy(false);
    if (answer && !answer.ok) {
      setError(
        microsoft.redirect
          ? answer.refusal.message || words("oauth_consent_failed")
          : words(deviceSignInFailureKey(answer.refusal.code)),
      );
    }
  };

  if (code !== null && (result?.kind === "checking" || result?.kind === "shown")) {
    return <DeviceSignIn result={result} stop={code.stop} />;
  }

  const armed = resting && (microsoft.redirect || code !== null);
  return (
    <>
      {result?.kind === "ended" && !offer ? <DeviceSignIn result={result} stop={() => code?.stop()} /> : null}
      {offer && armed ? (
        <>
          <SettingNote>{words(microsoft.redirect ? "microsoftOauthNote" : "deviceOauthNote")}</SettingNote>
          {microsoft.redirect ? <SettingNote>{words("oauthOfferWhich")}</SettingNote> : null}
          {error === null ? null : <RefusalLine alert>{error}</RefusalLine>}
          <SettingActs>
            <Button disabled={busy} onPress={() => void start()}>
              {words("oauthContinue")}
            </Button>
            <Button kind="quiet" onPress={reset}>
              {words("cancel")}
            </Button>
          </SettingActs>
        </>
      ) : (
        <MailboxActions add={add} again={again} outlook={armed ? () => setOffer(true) : undefined} />
      )}
    </>
  );
}

function MailboxActions({
  add,
  again,
  outlook,
}: {
  readonly add: () => void;
  readonly again?: () => void;
  readonly outlook?: () => void;
}) {
  const words = useText("mailboxes");
  const [folded, setFolded] = useState<readonly string[]>([]);
  const [moreAt, setMoreAt] = useState<HTMLElement | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  anchor.current = moreAt;
  const verbs: PanelVerb[] = [
    { id: "add", label: words("connect"), icon: "plus", kind: "ink", rank: 0, onPress: add },
  ];
  if (again)
    verbs.push({
      id: "setup-again",
      label: words("setupAgain"),
      icon: "pull",
      kind: "soft",
      rank: 1,
      onPress: again,
    });
  if (outlook)
    verbs.push({
      id: "outlook",
      label: words("oauthConnect"),
      kind: "soft",
      rank: 2,
      onPress: outlook,
    });
  const more = words("moreActions");
  return (
    <>
      <ActionPanel
        label={words("connect")}
        items={verbs}
        onFold={setFolded}
        folded={folded}
        more={{ label: more, behind: false, expanded: moreAt !== null, onPress: setMoreAt }}
      />
      <Menu anchor={anchor} label={more} open={moreAt !== null} onClose={() => setMoreAt(null)}>
        {verbs
          .filter((verb) => folded.includes(verb.id))
          .map((verb) => (
            <MenuItem
              key={verb.id}
              icon={verb.icon}
              onPress={() => {
                if (moreAt) verb.onPress?.(moreAt);
                setMoreAt(null);
              }}
            >
              {verb.label}
            </MenuItem>
          ))}
      </Menu>
    </>
  );
}
