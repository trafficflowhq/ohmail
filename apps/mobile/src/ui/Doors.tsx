/**
 * The four doors, on a phone — one component rendered by the first-run screen and the Servers
 * screen's "Add a server" panel: the same question at two moments. The desktop asks which
 * machine does the organizing; the phone now has its own door — an engine inside this app
 * dialling the person's IMAP server. The fourth door is offered only where an engine is
 * registered (`standaloneAvailable`) — a build fact, not a flag. The other three: ohmail
 * Cloud (negotiates `/hello`; a non-pairing server gets a sentence), your own server (the
 * address step, so address faults become address sentences), your own computer (trust is
 * `net/host-pinning.ts`'s ceremony). One extra LAN line renders only where `canPin()` is false.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { refuse, sayRefusal, type Refusal } from "../refusal";
import { Platform, TextInput, View } from "react-native";
import { Copy } from "../copy";
import { phoneEngineStart } from "../engine/engine-artifact";
import { standaloneAvailable } from "../engine/standalone-door";
import { useConnection } from "../net/connection";
import type { Negotiation, PickerStep } from "../net/pairing";
import { MANAGED_ORIGIN, nextStep, stashPairOrigin } from "../net/pairing";
import { canPin, isNotTls } from "../net/host-pinning";
import { addressProblem, parseServerAddress } from "../net/server-base";
import { useTheme } from "../theme";
import { Button, Panel, Rule, Section, TapRow, Txt } from "./base";

/** Which door is open, and how far into it. `null` = the three tiles. */
type Open = null | "self";

/**
 * What the address step has established. `probed` carries the two facts a self-hoster needs and
 * the previous build swallowed: what answered, and where its mail API turned out to be.
 */
type Probe =
  | { k: "idle" }
  | { k: "asking" }
  | { k: "probed"; origin: string; flavor: string; base: string; prefixed: boolean }
  | { k: "failed"; sentence: Refusal };

/** One sentence per non-pairing outcome — the honest end of a flow, never a dead control. */
export function sentenceFor(n: Negotiation, step?: PickerStep): Refusal {
  /* AN ADDRESS THAT ANSWERED WITHOUT TLS IS NOT AN ADDRESS THAT COULD NOT BE REACHED, and this
     door is where a self-hoster typing an https address at a plain-http port arrives. Left
     unclassified the reason renders as the platform's own `SSLException` text after a full stop
     that already said the wrong thing — `isNotTls` decides, and its sentence names the cause. */
  if (n.kind === "unreachable") {
    return isNotTls(n.detail) ? refuse("notEncrypted") : refuse("unreachable", n.detail);
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
}: {
  onScan: () => void;
  onTypeToken: () => void;
  onStandalone?: () => void;
  lead?: boolean;
}) {
  const conn = useConnection();
  const [open, setOpen] = useState<Open>(null);
  const [address, setAddress] = useState("");
  const [probe, setProbe] = useState<Probe>({ k: "idle" });
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
   * this file opens no socket and names no address (a census rule). `measureBase` is false for
   * the Cloud card: the hosted address is a constant (`MANAGED_ORIGIN`), so the probe could
   * only return what it was given while adding a round trip that can fail. Nothing is skipped
   * either way — `pairWithServer` measures for itself, for every origin.
   */
  const check = useCallback(
    async (typed: string, measureBase: boolean) => {
      /* THE TICKET. Taken before anything awaits, so a check that never gets past the parse still
         supersedes an older one in flight — pressing a door IS abandoning the previous question. */
      const ticket = (latest.current += 1);
      const mine = (): boolean => latest.current === ticket;

      const problem = addressProblem(typed);
      if (problem !== null) {
        setProbe({ k: "failed", sentence: problem });
        return;
      }
      /* Non-null: `addressProblem` returned null, so the parse succeeded. Asserted rather than
         assumed — a non-null assertion here would be a claim about another function that nothing
         checks — and the NORMALIZED origin is what travels on, never the raw typing. */
      const origin = parseServerAddress(typed);
      if (origin === null) {
        setProbe({ k: "failed", sentence: addressProblem(typed) ?? refuse("notOhmail") });
        return;
      }
      setProbe({ k: "asking" });
      const answer = await conn.ask(origin);
      if (!mine()) return;
      if (answer.kind !== "hello") {
        setProbe({ k: "failed", sentence: sentenceFor(answer) });
        return;
      }
      const step = nextStep(answer.hello);
      if (step.kind !== "pair") {
        setProbe({ k: "failed", sentence: sentenceFor(answer, step) });
        return;
      }
      if (!measureBase) {
        setProbe({ k: "probed", origin, flavor: answer.hello.flavor, base: origin, prefixed: false });
        return;
      }
      const base = await conn.probeBase(origin);
      if (!mine()) return;
      if (base.kind === "refused") {
        setProbe({ k: "failed", sentence: base.reason });
        return;
      }
      setProbe({
        k: "probed",
        origin,
        flavor: answer.hello.flavor,
        base: base.base,
        prefixed: base.prefixed,
      });
    },
    [conn],
  );

  return (
    <>
      {lead ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 10 }}>
          <Txt variant="hint" tone="ink3">
            {Copy.doorsLead}
          </Txt>
        </View>
      ) : null}

      <Panel style={{ paddingBottom: 16 }}>
        <Section style={{ paddingTop: 16 }}>{Copy.serversAdd}</Section>

        {/* THE ORDER IS FEWEST CONDITIONS FIRST — see the deck's own note. Cloud, then a server
            the person runs, then a computer on their network, whose code carries a key and whose
            phone half is Android today. */}
        <Door
          name={Copy.doorCloud}
          say={Copy.doorCloudSay}
          onPress={() => {
            /* The Cloud card NEGOTIATES for real rather than routing on this deck's word: if the
               hosted service ever answers `pairing: false`, the person reads the server's answer
               and not a stale sentence from a source file. */
            setOpen(null);
            /* `false` — no base probe. See `check`'s note: this address is this app's own constant,
               so the probe could only return it, and its one possible outcome beyond that is a
               failure sentence on the door that has always worked. */
            void check(MANAGED_ORIGIN, false);
          }}
        />
        <Rule inset={20} />
        <Door
          name={Copy.doorOwnServer}
          say={Copy.doorOwnServerSay}
          onPress={() => {
            setOpen((v) => (v === "self" ? null : "self"));
            setProbe({ k: "idle" });
          }}
        />
        {open === "self" ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 6, gap: 10 }}>
            <Txt variant="hint" tone="ink3">
              {Copy.doorSelfLead}
            </Txt>
            <AddressField
              value={address}
              onChange={setAddress}
              /* LOCKED FROM THE MOMENT THE CHECK STARTS, not from the moment it answers — review
                 named the window. It read `probe.k === "probed"`, so the field was editable WHILE
                 asking: type A, press Continue, replace it with B, and A's answer locks the field
                 showing B while the pair buttons carry A. The token for B would then be sent to A.
                 Editable only in the two states where nothing is in flight and nothing is proved. */
              locked={probe.k === "asking" || probe.k === "probed"}
            />
            <Txt variant="hint" tone="ink3">
              {Copy.doorSelfCert}
            </Txt>
            <Button
              label={probe.k === "asking" ? Copy.doorSelfChecking : Copy.doorSelfGo}
              variant="solid"
              onPress={
                probe.k === "asking" || probe.k === "probed" || !address.trim()
                  ? undefined
                  : () => void check(address, true)
              }
            />
            <Result probe={probe} onScan={onScan} onTypeToken={onTypeToken} />
          </View>
        ) : null}
        <Rule inset={20} />
        <Door name={Copy.doorDesktop} say={Copy.doorDesktopSay} onPress={onScan} />
        {/* THE ONE CONDITION THIS DOOR HAS, BEFORE THE SCAN RATHER THAN AFTER IT. `canPin()` is
            false where the pinning half is absent, and there a same-network code is refused by the
            seam — so a person could follow the tile exactly and be stopped. See
            `doorDesktopNoPin`: the remedy that works, named where it is needed and nowhere else. */}
        {canPin() ? null : (
          <View style={{ paddingHorizontal: 20, paddingTop: 2 }}>
            <Txt variant="hint" tone="ink2">
              {Copy.doorDesktopNoPin}
            </Txt>
          </View>
        )}

        {open === null ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 6 }}>
            <Result probe={probe} onScan={onScan} onTypeToken={onTypeToken} />
          </View>
        ) : null}

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

/** What a probed address offers, or the sentence it ended on. Never a dead control. */
function Result({
  probe,
  onScan,
  onTypeToken,
}: {
  probe: Probe;
  onScan: () => void;
  onTypeToken: () => void;
}) {
  if (probe.k === "failed") {
    return (
      <Txt variant="hint" tone="ink2" style={{ paddingHorizontal: 4 }}>
        {sayRefusal(probe.sentence)}
      </Txt>
    );
  }
  if (probe.k !== "probed") return null;
  return (
    <View style={{ gap: 10 }}>
      <Txt variant="hint" tone="ink3" style={{ paddingHorizontal: 4 }}>
        {Copy.doorSelfReached(probe.origin, probe.flavor)}
        {/* SAID ONLY WHEN IT IS A FACT WORTH SAYING. A server whose API is at its own root has
            nothing to report here, and a line stating the obvious on every door would train
            people to skip the one place this detail matters. */}
        {probe.prefixed ? ` ${Copy.doorSelfApiUnder(probe.base)}` : ""}
      </Txt>
      <Button label={Copy.stepScan} onPress={onScan} />
      <Button
        label={Copy.stepManual}
        onPress={() => {
          // The negotiated address travels in this PROCESS, not in the route — see
          // `stashPairOrigin`. A route parameter here is reachable from `ohmail://connect?origin=`
          // and the pairing token IS the credential.
          stashPairOrigin(probe.origin);
          onTypeToken();
        }}
      />
    </View>
  );
}

function Door({
  name,
  say,
  need,
  onPress,
}: {
  name: string;
  say: string;
  /** The third line — what the door asks for next, or (door four) the condition it comes with. */
  need?: string;
  onPress: () => void;
}) {
  return (
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
      style={{ marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 12, gap: 3 }}
    >
      <Txt variant="navLabel">{name}</Txt>
      <Txt variant="hint" tone="ink3">{say}</Txt>
      {/* THE THIRD LINE IS IN THE LABEL TOO, for the reason the second one is: on door four it is
          the decision-bearing sentence, and a reader who heard "Standalone on this phone" and not
          "only while the app is open" has been told the wrong thing. */}
      {need !== undefined ? <Txt variant="hint" tone="ink3">{need}</Txt> : null}
    </TapRow>
  );
}

function AddressField({
  value,
  onChange,
  locked,
}: {
  value: string;
  onChange: (v: string) => void;
  locked: boolean;
}) {
  const t = useTheme();
  return (
    <View>
      <View
        style={[
          { paddingHorizontal: 14, borderRadius: t.radius.input, backgroundColor: t.c.canvas },
          t.lift("l0"),
        ]}
      >
        {/* NO SCHEME IN THE PLACEHOLDER, and it is not a census dodge: the parse accepts a bare
            host and completes it to https and nothing else (`cloud-origin.ts` — the only value it
            ever invents, and only ever in the safe direction), so a bare host is the shortest TRUE
            example. What https is for is said in `doorSelfCert`, and the refusal for a
            badly-shaped address spells the full form. */}
        <TextInput
          value={value}
          onChangeText={onChange}
          editable={!locked}
          autoCorrect={false}
          autoCapitalize="none"
          keyboardType="url"
          placeholder={Copy.doorSelfAddressPlaceholder}
          accessibilityLabel={Copy.doorSelfAddress}
          style={[t.type.msgBody, { color: t.c.ink, paddingVertical: 12 }]}
        />
      </View>
      <Txt variant="caption" tone="ink3" style={{ marginTop: 6 }}>
        {Copy.doorSelfAddressHint}
      </Txt>
    </View>
  );
}
