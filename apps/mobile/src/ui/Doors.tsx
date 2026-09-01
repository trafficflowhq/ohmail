/**
 * ═══ THE THREE DOORS, ON A PHONE ═══════════════════════════════════════════════════════════════
 *
 * One component, rendered by the first-run screen and by the Servers screen's "Add a server"
 * panel, because they are the same question asked at two moments. It was two implementations —
 * a welcome screen offering "scan" and "other ways", and a picker offering three cards with
 * different words — and the two had drifted into different vocabularies for one decision.
 *
 * ── WHAT A PHONE'S DOORS ARE, WHICH IS NOT WHAT THE DESKTOP'S ARE ──────────────────────────────
 *
 * The desktop asks which machine does the organizing and offers three answers, one of which is
 * ITSELF: "on this computer" runs an engine that dials the person's IMAP server directly. A phone
 * has no such door and cannot be given one — there is no IMAP client in this app, no engine
 * talking to a mail server, nothing that could hold a mailbox. So all three doors here name
 * somebody else's machine, and each sentence ends the same way: this phone keeps a copy.
 *
 * The three:
 *
 *  1. **ohmail Cloud** — the hosted service. Real today: its `/hello` announces
 *     `features.pairing` and its redeem is mounted, and the code comes from the Devices pane the
 *     web client shows on exactly that condition. Nothing here trusts that comment: the door
 *     negotiates, and a server that says it does not pair produces a sentence instead of a step.
 *  2. **Your own server** — a self-hosted stack. The address step, and it is a step of its own
 *     for the desktop door's reason: everything that goes wrong with a self-hosted address goes
 *     wrong here — a typo, a machine that is not running ohmail, a certificate nothing outside
 *     that network vouches for — and every one of those becomes a sentence about the address
 *     rather than a sentence about pairing.
 *  3. **Your own computer** — the desktop-host door. Its whole trust story is the pairing
 *     ceremony's (`net/host-pinning.ts`), the phone's half of it ships on Android and is named
 *     for iOS, and NOTHING in this file rebuilds any of it. The door routes to the scanner and
 *     the scanner's own seam decides what it will accept; the copy says what the code carries and
 *     does not promise the platform half that is not there.
 *
 * ── AND THE LAN HALF IS NOT PROMISED EARLY — WHICH TOOK TWO GOES TO GET RIGHT ──────────────────
 *
 * `admitOrigin` refuses a same-network pairing where `canPin()` is false and says which platform
 * half is missing. The first version of this screen therefore said nothing at all about "on your
 * own network", on the argument that a door tile is the wrong place for a conditional.
 *
 * That argument is right about the TILE and was wrong as a whole answer, and review showed why: the
 * tile says "open Settings → Devices there and scan its code", which is true on both platforms and
 * still walks an iPhone user into the refusal, because a computer's SAME-NETWORK code is the one
 * that needs the pin. Saying nothing did not stop the dead end; it just moved the discovery to
 * after the camera.
 *
 * So the tile stays unconditional and TRUE, and one extra line renders only where `canPin()` is
 * false, naming the address on that same pane which does work. A conditional nobody in the
 * condition has to read, and nobody outside it ever sees.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { Copy } from "../copy";
import { useConnection } from "../net/connection";
import type { Negotiation, PickerStep } from "../net/pairing";
import { MANAGED_ORIGIN, nextStep, stashPairOrigin } from "../net/pairing";
import { canPin } from "../net/host-pinning";
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
  | { k: "failed"; sentence: string };

/** One sentence per non-pairing outcome — the honest end of a flow, never a dead control. */
export function sentenceFor(n: Negotiation, step?: PickerStep): string {
  if (n.kind === "unreachable") return Copy.unreachable(n.detail);
  if (n.kind === "not-ohmail") return Copy.notOhmail;
  if (step?.kind === "managed-signin-later") return Copy.managedDeferred;
  return Copy.noPairing;
}

export function Doors({
  /** Where the scanner lives. Injected so this file routes nowhere itself and tests can drive it. */
  onScan,
  /** The manual token screen, opened with the address this app has just negotiated. */
  onTypeToken,
  /** `true` on the first-run screen, which is the one place the lead sentence is worth its room. */
  lead = false,
}: {
  onScan: () => void;
  onTypeToken: () => void;
  lead?: boolean;
}) {
  const conn = useConnection();
  const [open, setOpen] = useState<Open>(null);
  const [address, setAddress] = useState("");
  const [probe, setProbe] = useState<Probe>({ k: "idle" });
  /**
   * WHICH CHECK IS THE NEWEST — the request-identity guard, and it closes a real state bleed.
   *
   * `check` awaits two round trips, and NOTHING stopped an older one from landing on top of a newer
   * state. Review's sequence: tap **ohmail Cloud**, then open **Your own server** before `/hello`
   * answers. The Cloud check resolves, sets `probed` with the HOSTED origin, and that result renders
   * inside the self-hosted arm — locking the address field and offering to pair with a server the
   * person never typed. Two taps on the self-hosted door resolving out of order does the same.
   *
   * The connection layer solves this with `TransitionGate`'s `stillCurrent()`; this is the same
   * discipline at the screen: every check takes a ticket, and only the holder of the newest ticket
   * may write state. A superseded check writes nothing at all — not even its failure, because a
   * failure belonging to an abandoned question is noise on the question that replaced it.
   *
   * It also covers unmount, which is the other half review named: a check in flight when the screen
   * routes to the scanner is superseded by nothing, so `latest` simply never matches again after
   * the component is gone... which is NOT true of a ref, so the effect below marks it.
   */
  const latest = useRef(0);
  useEffect(() => () => { latest.current = -1; }, []);

  /**
   * NEGOTIATE, THEN MEASURE — and both before anything says "next".
   *
   * `/hello` says whether this is an ohmail server and whether it pairs; the base probe says
   * WHERE its mail API is, which on a one-origin self-host stack is not the address that was
   * typed. The second half is the reason this door exists at all: a pairing that skipped it
   * succeeded and then mirrored nothing for ever. The pairing seam measures again for itself —
   * that is where the value is stored and where a QR-driven pairing gets it too — and this call
   * is what lets the SCREEN name the answer before a code is spent.
   *
   * Both go through the connection layer (`ask`, `probeBase`), so this file opens no socket and
   * names no address of its own — which is a rule the privacy census holds, not a preference.
   *
   * ── AND THE BASE PROBE IS FOR A TYPED ADDRESS ONLY, WHICH IS NOT A SPECIAL CASE ─────────────
   *
   * `measureBase` is false for the Cloud card, and it started out true there — a regression this
   * would have shipped on the door that already works. The hosted service's address is a CONSTANT
   * in this app (`MANAGED_ORIGIN`), so there is nothing about it to discover: the probe could only
   * ever return the origin it was given, while adding a round trip that can FAIL. A network blip
   * on it would have shown "ohmail could not find its mail API" in place of the pair step, for the
   * one door whose API location has never been in question.
   *
   * The value the probe has is entirely about a TYPED address: it turns "this stack is proxied in a
   * way ohmail cannot reach" into a sentence before the person spends a single-use code. That
   * value does not exist where the address came from this app's own source.
   *
   * Nothing is skipped in the ceremony either way — `pairWithServer` measures for itself, for
   * every origin, including one that arrived by camera and never met this screen.
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
        setProbe({ k: "failed", sentence: addressProblem(typed) ?? Copy.notOhmail });
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
          <Txt variant="caption" tone="ink3" style={{ lineHeight: 17 }}>
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
            <Txt variant="caption" tone="ink3" style={{ lineHeight: 16 }}>
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
            <Txt variant="caption" tone="ink3" style={{ lineHeight: 16 }}>
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
            <Txt variant="caption" tone="ink2" style={{ lineHeight: 16 }}>
              {Copy.doorDesktopNoPin}
            </Txt>
          </View>
        )}

        {open === null ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 6 }}>
            <Result probe={probe} onScan={onScan} onTypeToken={onTypeToken} />
          </View>
        ) : null}

        <View style={{ paddingHorizontal: 20, paddingTop: 14 }}>
          <Txt variant="caption" tone="ink3" style={{ lineHeight: 17 }}>
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
      <Txt variant="caption" tone="ink2" style={{ lineHeight: 16, paddingHorizontal: 4 }}>
        {probe.sentence}
      </Txt>
    );
  }
  if (probe.k !== "probed") return null;
  return (
    <View style={{ gap: 10 }}>
      <Txt variant="caption" tone="ink3" style={{ lineHeight: 16, paddingHorizontal: 4 }}>
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

function Door({ name, say, onPress }: { name: string; say: string; onPress: () => void }) {
  return (
    <TapRow
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={name}
      style={{ marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 12, gap: 3 }}
    >
      <Txt variant="navLabel">{name}</Txt>
      <Txt variant="caption" tone="ink3" style={{ lineHeight: 16 }}>{say}</Txt>
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
          placeholder="ohmail.example.com"
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
