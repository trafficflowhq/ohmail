/**
 * SETTINGS → DEVICES — host mode's whole surface: turn this computer into the household's
 * mail server, pair a phone by pointing its camera at the screen, see what is paired, take
 * one back. The bar is the password-manager one: every state is a sentence and one action —
 * the pane asks the shell what is true (`tailscale_status`, `host_state`) and renders the one
 * step actually in the way. Arming, disarming, probing and start-at-login are SHELL commands
 * (`src/host.ts`); the pairing ceremony and device list are ENGINE requests over the bridge
 * (`POST/GET/DELETE /pair`, `GET/DELETE /devices`), mounted only while host mode is armed —
 * so this pane loads them only then, and a disarmed engine never sees a request it would 404.
 */

/*
 * THE LINK: the QR encodes `${origin}/pair#<fragment>` (the Invites pane's fragment idiom — a
 * fragment is not sent in the page request, cannot land in a log, never rides a `Referer`);
 * the fragment's shape lives in `@ohmail/client-engine` (`pair-link.ts`) because the PHONE
 * parses it. The raw token appears exactly once — this mint's answer, QR plus copy button,
 * never printed; the engine stores only a hash, the code works once and expires in five
 * minutes. The window's OWN session is not in the device list: `GET /devices` answers every
 * live session including the launch session this window asks over (the row marked `current`),
 * and "Remove" on it would be the window revoking itself — the list renders the NOT-current.
 */

/*
 * THE COPY BAR: "While this computer is awake" — never an unqualified "always on"; the
 * catalogue test pins the qualifier in both languages. SAME-NETWORK ACCESS is `https` with a
 * key the engine keeps (`apps/sidecar/src/host-lan-tls.ts`); plain HTTP is why LAN pairing
 * never worked on a shipped phone (a release build permits no cleartext). No authority
 * issues for a DHCP address, so the trust rides the CEREMONY: the pane reads the door's
 * fingerprint (`GET /local/lan/pin`) at mint time and puts it in the link — a mint with no
 * fingerprint is REFUSED. A phone BROWSER still cannot use the address
 * (`test/host-client-secure-context.test.ts`); opt-in, address CHOSEN from
 * `GET /local/lan/candidates`, and the no-Tailscale path — no tailnet needed. The short PIN comparison comes from `@ohmail/client-engine`. */

import type { ToastFn } from "@ohmail/app-logic/press/report";
import { useReport } from "@ohmail/app/frame";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Button, CodeText, CodeTile, Field, NativeSelect, RefusalLine, Switch, Tag } from "@ohmail/ui/base";
import { SettingActs, SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";

import { isPairPin, pairLink, shortPin } from "@ohmail/client-engine";
/* THE SAME TWELVE CHARACTERS THE JOINING MACHINE SHOWS — one function, or the two ends of
   the comparison would be comparing different substrings of the same key. */

import { bridgeFetch } from "./bridge-fetch.js";
import { DOOR_COPY } from "./door-copy.js";
import { autostartSentenceKey, updateState, type InstallKind } from "./update.js";
import { QrCode } from "../../webapp/app/shell/QrCode.js";
import {
  armHostMode,
  disarmHostMode,
  hostState,
  openTailscaleDownload,
  setAutostart,
  tailscaleStatus,
  type HostProblem,
  type HostState,
  type TailscaleStatus,
} from "./host.js";

/**
 * The port the first enable offers. Fixed rather than "any free port" — the shell's registration
 * points Tailscale at a NUMBER, so the engine must bind the one the user agreed to. Below EVERY
 * supported platform's ephemeral range (Linux hands out 32768–60999, macOS and Windows
 * 49152–65535), because a default inside one can be transiently held by any outbound socket at
 * the moment of arming — which reports as listener-failed for no reason the user caused. 6245 is
 * MAIL on a phone keypad, above the privileged range, and claimed by nothing common; re-arming
 * offers the remembered port back instead.
 */
export const DEFAULT_HOST_PORT = 6245;

/**
 * THE GUIDED LADDER — every problem the shell can name, mapped to the one designed sentence
 * and nothing else. A closed vocabulary on both sides: `host.ts` parses the shell's answer
 * against `HOST_PROBLEMS` and degrades an unknown name to `null`, and this map takes `null`
 * to the generic guidance — a shell one version ahead gets a calm sentence, never a raw code.
 * Exported so the test can hold the mapping cell for cell. The four tailnet-side names double
 * as the OFF state's probe vocabulary (`tailscale_status` answers the same words), so one map
 * serves both moments.
 */
export type GuideKey =
  | "guideNoCli"
  | "guideNotRunning"
  | "guideNotLoggedIn"
  | "guideNoDnsName"
  | "guideServeRefused"
  | "guideLocalDoorRequired"
  | "guideEngineNotServing"
  | "guideListenerPending"
  | "guideListenerSkipped"
  | "guideListenerFailed"
  | "guideConfigInvalid"
  | "guideGeneric";

export function guideKey(problem: HostProblem | null): GuideKey {
  switch (problem) {
    case "no-cli":
      return "guideNoCli";
    case "not-running":
      return "guideNotRunning";
    case "not-logged-in":
      return "guideNotLoggedIn";
    case "no-dns-name":
      return "guideNoDnsName";
    case "serve-refused":
      return "guideServeRefused";
    case "local-door-required":
      return "guideLocalDoorRequired";
    case "engine-not-serving":
      return "guideEngineNotServing";
    case "listener-pending":
      return "guideListenerPending";
    case "listener-skipped":
      return "guideListenerSkipped";
    case "listener-failed":
      return "guideListenerFailed";
    case "host-config-invalid":
      return "guideConfigInvalid";
    default:
      // `null` — a problem this bundle cannot name. The generic guidance, never the raw word.
      return "guideGeneric";
  }
}

/** A pairing code as the list renders it — metadata only; the raw token is never in a list. */
interface MintRow {
  id: string;
  label: string;
  expiresAt: string;
}

/** A paired device as the list renders it. */
interface DeviceRow {
  id: string;
  kind: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
}

/**
 * The live device-pair rows out of `GET /pair`'s answer — everything else refused field by
 * field. Invite rows cannot exist on this door (the mint refuses the grant), but the filter
 * states the contract rather than trusting it; spent and expired rows are history, not a list.
 */
function mintRowsOf(payload: unknown): MintRow[] {
  const items = (payload as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const rows: MintRow[] = [];
  for (const raw of items) {
    const r = raw as Record<string, unknown>;
    if (r.grant !== "device-pair" || r.status !== "live") continue;
    if (typeof r.id !== "string" || typeof r.expiresAt !== "string") continue;
    rows.push({ id: r.id, label: typeof r.label === "string" ? r.label : "", expiresAt: r.expiresAt });
  }
  return rows;
}

/** The paired rows out of `GET /devices` — the `current` session excluded; see the header. */
function deviceRowsOf(payload: unknown): DeviceRow[] {
  const items = (payload as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const rows: DeviceRow[] = [];
  for (const raw of items) {
    const r = raw as Record<string, unknown>;
    if (r.current === true) continue;
    if (typeof r.id !== "string") continue;
    rows.push({
      id: r.id,
      kind: typeof r.kind === "string" ? r.kind : "",
      label: typeof r.label === "string" ? r.label : "",
      createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
      lastSeenAt: typeof r.lastSeenAt === "string" ? r.lastSeenAt : "",
    });
  }
  return rows;
}

/** The engine's own words for a refusal, or the status line — `doors.ts`'s lenient read. */
async function refusalText(res: Response): Promise<string> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* nothing readable — the status line below is the whole answer */
  }
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; code?: string } };
    const message = parsed.error?.message ?? parsed.error?.code;
    if (message) return message;
  } catch {
    /* not JSON */
  }
  return res.statusText
    ? `${res.status} ${res.statusText}`
    : DOOR_COPY.errorRefused(String(res.status));
}

function sentence(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message || DOOR_COPY.errorUnknown;
}

type Busy =
  | null
  | "arm"
  | "disarm"
  | "probe"
  | "mint"
  | "autostart"
  | `revoke:${string}`
  | `remove:${string}`;

/**
 * How often the open Devices pane re-reads host state. Faster than the engine's own firewall
 * re-check, so the screen never lags the engine by more than one of its own ticks.
 */
const HOST_POLL_MS = 5000;

export function DesktopPairingDevices() {
  return <DesktopDevices report={useReport()} />;
}

export function DesktopDevices({ report }: { report: ToastFn }) {
  const t = useTranslations("host");
  const format = useFormatter();

  /** Host mode as the shell last reported it; `undefined` = not asked yet, `null` = no shell. */
  const [host, setHost] = useState<HostState | null | undefined>(undefined);
  /** The tailnet probe, read only while host mode is off. `undefined` = probing. */
  const [probe, setProbe] = useState<TailscaleStatus | null | undefined>(undefined);
  /**
   * Whether the opening read has ever completed — BOTH halves of it. A recorded fact, because
   * every attempt to infer it from `host`/`probe` also matched states reached long afterwards.
   */
  const [openingReadDone, setOpeningReadDone] = useState(false);
  /** A retry of the opening read is out and has not settled. `tailscale_status` can hang. */
  const retrying = useRef(false);
  const [busy, setBusy] = useState<Busy>(null);
  /** A refusal or a thrown transport, as one sentence beside the controls. Never a toast. */
  const [problem, setProblem] = useState<string | null>(null);

  /* The ceremony's choices. Autostart default-CHECKED and visible — the always-on role is
     the reason most people turn this on, and a hidden default would be a decision made for them
     in the dark. The port is advanced-only: defaulted, and shown only to whoever asks. The LAN
     option is default-OFF — same-network access is an opt-in on top of host mode's opt-in. */
  const [autostartDraft, setAutostartDraft] = useState(true);
  /**
   * HOW THIS COPY WAS INSTALLED, for the one setting an install can make impossible. `null` is
   * NOT ANSWERED YET — the shell has not replied, or there is no shell — and `"unknown"` is a
   * shell that did not name a kind; neither draws a start-at-login switch, because a switch that
   * may do nothing is worse than a row that is not there yet.
   */
  const [installKind, setInstallKind] = useState<InstallKind | null>(null);
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [lanDraft, setLanDraft] = useState(false);
  /** The engine's enumeration: `undefined` = loading, `null` = the read failed, `[]` = none. */
  const [lanCandidates, setLanCandidates] =
    useState<Array<{ address: string; name: string }> | null | undefined>(undefined);
  const [lanChoice, setLanChoice] = useState<string | null>(null);
  /**
   * THIS COMPUTER'S OWN KEY, as the twelve characters a person compares — or null. The
   * same-network door serves TLS with a key nobody vouches for, so the pairing carries the
   * trust: the link names the key and the joining machine accepts that key only — sound as
   * long as the link came from here, and if something on the network hands somebody a link
   * naming ITS key, the ceremony authenticates the wrong machine perfectly. The defence is a
   * value readable on both screens: the joining machine shows twelve characters before it
   * pairs, and this row is where the same twelve are read from. `null` while unread or with
   * no same-network door — no placeholder somebody might compare against.
   */
  const [lanKey, setLanKey] = useState<string | null>(null);

  /** The one appearance of a raw token, dressed as the link it is scanned as. */
  const [minted, setMinted] = useState<{ link: string; label: string } | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [mints, setMints] = useState<MintRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  /** Which device row is being asked "did you mean it" — the rest/confirm idiom, one at a time. */
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  /* Armed in the setup, not only at declaration — Strict Mode runs cleanup and setup again on
     the same instance; the Invites pane carries the failure this prevents. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /* One read of how this copy was installed. Outside the app the shell answers nothing, and a
     kind it does not name degrades to "unknown" — both fall to "not answered", which draws no
     start-at-login switch. */
  useEffect(() => {
    void updateState().then((report) => {
      if (alive.current) setInstallKind(report?.installKind ?? "unknown");
    });
  }, []);

  /**
   * START AT LOGIN, or the sentence that replaces it.
   *
   * The Flatpak cannot register a login item for the host session — its `~/.config/autostart`
   * is inside the sandbox — so the switch is not drawn there at all; a control that takes a
   * press and does nothing is the failure this row exists to avoid. `null` while the kind is
   * unanswered: the row appears once the shell has said, never before.
   */
  const autostartRow = (control: ReactNode, description: string): ReactNode => {
    if (installKind === null) return null;
    const sandboxed = autostartSentenceKey(installKind);
    if (sandboxed !== null) {
      return <SettingLine label={t("autostart")} description={t(sandboxed)} />;
    }
    return <SettingLine label={t("autostart")} description={description}>
  {control}
</SettingLine>;
  };

  /** The pairing surfaces exist on the stdio door only while armed — never asked otherwise.
   *  A failed AMBIENT read is swallowed, deliberately: in a degraded state the engine behind
   *  these lists may itself be the thing the guided sentence is about, and a transport error
   *  printed beside that sentence would be the raw noise the ladder exists to replace. The
   *  VERBS (mint, revoke, remove) surface their own refusals — an action that fails must say
   *  so; a list that could not load simply stays as it was. */
  const refreshLists = useCallback(async () => {
    try {
      const [pairRes, devRes] = await Promise.all([bridgeFetch("/pair"), bridgeFetch("/devices")]);
      if (!alive.current) return;
      if (pairRes.ok) setMints(mintRowsOf(await pairRes.json()));
      if (devRes.ok) setDevices(deviceRowsOf(await devRes.json()));
    } catch {
      /* ambient — see above */
    }
  }, []);

  /** One read of the world: host mode always, the tailnet probe only while there is a ceremony
   *  to guide, the lists only where the routes exist. Also the "Check again" button. */
  const refresh = useCallback(async () => {
    setBusy("probe");
    setProblem(null);
    try {
      const state = await hostState();
      if (!alive.current) return;
      setHost(state);
      if (state && !state.enabled) {
        setProbe(undefined);
        const seen = await tailscaleStatus();
        if (!alive.current) return;
        setProbe(seen);
      } else if (state?.enabled) {
        await refreshLists();
      }
      // BOTH halves landed. Recorded as a fact rather than inferred from `host`/`probe` later:
      // those two are shared with every other action on this pane, so reading "the opening read
      // has not finished" out of them also matched states reached long afterwards — a disarm
      // that failed and left an unresolved probe looked identical to a cold mount, and the retry
      // then wiped the disarm's own error off the screen.
      if (alive.current) setOpeningReadDone(true);
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [refreshLists]);

  useEffect(() => {
    // The catch is the difference between a failed first read and an unhandled rejection: the
    // pane's answer to "the shell did not respond" is the retry below, not a console trace.
    // It ACQUIRES the same in-flight marker as the retry — `if` then set, never a bare set. This
    // is the opening read's first attempt, and a probe that hangs here must not have a second one
    // stacked on top of it, by the timer OR by this effect running twice. It does run twice: the
    // window mounts this component under `StrictMode` (`main.tsx`), which replays every effect in
    // development. A bare set launched two `tailscale_status` subprocesses, and then the first to
    // settle cleared the flag for the one still hanging — releasing a lock it did not hold.
    if (retrying.current) return;
    retrying.current = true;
    void refresh()
      .catch(() => undefined)
      .finally(() => {
        retrying.current = false;
      });
  }, [refresh]);

  /**
   * When the background read should run: while host mode is ON, and while this window has
   * not yet had a readable answer at all. The second half is a retry, not a poll: the mount
   * read has no catch, so a shell call that rejects leaves `host` at `undefined` and the pane
   * sits on "Checking…" with no control to try again until remounted. The boundary that
   * matters is a CONFIRMED off state — the one place a background read destroys information
   * (see the effect below) — and "we have never heard back" is not that.
   */
  const armed = host?.enabled === true;
  /**
   * When the background read should run: while host mode is ON, and until the opening read
   * has finished at all. The retry closes a dead end: the mount read has no failure path, so
   * a rejected shell call left the pane on "Checking…" until remounted. Two wrong shapes
   * preceded this, both INFERRING "the opening read has not finished" from `host` and
   * `probe`, which every other action also writes: watching `host` alone stopped one step
   * late, and watching both matched a state reached long after mount — a failed disarm also
   * leaves an unresolved probe, and the retry's `refresh()` cleared the disarm's own error
   * off the screen. So it is a recorded fact, set once by the read that completes.
   */
  const pollHostState = armed || !openingReadDone;

  /**
   * KEEP THE OPEN PANE HONEST — re-read host state while this screen is on the display. Read
   * once at mount, the pane said "Same-network access is starting…" for the life of the
   * window over a door that was serving (the LAN door binds a moment after the window comes
   * up), and the firewall warning's re-check never reached the screen. A quiet poll, not a
   * subscription; `busy` is deliberately NOT set — never a pressed-looking button while
   * somebody reads. ONLY WHILE ARMED, a fix rather than an optimisation: polling while OFF
   * destroys information — a refused arm answers the current state plus that attempt's
   * problem, and an unconditional poll wiped that one explanation
   * (`desktop-devices.test.tsx` guards the loop). Off is driven by explicit acts. */
  /**
   * READ THIS COMPUTER'S KEY once the same-network door is up, and forget it when it goes
   * down. `GET /local/lan/pin` is the same route the mint reads, late rather than at mount
   * for the same reason: the key belongs to the engine, the engine can be respawned, and a
   * fingerprint held from an earlier process would be compared against a link that no longer
   * matches — a mismatch reported as an attack. Keyed on `lanState`, so arming or disarming
   * re-reads or clears it; a failed read leaves `null` and the row does not render.
   */
  useEffect(() => {
    /* `host` is null until the opening read lands, and "not read yet" is not "not armed" — but
       both mean there is no key to show, so they render alike here. */
    const armed = host?.lanState === "serving" || host?.lanState === "blocked";
    if (!armed) {
      setLanKey(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await bridgeFetch("/local/lan/pin");
        if (cancelled || !res.ok) return;
        const body = (await res.json()) as { fingerprint?: unknown };
        if (cancelled) return;
        setLanKey(
          typeof body.fingerprint === "string" && isPairPin(body.fingerprint)
            ? body.fingerprint
            : null,
        );
      } catch {
        /* The engine did not answer. The row stays absent rather than showing a value nobody
           could have compared against anything. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host?.lanState]);

  useEffect(() => {
    if (!pollHostState) return undefined;
    const tick = setInterval(() => {
      // NEVER HEARD BACK ⇒ redo the WHOLE opening read, not just the half that failed. The
      // ladder below needs the tailnet probe too, and a retry that filled in only `host` would
      // leave the pane reporting off while still saying it was checking.
      if (!openingReadDone) {
        // ONE AT A TIME. `tailscale_status` shells out with NO TIMEOUT, so a tailnet daemon that
        // hangs rather than refusing never settles — and a retry that fired regardless would
        // start a new `tailscale` subprocess every five seconds, for ever. A stuck attempt is
        // still an attempt; the retry waits for it.
        if (retrying.current) return;
        retrying.current = true;
        void refresh()
          .catch(() => undefined)
          .finally(() => {
            retrying.current = false;
          });
        return;
      }
      void (async () => {
        try {
          const state = await hostState();
          if (alive.current) setHost(state);
        } catch {
          // A poll that fails changes nothing on screen — the last known state is still the
          // last thing this window actually knows.
        }
      })();
    }, HOST_POLL_MS);
    return () => clearInterval(tick);
  }, [pollHostState, openingReadDone, refresh]);

  /** The engine's enumeration of this machine's offerable addresses — read when the LAN option
   *  opens, because the choice must be OFFERED, never typed (a typo'd address is a socket that
   *  binds nothing anyone can reach, or worse, an interface nobody meant). */
  const loadLanCandidates = useCallback(async (remembered: string | null) => {
    setLanCandidates(undefined);
    try {
      const res = await bridgeFetch("/local/lan/candidates");
      if (!alive.current) return;
      if (!res.ok) {
        setLanCandidates(null);
        return;
      }
      const body = (await res.json()) as { items?: unknown };
      const rows: Array<{ address: string; name: string }> = [];
      for (const raw of Array.isArray(body.items) ? body.items : []) {
        const r = raw as Record<string, unknown>;
        if (typeof r.address !== "string" || r.address.length === 0) continue;
        rows.push({ address: r.address, name: typeof r.name === "string" ? r.name : "" });
      }
      setLanCandidates(rows);
      // The remembered choice wins where it is still offerable; otherwise the first real one.
      setLanChoice((cur) => {
        const wanted = cur ?? remembered;
        if (wanted !== null && rows.some((r) => r.address === wanted)) return wanted;
        return rows[0]?.address ?? null;
      });
    } catch {
      if (alive.current) setLanCandidates(null);
    }
  }, []);

  const flipLanDraft = (next: boolean): void => {
    setLanDraft(next);
    if (next && lanCandidates === undefined) void loadLanCandidates(host?.lan ?? null);
  };

  const arm = async (withLan: boolean): Promise<void> => {
    const fallback = host?.port ?? DEFAULT_HOST_PORT;
    // The WHOLE string must be the number: `parseInt` alone accepts a numeric prefix, so
    // "6245x" would arm 6245 and "12.5" would arm port 12 — a validation that edits the value
    // it validates. Refused beside the field instead.
    const trimmed = portDraft?.trim();
    if (trimmed !== undefined && !/^\d{1,5}$/.test(trimmed)) {
      setProblem(t("portInvalid"));
      return;
    }
    const typed = trimmed === undefined ? fallback : Number.parseInt(trimmed, 10);
    if (!Number.isInteger(typed) || typed < 1 || typed > 65535) {
      setProblem(t("portInvalid"));
      return;
    }
    const lanAddress = withLan ? lanChoice : null;
    if (withLan && lanAddress === null) {
      // The option is on and there is nothing chosen — arming would silently drop the half the
      // person just asked for, which is the pane lying by omission.
      setProblem(t("lanNone"));
      return;
    }
    setBusy("arm");
    setProblem(null);
    try {
      const state = await armHostMode(typed, autostartDraft, lanAddress);
      if (!alive.current) return;
      setHost(state);
      if (state?.enabled) await refreshLists();
    } catch (err) {
      if (alive.current) setProblem(sentence(err));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const disarm = async (): Promise<void> => {
    setBusy("disarm");
    setProblem(null);
    try {
      const state = await disarmHostMode();
      if (!alive.current) return;
      setHost(state);
      setConfirmOff(false);
      setMinted(null);
      setMints([]);
      setDevices([]);
      if (state && !state.enabled) {
        const seen = await tailscaleStatus();
        if (alive.current) setProbe(seen);
      }
    } catch (err) {
      /* The real command can REJECT after the runtime already stood down (the settings write
         failed last, past the withdrawal). Keeping the serving snapshot would leave this pane
         claiming service — QR button and all — over a shell that is off. The ground truth is
         whatever `host_state` answers now; the rejection's sentence is set AFTER the re-read,
         which clears `problem` on its way in. */
      if (!alive.current) return;
      setConfirmOff(false);
      setMinted(null);
      try {
        const state = await hostState();
        if (!alive.current) return;
        setHost(state);
        if (state && !state.enabled) {
          setMints([]);
          setDevices([]);
          const seen = await tailscaleStatus();
          if (alive.current) setProbe(seen);
        }
      } catch {
        /* the sentence below is the whole answer */
      }
      if (alive.current) setProblem(sentence(err));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const mint = async (): Promise<void> => {
    // The link's base: the served tailnet origin where there is one (the browser flow), else
    // the LAN address (the app/API flow — this door's only public bootstrap is /pair/redeem).
    // The same-network address is `https` and carries this computer's key: it used to be
    // `http://…`, the whole reason LAN pairing never worked on a shipped phone build (a
    // release app permits no cleartext). No certificate authority vouches for a DHCP
    // address, so the CEREMONY carries the trust — the fingerprint goes in the link, the
    // phone pins it, and a key that is not that key is refused.
    const lanBase = host?.lan && host?.port ? `https://${host.lan}:${host.port}` : null;
    const origin = host?.origin ?? lanBase;
    if (!origin) return;
    setBusy("mint");
    setProblem(null);
    try {
      // The pin is read at MINT time rather than held from the opening read: the key is the
      // engine's, the engine can have been respawned since this pane mounted, and a link built
      // from a stale fingerprint is a pairing that dies at the handshake with nothing to see.
      // Only the same-network address needs one — a tailnet origin is a real name with a real
      // certificate that the phone's own trust store checks.
      let pin: string | null = null;
      if (origin === lanBase) {
        const pinRes = await bridgeFetch("/local/lan/pin");
        if (!alive.current) return;
        const pinBody = pinRes.ok
          ? ((await pinRes.json()) as { fingerprint?: unknown })
          : {};
        pin = typeof pinBody.fingerprint === "string" && isPairPin(pinBody.fingerprint)
          ? pinBody.fingerprint
          : null;
        // NO PIN, NO LINK. A same-network link without one would be a QR the phone must either
        // refuse (the good case) or trust blindly (the bad one). Refusing here says which of
        // the two happened, on the machine that can do something about it.
        if (pin === null) {
          setProblem(t("mintNoPin"));
          return;
        }
      }
      const label = labelDraft.trim();
      const res = await bridgeFetch("/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(label ? { grant: "device-pair", label } : { grant: "device-pair" }),
      });
      if (!alive.current) return;
      if (!res.ok) {
        setProblem(await refusalText(res));
        return;
      }
      const out = (await res.json()) as { token?: unknown; label?: unknown };
      if (typeof out.token !== "string" || out.token.length === 0) {
        setProblem(t("mintNoToken"));
        return;
      }
      /* The link, assembled ONCE, here, through the shape the PHONE parses — one definition in
         `@ohmail/client-engine`, so a composer/parser drift is not expressible. */
      setMinted({
        link: pairLink(origin, out.token, pin),
        label: typeof out.label === "string" ? out.label : "",
      });
      setLabelDraft("");
      await refreshLists();
    } catch (err) {
      if (alive.current) setProblem(sentence(err));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const revokeMint = async (id: string): Promise<void> => {
    setBusy(`revoke:${id}`);
    setProblem(null);
    try {
      const res = await bridgeFetch(`/pair/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!alive.current) return;
      // 404 is every kind of already-gone — the row leaves the list either way.
      if (!res.ok && res.status !== 404) {
        setProblem(await refusalText(res));
        return;
      }
      report(t("revoked"));
      await refreshLists();
    } catch (err) {
      if (alive.current) setProblem(sentence(err));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const removeDevice = async (id: string): Promise<void> => {
    setBusy(`remove:${id}`);
    setProblem(null);
    try {
      const res = await bridgeFetch(`/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!alive.current) return;
      if (!res.ok && res.status !== 404) {
        setProblem(await refusalText(res));
        return;
      }
      setRemoving(null);
      report(t("removed"));
      await refreshLists();
    } catch (err) {
      if (alive.current) setProblem(sentence(err));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const flipAutostart = async (next: boolean): Promise<void> => {
    setBusy("autostart");
    try {
      const answer = await setAutostart(next);
      if (!alive.current) return;
      setHost((cur) => (cur ? { ...cur, autostart: answer } : cur));
    } catch (err) {
      if (alive.current) setProblem(sentence(err));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const copy = (): void => {
    if (!minted) return;
    const link = minted.link;
    // The toast speaks only after the write fulfilled — the Invites pane's rule, for the same
    // reason: the link is deliberately printed nowhere, so a false "copied" strands the person.
    void (async () => {
      try {
        await navigator.clipboard.writeText(link);
        if (alive.current) report(t("copied"));
      } catch {
        if (alive.current) setProblem(t("copyFailed"));
      }
    })();
  };

  /** Copy the same-network address. Same fulfilled-first rule as the pairing link's copy. */
  const copyLan = (address: string): void => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(address);
        if (alive.current) report(t("copied"));
      } catch {
        if (alive.current) setProblem(t("copyFailed"));
      }
    })();
  };

  /* The same-network chooser — the ceremony's opt-in row plus, once open, the engine's own
     enumeration as a choice. Rendered by BOTH ceremonies (the Tailscale-ready one and the
     no-Tailscale one), because the choice is the same choice. */
  const lanChooser = (
    <>
      <SettingLine
        label={t("lanOption")}
        description={t("lanOptionWhy")}
      >
        <Switch on={lanDraft} label={t("lanOption")} onChange={flipLanDraft} />
      </SettingLine>
      {lanDraft ? (
        lanCandidates === undefined ? (
          <SettingNote>{t("checking")}</SettingNote>
        ) : lanCandidates === null ? (
          <RefusalLine alert>{t("lanListFailed")}</RefusalLine>
        ) : lanCandidates.length === 0 ? (
          <RefusalLine alert>{t("lanNone")}</RefusalLine>
        ) : (
          <SettingLine
            label={t("lanPick")}
            description={t("lanPickWhy")}
          >
            <NativeSelect
                aria-label={t("lanPick")}
                value={lanChoice ?? ""}
                onChange={(e) => setLanChoice(e.target.value)}
              >
                {lanCandidates.map((c) => (
                  <option key={c.address} value={c.address}>
                    {c.name ? `${c.address} (${c.name})` : c.address}
                  </option>
                ))}
              </NativeSelect>
          </SettingLine>
        )
      ) : null}
    </>
  );

  const day = (iso: string): string =>
    iso ? format.dateTime(new Date(iso), { dateStyle: "medium" }) : "";
  const moment = (iso: string): string =>
    iso ? format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" }) : "";

  // The full device vocabulary — phones now declare mobile-android / mobile-ios at the redeem,
  // so the pane says what actually paired; an unknown kind keeps the generic word.
  const kindWord = (kind: string): string => {
    switch (kind) {
      case "web": return t("kindWeb");
      case "macos": case "desktop-macos": return t("kindMac");
      case "desktop-linux": return t("kindLinux");
      case "desktop-windows": return t("kindWindows");
      case "mobile-android": return t("kindAndroid");
      case "mobile-ios": return t("kindIos");
      default: return t("kindOther");
    }
  };

  /* ── The ladder, told from the top ─────────────────────────────────────────────────────── */

  // Not asked yet — one quiet line, no guessing.
  if (host === undefined) {
    return (
      <SettingsSheet title={t("title")}>
        <SettingNote>{t("checking")}</SettingNote>
      </SettingsSheet>
    );
  }

  // No shell (a dev server, the render check) — the honest sentence, not an error.
  if (host === null) {
    return (
      <SettingsSheet title={t("title")}>
        <SettingNote>{t("lead")}</SettingNote>
        <SettingNote>{t("notAvailable")}</SettingNote>
      </SettingsSheet>
    );
  }

  if (!host.enabled) {
    /* OFF — the explainer, the one-sentence Tailscale story, and detect-and-guide: the probe
       decides whether what renders next is the one step in the way or the enable ceremony. */
    const guiding = probe !== undefined && probe !== null && probe.state !== "running";
    /* An OFF `host_state` still CARRIES a problem, and it must be honored over a clean-looking
       probe: a disarm whose tailnet withdrawal was refused stands down anyway and answers OFF
       with `serve-refused` (the old registration may still exist), and an arm the shell refused
       pre-serve answers OFF with that attempt's problem. Rendered as the guided sentence — the
       same closed vocabulary — with the ceremony left standing below it where the probe allows,
       because arming again re-publishes and IS a real way out. Suppressed only when the probe's
       own guidance would say the same sentence twice. */
    const offProblem =
      host.problem !== null && (!guiding || guideKey(probe.state) !== guideKey(host.problem))
        ? guideKey(host.problem)
        : null;
    const ready = probe !== undefined && probe !== null && probe.state === "running";
    return (
      <>
      <SettingsSheet title={t("thisComputer")} sign="desktop" aside={<Tag>{t("hostOff")}</Tag>}>
        <SettingNote>{t("lead")}</SettingNote>
        <SettingNote>{t("story")}</SettingNote>

        {problem ? (
          <RefusalLine alert>{problem}</RefusalLine>
        ) : null}

        {offProblem ? (
          <RefusalLine alert>{t(offProblem)}</RefusalLine>
        ) : null}

        {/* THE STAND-DOWN THAT COULD NOT BE RECORDED. Hosting IS off — the shell takes the
            listener away before it writes anything — and the setting on disk still says on, so
            the next start would bring hosting back. The shell composes this one because it
            carries the write's own reason; everything else on this pane is a mapped word. */}
        {host.notice ? (
          <RefusalLine alert>{host.notice}</RefusalLine>
        ) : null}

        {probe === undefined ? <SettingNote>{t("checking")}</SettingNote> : null}

        {probe === null ? (
          /* The shell answered nothing readable about the tailnet — said as a fact about the
             check, with the re-probe right there. Never a dead end. */
          <>
            <SettingNote>{t("probeFailed")}</SettingNote>
            <SettingActs>
              <Button kind="two" onPress={() => void refresh()} disabled={busy !== null}>
                {t("checkAgain")}
              </Button>
            </SettingActs>
          </>
        ) : null}

        {guiding ? (
          <>
            <SettingNote>{t(guideKey(probe.state))}</SettingNote>
            <SettingActs>
              {probe.state === "no-cli" ? (
                <Button kind={lanDraft ? "quiet" : "ink"} onPress={() => void openTailscaleDownload()}>
                  {t("getTailscale")}
                </Button>
              ) : null}
              <Button kind="two" onPress={() => void refresh()} disabled={busy !== null}>
                {t("checkAgain")}
              </Button>
            </SettingActs>
            {/* THE NO-TAILSCALE PATH. The guided step above stays the recommendation — it is
                what gives a phone BROWSER a working, encrypted address — but same-network
                access does not owe its existence to it, so the option is offered here too,
                with the honest limitation in its own words (apps only; a browser needs the
                Tailscale address, because browsers require HTTPS for a network address). */}
            <SettingLine label={t("lanAlone")} description={t("lanAloneWhy")} />
            {lanChooser}
            {lanDraft ? (
              <>
                {/* The ruled ceremony line, in THIS ceremony too: start-at-login is a visible,
                    default-checked choice wherever host mode can be enabled — arming must never
                    register a login item off a default nobody saw. */}
                {autostartRow(
                  <Switch
                    on={autostartDraft}
                    label={t("autostart")}
                    onChange={setAutostartDraft}
                  />,
                  t("autostartWhy"),
                )}
              </>
            ) : null}
          </>
        ) : null}

        {ready ? (
          /* The port is a fact until Advanced opens its editor. */
          <>
            <SettingNote>{t("ready", { name: probe.dnsName })}</SettingNote>
            {autostartRow(
              <Switch
                on={autostartDraft}
                label={t("autostart")}
                onChange={setAutostartDraft}
              />,
              t("autostartWhy"),
            )}
            {lanChooser}
            {advanced ? (
              <SettingLine
                label={t("port")}
                description={t("portWhy")}
              >
                <Field bare label={t("port")} inputMode="numeric"
                  value={portDraft ?? String(host.port ?? DEFAULT_HOST_PORT)} onChange={setPortDraft} />
              </SettingLine>
            ) : <SettingLine label={t("port")} value={String(host.port ?? DEFAULT_HOST_PORT)} />}
          </>
        ) : null}
      </SettingsSheet>
      {guiding && lanDraft ? (
        <SettingActs>
          <Button kind="ink" onPress={() => void arm(true)} disabled={busy !== null}>
            {busy === "arm" ? t("enabling") : t("lanEnable")}
          </Button>
        </SettingActs>
      ) : null}
      {ready ? (
        <SettingActs>
          <Button kind="ink" onPress={() => void arm(lanDraft)} disabled={busy !== null}>
            {busy === "arm" ? t("enabling") : t("enable")}
          </Button>
          {!advanced ? <Button kind="quiet" onPress={() => setAdvanced(true)}>{t("advanced")}</Button> : null}
        </SettingActs>
      ) : null}
      </>
    );
  }

  /* ON — serving, or armed with something in the way. */
  const serving = host.state === "serving" && host.origin !== null;
  /* The LAN-only install (no tailnet identity) whose LAN door holds its socket: degraded above,
     serving here — and it must still be able to MINT, because the bearer-only door's one public
     bootstrap is the pairing redeem. Without this, the pane would hand out an address nothing
     can ever authenticate against. */
  /* `blocked` counts as up here, and deliberately: the door holds its socket, the address is the
     right one, and the only thing missing is a firewall rule the operator opens in one command.
     Hiding the mint behind that would make the pane a dead end at the exact moment it is telling
     somebody how to get out of it — they would open the port and find nothing to pair with. */
  const lanUp = host.lanState === "serving" || host.lanState === "blocked";
  const lanOnlyServing = !serving && host.lan !== null && lanUp && host.port !== null;

  return (
    <>
      <SettingsSheet title={t("thisComputer")} sign="desktop" aside={<Tag>{t(serving ? "hostServing" : "hostNotServing")}</Tag>}>

        {problem ? (
          <RefusalLine alert>{problem}</RefusalLine>
        ) : null}

        {serving ? (
          <SettingLine label={t("reachAt")} value={host.origin ?? ""} description={t("servingDetail")}>
            <Button kind="quiet" size="s" icon="copy" onPress={() => copyLan(host.origin ?? "")}>{t("copyOrigin")}</Button>
          </SettingLine>
        ) : (
          /* DEGRADED — armed, not serving, one guided sentence for the one thing in the way.
             `guideKey(null)` is the unknown-problem arm: a shell ahead of this bundle degrades to
             generic guidance, never to a raw code (the pane renders no problem name, ever). */
          <>
            <SettingNote>{t(guideKey(host.problem))}</SettingNote>
            <SettingActs>
              {host.problem === "no-cli" ? (
                <Button kind={lanOnlyServing ? "quiet" : "ink"} onPress={() => void openTailscaleDownload()}>
                  {t("getTailscale")}
                </Button>
              ) : null}
              <Button kind="two" onPress={() => void refresh()} disabled={busy !== null}>
                {t("checkAgain")}
              </Button>
            </SettingActs>
          </>
        )}

        {/* `autostart: null` is the platform declining to say — a fact, not "off". The row says so
            instead of drawing an off-position switch over an unknown; the switch stays, because
            flipping it WRITES a definite state either way. On an install that cannot hold a login
            item at all there is no switch to draw — `autostartRow` answers that. */}
        {autostartRow(
          <Switch
            on={host.autostart === true}
            label={t("autostart")}
            onChange={(v) => void flipAutostart(v)}
          />,
          host.autostart === null ? t("autostartUnknown") : t("autostartWhy"),
        )}

        {host.port !== null ? <SettingLine label={t("port")} value={String(host.port)} /> : null}
      </SettingsSheet>

        {serving || lanOnlyServing ? (
          minted ? (
            <SettingsSheet>
              <SettingNote>
                {serving
                  ? minted.label
                    ? t("mintedLeadFor", { name: minted.label })
                    : t("mintedLead")
                  : t("lanMintedLead")}
              </SettingNote>
              {/* ── THE QR IS DRAWN IN BOTH MODES NOW, AND LAN-ONLY IS THE CASE THAT NEEDS IT.
                  The old tailnet-only argument ("a camera scan opens a phone browser, and this
                  door refuses browsers") was about the OS camera app; the ohmail app has its
                  own scanner, and the app is precisely the client this door exists for. What
                  made it necessary is the pin: a same-network link carries the door's
                  43-character key fingerprint, and nobody re-types that onto a phone. The copy
                  button hands the link to something that can paste; the QR hands it to the
                  camera — both, or the ceremony has no path ending with a paired phone. The
                  raw link is still printed nowhere. */}
              <CodeTile>
                <QrCode value={minted.link} ariaLabel={t("qrAria")} />
              </CodeTile>
              <SettingActs>
                <Button kind="quiet" size="s" icon="copy" onPress={copy}>
                  {t("copyLink")}
                </Button>
                {/* Done also re-reads the lists: in the ordinary scan-then-Done sequence the code
                    was just consumed and the paired device just appeared, and this dismissal is
                    the only moment the serving view naturally refreshes. */}
                <Button
                  kind={confirmOff ? "two" : "ink"}
                  onPress={() => {
                    setMinted(null);
                    void refreshLists();
                  }}
                >
                  {t("mintedDone")}
                </Button>
              </SettingActs>
              <SettingNote>{t("mintedOnce")}</SettingNote>
            </SettingsSheet>
          ) : (
            <SettingsSheet>
              {/* The add-a-device row — the Invites mint's shape: the (optional) name is the one
                  input, the button is the verb, Enter submits. */}
              <Field
                bare label={t("addFor")} placeholder={t("addFor")} value={labelDraft}
                hint={serving ? t("addHint") : t("lanAddHint")} maxLength={100} onChange={setLabelDraft}
                onEnter={() => { if (busy === null) void mint(); }}
              />
            </SettingsSheet>
          )
        ) : null}

      {/* SAME-NETWORK ACCESS — rendered whenever it is chosen, independent of the tailnet half:
          a LAN-only install (the no-Tailscale path) is degraded above and serving here, and
          both sentences are true at once. The copy is the honest one the API-only decision requires:
          the API for apps, the awake qualifier, and the plain reason a phone browser still
          needs the Tailscale address. */}
      {host.lan !== null ? (
        <SettingsSheet
          title={t("lanTitle")}
          aside={<Tag>{t(host.lanState === "serving" ? "hostServing"
            : host.lanState === "pending" ? "hostStarting" : "hostNotServing")}</Tag>}
        >
          <SettingLine label={t("lanOption")} toggle={{ on: true }} off />
          <SettingNote>
            {host.lanState === "serving" && host.port !== null
              ? t("lanServingDetail", { port: host.port })
              : host.lanState === "blocked" && host.port !== null
                ? t("lanBlocked", { address: `https://${host.lan}:${host.port}`, port: host.port })
                : host.lanState === "failed"
                  ? t("lanFailed")
                  : host.lanState === "invalid"
                    ? t("lanInvalid")
                    : t("lanPending")}
          </SettingNote>
          {/* THE HONEST-STATE ARM. The engine reached this state by READING the firewall's own
              files — never by probing itself, which on Linux is routed over `lo` and answers
              happily through a closed firewall (see `apps/sidecar/src/host-firewall.ts`). The
              command is composed here rather than carried on the wire because `blocked` has
              exactly one producer: the ufw reader. If a second firewall is ever read, the remedy
              has to travel with the state instead of being assumed from it. */}
          {host.lanState === "blocked" && host.port !== null ? (
            <>
              <RefusalLine alert>{t("lanBlockedFix")}</RefusalLine>
              <CodeText>{`sudo ufw allow ${host.port}/tcp`}</CodeText>
              <SettingActs>
                <Button kind="two" onPress={() => void refresh()} disabled={busy !== null}>
                  {t("checkAgain")}
                </Button>
              </SettingActs>
            </>
          ) : null}
          {lanUp && host.port !== null ? (
            <SettingLine
              label={t("lanPick")}
              value={`https://${host.lan}:${host.port}`}
              description={lanKey === null ? t("lanBrowserNote") : undefined}
            >
              <Button kind="quiet" size="s" icon="copy" onPress={() => copyLan(`https://${host.lan}:${host.port}`)}>
                {t("lanCopy")}
              </Button>
            </SettingLine>
          ) : null}
          {/* ── THE OTHER HALF OF THE COMPARISON ────────────────────────────────────────
              A device pairing over this network shows twelve characters of this key before it
              pairs, and the whole value of that step is that somebody can check them against
              something. This is that something. It is only rendered where a pin is actually in
              play — a tailnet origin carries a real certificate and no pin at all, so a key row
              there would invite a comparison against a value nothing shows. */}
          {lanKey !== null ? (
            <SettingLine
              label={t("keyLabel")}
              value={shortPin(lanKey)}
              description={lanUp && host.port !== null ? t("keyWhy") + " " + t("lanBrowserNote") : t("keyWhy")}
            />
          ) : null}
        </SettingsSheet>
      ) : null}

      {/* In EVERY armed state, not only serving: disarming does not revoke pairing tokens and
          the stdio routes stay mounted while armed, so a code minted before a degradation must
          keep its take-back here — or it quietly comes back to life when serving recovers. */}
      {mints.length > 0 ? (
        <SettingsSheet title={t("codesTitle")} aside={mints.length}>
          {mints.map((m) => (
            <SettingLine
              key={m.id}
              label={m.label || t("codeFallback")}
              description={t("codeMeta", { expires: moment(m.expiresAt) })}
            >
              <Button kind="quiet" size="s" onPress={() => void revokeMint(m.id)} disabled={busy === `revoke:${m.id}`}>
                {busy === `revoke:${m.id}` ? t("working") : t("revoke")}
              </Button>
            </SettingLine>
          ))}
        </SettingsSheet>
      ) : null}

      {devices.length > 0 ? (
        <SettingsSheet title={t("devicesTitle")} aside={devices.length}>
          {devices.map((d) =>
            removing === d.id ? (
              <SettingLine
                key={d.id}
                label={t("removeAsk", { name: d.label || kindWord(d.kind) })}
                description={t("removeWhat")}
              >
                <Button
                  kind="ink"
                  onPress={() => void removeDevice(d.id)}
                  disabled={busy === `remove:${d.id}`}
                >
                  {busy === `remove:${d.id}` ? t("working") : t("remove")}
                </Button>
                <Button kind="quiet" onPress={() => setRemoving(null)}>
                  {t("cancel")}
                </Button>
              </SettingLine>
            ) : (
              <SettingLine
                key={d.id}
                label={d.label || kindWord(d.kind)}
                description={t("deviceMeta", {
                  kind: kindWord(d.kind),
                  created: day(d.createdAt),
                  seen: day(d.lastSeenAt),
                })}
              >
                <Button kind="quiet" size="s" onPress={() => setRemoving(d.id)}>{t("remove")}</Button>
              </SettingLine>
            ),
          )}
        </SettingsSheet>
      ) : null}

      {confirmOff ? (
        <SettingLine label={t("offAsk")} description={t("offWhat")}>
          <Button kind="ink" onPress={() => void disarm()} disabled={busy === "disarm"}>
            {busy === "disarm" ? t("offing") : t("off")}
          </Button>
          <Button kind="quiet" onPress={() => setConfirmOff(false)} disabled={busy === "disarm"}>
            {t("cancel")}
          </Button>
        </SettingLine>
      ) : <p className="oh-text">{t("offHint")}</p>}
      <SettingActs>
        {(serving || lanOnlyServing) && !minted ? (
          <Button kind={confirmOff ? "two" : "ink"} onPress={() => void mint()} disabled={busy === "mint"}>
            {busy === "mint" ? t("working") : t("addAction")}
          </Button>
        ) : null}
        {!confirmOff ? (
          <Button kind="two" onPress={() => setConfirmOff(true)} disabled={busy === "disarm"}>
            {t("off")}
          </Button>
        ) : null}
      </SettingActs>
    </>
  );
}
