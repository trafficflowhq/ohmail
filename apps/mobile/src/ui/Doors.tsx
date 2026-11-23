/**
 * The four doors, on a phone — one component for the first-run screen and the Servers screen,
 * under one heading that names what the four are. A door renders its page
 * from that choice (`doors-answer.ts`). The fourth door, an engine inside this app dialling the
 * person's IMAP server, is offered only where an engine is registered (`standaloneAvailable`) — a
 * build fact, not a flag. The other three: ohmail Cloud (negotiates `/hello`; a non-pairing server
 * gets a sentence), your own server (the address step, so address faults become address
 * sentences), your own computer (trust is `net/host-pinning.ts`'s ceremony). One extra LAN line
 * renders only where `canPin()` is false.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { refuse, sayRefusal, type Refusal } from "../refusal";
import { Linking, Modal, Platform, View } from "react-native";
import { Copy } from "../copy";
import { phoneEngineStart } from "../engine/engine-artifact";
import { standaloneAvailable } from "../engine/standalone-door";
import { useConnection } from "../net/connection";
import { WEB_APP_URL } from "../net/account";
import type { Negotiation, PickerStep } from "../net/pairing";
import { MANAGED_ORIGIN, nextStep, stashPairOrigin, unreachableSaid } from "../net/pairing";
import { canPin, isNotTls } from "../net/host-pinning";
import { addressProblem, parseServerAddress } from "../net/server-base";
import { linksOutToBilling } from "../distribution";
import { Button, Panel, Rule, Section, TapRow, Txt } from "./base";
import { Field } from "./Field";
import { Icon, type IconName } from "./Icon";
import { NavDrawnContext } from "./nav-drawn";
import { OnboardingButton, OnboardingPage, OnboardingTag, OnboardingTitle, useOnboardingLook, useOnboardingButton } from "./OnboardingPage";
import { IDLE, pressDoor, probeUnder, type AnsweringDoor, type OpenDoor, type Probe } from "./doors-answer";

/** One sentence per non-pairing outcome — the honest end of a flow, never a dead control. */
export function sentenceFor(n: Negotiation, step?: PickerStep): Refusal {
  /* AN ADDRESS THAT ANSWERED WITHOUT TLS IS NOT AN ADDRESS THAT COULD NOT BE REACHED, and this
     door is where a self-hoster typing an https address at a plain-http port arrives. Left
     unclassified the reason renders as the platform's own `SSLException` text after a full stop
     that already said the wrong thing — `isNotTls` decides, and its sentence names the cause. */
  if (n.kind === "unreachable") {
    if (isNotTls(n.detail)) return refuse("notEncrypted");
    /* AND THE REST OF THE DIAL IS CLASSIFIED TOO, rather than quoted: `n.detail` is the
       platform's exception and this door is where a person meets it. The clause is a NESTED
       refusal, so a language switch reaches inside the sentence; an unrecognised fault gets the
       sentence with nothing after it. */
    const clause = unreachableSaid(n.detail);
    return clause === null ? refuse("unreachable") : refuse("unreachableWhy", clause);
  }
  if (n.kind === "not-ohmail") return refuse("notOhmail");
  if (step?.kind === "managed-signin-later") return refuse("managedDeferred");
  return refuse("noPairing");
}

export function Doors({
  /** Where the scanner lives. Injected so this file routes nowhere itself and tests can drive it. */
  onScan,
  /** The manual token screen, opened with the address this app has just negotiated. */
  onTypeToken,
  /** The standalone door's limitations screen. Absent ⇒ the fourth row is not rendered at all. */
  onStandalone,
  /** `true` on the first-run screen, which is the one place the lead sentence is worth its room. */
  lead = false,
  recovery = false,
}: {
  onScan: () => void;
  onTypeToken: () => void;
  onStandalone?: () => void;
  lead?: boolean;
  recovery?: boolean;
}) {
  const conn = useConnection();
  const { palette } = useOnboardingLook();
  const [open, setOpen] = useState<OpenDoor>(null);
  const [address, setAddress] = useState("");
  const [computer, setComputer] = useState(false);
  const [probe, setProbe] = useState<Probe>(IDLE);
  /**
   * Which check is the newest — the request-identity guard, and it closes a real state bleed.
   * `check` awaits two round trips and nothing stopped an older one from landing on top of a
   * newer state: tap ohmail Cloud, open Your own server before `/hello` answers, and the Cloud
   * check resolves into the self-hosted arm — locking the address field and offering to pair
   * with a server the person never typed. Same discipline as `TransitionGate.stillCurrent()`,
   * at the screen: every check takes a ticket, and only the newest ticket's holder may write
   * state. A superseded check writes nothing — not even its failure, which would be noise on
   * the question that replaced it. Unmount marks the ref so `latest` never matches again.
   */
  const latest = useRef(0);
  useEffect(() => () => { latest.current = -1; }, []);

  /**
   * Negotiate, then measure — both before anything says "next". `/hello` says whether this is
   * an ohmail server and whether it pairs; the base probe says where its mail API is, which on
   * a one-origin self-host stack is not the address that was typed — a pairing that skipped it
   * mirrored nothing for ever. Both go through the connection layer (`ask`, `probeBase`), so
   * this file opens no socket and names no address (a census rule). The Cloud card skips the
   * base probe: the hosted address is a constant (`MANAGED_ORIGIN`), so the probe could only
   * return what it was given while adding a round trip that can fail. Nothing is skipped either
   * way — `pairWithServer` measures for itself, for every origin. Every probe names its door.
   */
  const check = useCallback(
    async (typed: string, door: AnsweringDoor) => {
      const measureBase = door === "self";
      /* THE TICKET. Taken before anything awaits, so a check that never gets past the parse still
         supersedes an older one in flight — pressing a door IS abandoning the previous question. */
      const ticket = (latest.current += 1);
      const mine = (): boolean => latest.current === ticket;

      const problem = addressProblem(typed);
      if (problem !== null) {
        setProbe({ k: "failed", door, sentence: problem });
        return;
      }
      /* Non-null: `addressProblem` returned null, so the parse succeeded. Asserted rather than
         assumed — a non-null assertion here would be a claim about another function that nothing
         checks — and the NORMALIZED origin is what travels on, never the raw typing. */
      const origin = parseServerAddress(typed);
      if (origin === null) {
        setProbe({ k: "failed", door, sentence: addressProblem(typed) ?? refuse("notOhmail") });
        return;
      }
      setProbe({ k: "asking", door });
      const answer = await conn.ask(origin);
      if (!mine()) return;
      if (answer.kind !== "hello") {
        setProbe({ k: "failed", door, sentence: sentenceFor(answer) });
        return;
      }
      const step = nextStep(answer.hello);
      if (step.kind !== "pair") {
        setProbe({ k: "failed", door, sentence: sentenceFor(answer, step) });
        return;
      }
      if (!measureBase) {
        setProbe({ k: "probed", door, origin, flavor: answer.hello.flavor, base: origin, prefixed: false });
        return;
      }
      const base = await conn.probeBase(origin);
      if (!mine()) return;
      if (base.kind === "refused") {
        setProbe({ k: "failed", door, sentence: base.reason });
        return;
      }
      setProbe({
        k: "probed",
        door,
        origin,
        flavor: answer.hello.flavor,
        base: base.base,
        prefixed: base.prefixed,
      });
    },
    [conn],
  );
  const close = () => {
    latest.current += 1;
    setOpen(null);
    setProbe(IDLE);
    setComputer(false);
  };
  const scan = () => {
    close();
    onScan();
  };
  const manual = () => {
    close();
    onTypeToken();
  };

  /** The address step's own probe — never another door's check that landed late. */
  const selfProbe = probeUnder("self", open, probe);

  return (
    <>
      {lead ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 10 }}>
          <Txt variant="hint" tone="ink3">
            {Copy.doorsLead}
          </Txt>
        </View>
      ) : null}

      <Panel style={{ paddingBottom: 16, ...(recovery ? { backgroundColor: palette.sheet, boxShadow: [] } : {}) }}>
        {recovery ? (
          <Txt variant="settingsLabel" style={{ padding: 20 }}>{Copy.phoneServersConnectTo}</Txt>
        ) : <Section style={{ paddingTop: 16 }}>{Copy.doorsHead}</Section>}

        {/* THE ORDER IS FEWEST CONDITIONS FIRST — see the deck's own note. Cloud, then a server
            the person runs, then a computer on their network, whose code carries a key and whose
            phone half is Android today. Each choice owns the page it opens. */}
        <Door
          name={Copy.doorCloud}
          icon={recovery ? "ohbox" : undefined}
          say={Copy.doorCloudSay}
          onPress={() => {
            /* The Cloud card NEGOTIATES for real rather than routing on this deck's word: if the
               hosted service ever answers `pairing: false`, the person reads the server's answer
               and not a stale sentence from a source file. No base probe — see `check`. */
            setOpen((v) => pressDoor(v, "cloud"));
            void check(MANAGED_ORIGIN, "cloud");
          }}
        >
          {open === "cloud" ? (
            <DoorModal close={close}>
              <Result probe={probeUnder("cloud", open, probe)} back={close} onScan={scan} onTypeToken={manual} />
            </DoorModal>
          ) : null}
        </Door>
        <Rule inset={20} />
        <Door
          name={Copy.doorOwnServer}
          icon={recovery ? "folder" : undefined}
          say={Copy.doorOwnServerSay}
          onPress={() => {
            setOpen((v) => pressDoor(v, "self"));
            setProbe(IDLE);
          }}
        >
          {open === "self" ? (
            <DoorModal close={close}>
              <Result
                probe={probeUnder("self", open, probe)}
                back={close}
                onScan={scan}
                onTypeToken={manual}
                ask={() => {
                  if (address.includes("#")) setAddress("");
                  void check(address, "self");
                }}
                address={
                  <Field
                    value={address}
                    onChange={setAddress}
                    locked={selfProbe.k === "asking" || selfProbe.k === "probed"}
                    label={Copy.doorSelfAddress}
                    sentence={{
                      before: Copy.phoneServerSentence,
                      placeholder: Copy.phoneServerBlank,
                      compact: true,
                      end: selfProbe.k === "probed" ? "ink" : "hot",
                    }}
                    input={{ keyboardType: "url" }}
                  />
                }
                empty={!address.trim()}
              />
            </DoorModal>
          ) : null}
        </Door>
        <Rule inset={20} />
        <Door name={Copy.doorDesktop} say={Copy.doorDesktopSay}
          icon={recovery ? "computer" : undefined} onPress={() => setComputer(true)}
        >
          {computer ? (
            <DoorModal close={close}>
              <ComputerDoor back={close} scan={scan} />
            </DoorModal>
          ) : null}
        </Door>

        {/* ── THE FOURTH DOOR, UNDER THE THIRD ──────────────────────────────────────────────
            Same anatomy as the other three, no accent and no badge: position is the loudest signal
            on a list and this row must not read as the recommended one. What sets it apart is its
            THIRD line, which is a condition where the others' are instructions — the door's cost,
            read before the tap.

            Rendered only where a route was handed in AND an engine is registered. Both halves
            matter: the first is the caller's (the Servers screen and first run both pass one), the
            second is the build's, and a row offered without the second would be a control that
            cannot do what it says. */}
        {onStandalone !== undefined && standaloneAvailable({ startEngine: phoneEngineStart() }) ? (
          <>
            <Rule inset={20} />
            <Door
              name={Copy.doorPhone}
              icon={recovery ? "phone" : undefined}
              say={Copy.doorPhoneSay}
              need={
                Platform.OS === "android" ? Copy.doorPhoneNeedAndroid : Copy.doorPhoneNeedIos
              }
              onPress={onStandalone}
            />
          </>
        ) : null}

        <View style={{ paddingHorizontal: 20, paddingTop: 10 }}>
          <Txt variant="hint" tone="ink3">
            {Copy.doorsTravel}
          </Txt>
        </View>
      </Panel>
    </>
  );
}

function DoorModal({ close, children }: { close: () => void; children: ReactNode }) {
  return (
    <Modal animationType="slide" onRequestClose={close}>
      {/* The underlying mailbox's rail cannot take a press through this modal. */}
      <NavDrawnContext.Provider value={false}>{children}</NavDrawnContext.Provider>
    </Modal>
  );
}

function ComputerDoor({ back, scan }: { back: () => void; scan: () => void }) {
  const { palette } = useOnboardingLook();
  const supported = canPin();
  return (
    <OnboardingPage back={back} actions={<OnboardingButton label={Copy.welcomeScan} onPress={scan} />}>
      <View style={{ gap: 16 }}>
        <OnboardingTitle text={Copy.phoneComputerSentence} />
        <OnboardingTag label={Copy.scanDevices} />
        <Txt variant="body" style={{ color: palette.ink, fontWeight: "700" }}>
          {supported ? Copy.phoneComputerAndroid : Copy.phoneComputerIos}
        </Txt>
        {supported ? null : <Txt variant="body" style={{ color: palette.ink2 }}>{Copy.phoneComputerNoPin}</Txt>}
      </View>
    </OnboardingPage>
  );
}

/** A probe belongs to this door, even though its answer now occupies a full page. */
function Result({
  probe,
  back,
  onScan,
  onTypeToken,
  ask,
  address,
  empty,
}: {
  probe: Probe;
  back: () => void;
  onScan: () => void;
  onTypeToken: () => void;
  ask?: () => void;
  address?: ReactNode;
  empty?: boolean;
}) {
  const { palette } = useOnboardingLook();
  const onboardingButton = useOnboardingButton();
  const [browserRefused, setBrowserRefused] = useState(false);
  const cloud = ask === undefined;
  const canOpenBrowser = cloud && linksOutToBilling();
  const reached = probe.k === "probed";
  const checking = probe.k === "asking";
  const browser = (page: "login" | "join") => {
    setBrowserRefused(false);
    void Linking.openURL(`${WEB_APP_URL}/${page}`).catch(() => setBrowserRefused(true));
  };

  return (
    <OnboardingPage
      back={back}
      row={reached && !canOpenBrowser}
      actions={
        <>
          {reached ? (
            <>
              <OnboardingButton label={Copy.stepScan} grow={!canOpenBrowser} onPress={onScan} />
              <OnboardingButton label={Copy.stepManual} kind="soft" grow={!canOpenBrowser} onPress={() => {
                stashPairOrigin(probe.origin);
                onTypeToken();
              }} />
            </>
          ) : ask === undefined ? (
            checking
              ? <Button appearance={onboardingButton} label={Copy.doorSelfChecking} disabled onPress={back} />
              : <OnboardingButton label={Copy.phoneStandaloneBack} onPress={back} />
          ) : (
            <Button appearance={onboardingButton}
              label={checking ? Copy.doorSelfChecking : Copy.doorSelfGo}
              disabled={checking || empty}
              onPress={ask}
            />
          )}
          {canOpenBrowser ? (
            <>
              <OnboardingButton label={Copy.phoneCloudSignIn} kind="quiet" onPress={() => browser("login")} />
              <OnboardingButton label={Copy.phoneCloudJoin} kind="quiet" onPress={() => browser("join")} />
            </>
          ) : null}
        </>
      }
    >
      <View style={{ gap: 16 }}>
        {cloud ? <OnboardingTitle text={Copy.doorCloud} /> : address}
        {probe.k === "failed" ? (
          <Txt variant="body" accessibilityRole="alert" style={{ color: palette.ink, fontWeight: "700" }}>
            {sayRefusal(probe.sentence)}
          </Txt>
        ) : null}
        {reached ? (
          <Txt variant="body" style={{ color: palette.ink, fontWeight: "700" }}>
            {Copy.doorSelfReached(probe.origin, probe.flavor)}
            {probe.prefixed ? ` ${Copy.doorSelfApiUnder(probe.base)}` : ""}
          </Txt>
        ) : null}
        {cloud && (probe.k !== "failed" || canOpenBrowser) ? (
          <View style={{ gap: 8 }}>
            <Txt variant="settingsLabel" style={{ color: palette.ink }}>{Copy.phoneCloudBrowser}</Txt>
            <Txt variant="body" style={{ color: palette.ink2 }}>{Copy.phoneCloudBrowserHint}</Txt>
          </View>
        ) : !reached && probe.k !== "failed" ? (
          <View style={{ gap: 8 }}>
            <Txt variant="body" style={{ color: palette.ink, fontWeight: "700" }}>{Copy.phoneServerHint}</Txt>
            <Txt variant="body" style={{ color: palette.ink2 }}>{Platform.OS === "android" ? Copy.phoneServerAndroid : Copy.phoneServerIos}</Txt>
          </View>
        ) : null}
        {browserRefused ? <Txt variant="body" accessibilityRole="alert">{Copy.phoneCloudBrowserRefused}</Txt> : null}
      </View>
    </OnboardingPage>
  );
}

/** One option and, below it, whatever it answered — one component, so the two cannot drift apart. */
function Door({
  name,
  say,
  need,
  icon,
  onPress,
  children,
}: {
  name: string;
  say: string;
  /** The third line — what the door asks for next, or (door four) the condition it comes with. */
  need?: string;
  icon?: IconName;
  onPress: () => void;
  /** This door's answer, rendered under its row. The routing doors have none. */
  children?: ReactNode;
}) {
  const { palette } = useOnboardingLook();
  return (
    <View>
      <TapRow
        onPress={onPress}
        accessibilityRole="button"
        /**
         * The name AND the sentence — an explicit label replaces the one React Native would
         * derive from the child text, and the sentence is not decoration here. Carrying only the
         * name, a screen reader announced "Your own computer, button" and dropped "open Settings
         * → Devices there and scan its code" — the whole answer of which machine organizes and
         * what to do next. One label with both, rather than a `hint`: a hint is spoken after a
         * pause and can be turned off entirely, and this sentence is not supplementary to the
         * choice — it IS the choice.
         */
        accessibilityLabel={Copy.ariaNameThenSentence(name, need === undefined ? say : `${say} ${need}`)}
        style={{ marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 12, gap: 8, flexDirection: "row" }}
      >
        {icon ? <Icon name={icon} size={18} color={palette.ink2} /> : null}
        <View style={{ flex: 1, gap: 3 }}>
          <Txt variant={icon ? "settingsLabel" : "navLabel"}>{name}</Txt>
          <Txt variant={icon ? "body" : "hint"} tone={icon ? "ink2" : "ink3"}>{say}</Txt>
          {need !== undefined ? <Txt variant="hint" tone="ink3">{need}</Txt> : null}
        </View>
      </TapRow>
      {children}
    </View>
  );
}
