/**
 * SETTINGS → DEVICES — host mode's whole surface: turn this computer into the household's mail
 * server, pair a phone by pointing its camera at the screen, see what is paired, take one back.
 *
 * The design bar this pane is held to is the password-manager one, not the SSH one: every state
 * is a sentence and one action, never a stack trace, never a code. The ladder is detect-and-guide
 * — the pane asks the shell what is true (`tailscale_status`, `host_state`) and renders the one
 * step that is actually in the way, with the button that takes it. Nothing here instructs and
 * hopes.
 *
 * ── WHERE EACH VERB GOES ─────────────────────────────────────────────────────────────────────
 *
 * Arming, disarming, probing the tailnet and start-at-login are SHELL commands (`src/host.ts`) —
 * the `tailscale` binary and the login registration are process-level facts only the shell can
 * touch. The pairing ceremony and the device list are ENGINE requests over the bridge
 * (`bridgeFetch`): `POST/GET/DELETE /pair` and `GET/DELETE /devices`, mounted on the stdio door
 * only while host mode is armed — so this pane loads them only then, and a disarmed engine never
 * sees a request it would 404.
 *
 * ── THE PAIRING LINK'S SHAPE, AND THE ONE APPEARANCE OF THE RAW TOKEN ────────────────────────
 *
 * The QR encodes `${origin}/pair#<raw-device-pair-token>` — the fragment-link idiom the Invites
 * pane established, for the reasons its header carries: a fragment is not sent in the page
 * request, cannot land in a log, and never rides a `Referer`. The raw token appears exactly once
 * (this mint's answer), as a QR and behind a copy button, and is NEVER printed: a hundred
 * characters of credential is exactly the thing the design rules say never to show where a scan
 * or a copy would do. The engine stores only a hash; the code works once and expires in five
 * minutes; the list below carries metadata only.
 *
 * ── WHY THE WINDOW'S OWN SESSION IS NOT IN THE DEVICE LIST ───────────────────────────────────
 *
 * `GET /devices` answers every live session, including the launch session this window itself is
 * asking over — which is not a paired device and must not render as one ("Remove" on it would be
 * the window revoking itself). The launch session is exactly the row the engine marks `current`,
 * so the list renders the rows that are NOT current: the paired phones and browsers, each with a
 * name, a date, and a take-back.
 *
 * ── THE COPY BAR ─────────────────────────────────────────────────────────────────────────────
 *
 * "While this computer is awake" — never an unqualified "always on". The serving line carries the
 * qualifier verbatim, and the catalogue test pins it in both languages: a laptop lid ends the
 * service until it opens again, and a pane that promised otherwise would be lying about the one
 * limit a household will actually meet.
 *
 * ── SAME-NETWORK ACCESS, AND WHY ITS COPY SAYS "APPS ONLY" ──────────────────────────────────
 *
 * The LAN option binds one operator-chosen interface, plain HTTP — and plain HTTP on a network
 * address is no secure context, so the browser client CANNOT be served there (the audit is
 * `apps/sidecar/src/host-lan.ts`'s header; the premise is pinned by
 * `test/host-client-secure-context.test.ts`). The pane's copy therefore promises the API for
 * apps and says plainly that a phone browser needs the Tailscale address — truthful over
 * flattering, because a QR that opened a broken mail client would be worse than a sentence. The
 * option is opt-in (default off), the address is CHOSEN from the engine's own enumeration
 * (`GET /local/lan/candidates` over the bridge — never typed, never 0.0.0.0), and it is also
 * the no-Tailscale path: with a LAN address picked, enabling works without any tailnet and the
 * pane reports the tailnet half's absence beside a serving same-network half.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Button, SettingsRow, SettingsSection, SettingsSubhead, Switch, useToast } from "@ohmail/ui";

import { bridgeFetch } from "./bridge-fetch.js";
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
 * THE GUIDED LADDER — every problem the shell can name, mapped to the one designed sentence and
 * nothing else. A closed vocabulary on both sides: `host.ts` parses the shell's answer against
 * `HOST_PROBLEMS` and degrades an unknown name to `null`, and this map takes `null` to the
 * generic guidance — so a shell one version ahead of this bundle gets a calm sentence, never a
 * raw code and never a blank. Exported so the test can hold the mapping cell for cell.
 *
 * The four tailnet-side names double as the OFF state's probe vocabulary (`tailscale_status`
 * answers the same words), which is why one map serves both moments: the sentence that is true
 * before enabling is the sentence that is true when the same thing breaks later.
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
  return res.statusText ? `${res.status} ${res.statusText}` : `The request was refused (${res.status}).`;
}

function sentence(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message || "Something went wrong and said nothing about what.";
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

export function DesktopDevices() {
  const t = useTranslations("host");
  const format = useFormatter();
  const toast = useToast();

  /** Host mode as the shell last reported it; `undefined` = not asked yet, `null` = no shell. */
  const [host, setHost] = useState<HostState | null | undefined>(undefined);
  /** The tailnet probe, read only while host mode is off. `undefined` = probing. */
  const [probe, setProbe] = useState<TailscaleStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState<Busy>(null);
  /** A refusal or a thrown transport, as one sentence beside the controls. Never a toast. */
  const [problem, setProblem] = useState<string | null>(null);

  /* The ceremony's choices. Autostart default-CHECKED and visible — the always-on role is
     the reason most people turn this on, and a hidden default would be a decision made for them
     in the dark. The port is advanced-only: defaulted, and shown only to whoever asks. The LAN
     option is default-OFF — same-network access is an opt-in on top of host mode's opt-in. */
  const [autostartDraft, setAutostartDraft] = useState(true);
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [lanDraft, setLanDraft] = useState(false);
  /** The engine's enumeration: `undefined` = loading, `null` = the read failed, `[]` = none. */
  const [lanCandidates, setLanCandidates] =
    useState<Array<{ address: string; name: string }> | null | undefined>(undefined);
  const [lanChoice, setLanChoice] = useState<string | null>(null);

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
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [refreshLists]);

  useEffect(() => {
    // The catch is the difference between a failed first read and an unhandled rejection: the
    // pane's answer to "the shell did not respond" is the retry below, not a console trace.
    void refresh().catch(() => undefined);
  }, [refresh]);

  /**
   * When the background read should run: while host mode is ON, and while this window has not
   * yet had a readable answer at all.
   *
   * The second half is a retry, not a poll, and it closes a dead end older than this screen's
   * polling: the mount read has no catch, so a shell call that rejects leaves `host` at
   * `undefined` and the pane sits on "Checking…" with no control to try again until it is
   * remounted. The boundary that matters is a CONFIRMED off state — that is the one place a
   * background read destroys information (see the effect below) — and "we have never heard
   * back" is not that.
   */
  const armed = host?.enabled === true;
  const pollHostState = armed || host === undefined;

  /**
   * KEEP THE OPEN PANE HONEST — re-read host state while this screen is on the display.
   *
   * The pane used to read once at mount and never again, and two states this screen exists to
   * report arrive AFTER that read. The engine's LAN door finishes binding a moment after the
   * window comes up, so the pane said "Same-network access is starting…" for the life of the
   * window over a door that was serving — and the pairing controls, which are gated on the
   * serving state, never appeared at all. Separately, the firewall warning names a command; the
   * engine re-checks after the operator runs it, but nothing was asking the shell for the result.
   *
   * A quiet poll, not a subscription, because the shell exposes state by command and the answer
   * is three integers and two strings. `busy` is deliberately NOT set: this must never make a
   * button look pressed or a screen flicker while somebody is reading it.
   *
   * **ONLY WHILE ARMED, and that gate is a fix rather than an optimisation.** Every state this
   * poll exists to catch — the LAN door binding, a firewall opening — happens on an ARMED
   * install. Polling while host mode is OFF actively destroys information: an arm the shell
   * refused answers with the CURRENT state (still off) plus that attempt's problem, and that
   * problem is the only thing on screen explaining why nothing happened. A plain `host_state` a
   * moment later does not carry it, so an unconditional poll wiped the explanation and left the
   * stale "Tailscale is ready" probe beside an Enable button that silently does nothing — the
   * exact silent-retry loop `desktop-devices.test.tsx` already guards. Off is driven by explicit
   * acts; there is nothing here to discover between them.
   */
  useEffect(() => {
    if (!pollHostState) return undefined;
    const tick = setInterval(() => {
      // NEVER HEARD BACK ⇒ redo the WHOLE first read, not just the host half. The ladder below
      // needs the tailnet probe too, and a retry that filled in only `host` would leave the pane
      // reporting off while still saying it was checking — a different half-answer in place of
      // the first one.
      if (host === undefined) {
        void refresh().catch(() => undefined);
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
  }, [pollHostState, host, refresh]);

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
    // the LAN address (the app/API flow — this door's only public bootstrap is /pair/redeem,
    // so a LAN-only install without a mint would be an address nothing can authenticate to).
    const origin =
      host?.origin ?? (host?.lan && host?.port ? `http://${host.lan}:${host.port}` : null);
    if (!origin) return;
    setBusy("mint");
    setProblem(null);
    try {
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
      /* The link, assembled ONCE, here — the fragment idiom; see the header. */
      setMinted({ link: `${origin}/pair#${out.token}`, label: typeof out.label === "string" ? out.label : "" });
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
      toast(t("revoked"));
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
      toast(t("removed"));
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
        if (alive.current) toast(t("copied"));
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
        if (alive.current) toast(t("copied"));
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
      <SettingsRow
        label={t("lanOption")}
        description={t("lanOptionWhy")}
        control={<Switch checked={lanDraft} ariaLabel={t("lanOption")} onChange={flipLanDraft} />}
      />
      {lanDraft ? (
        lanCandidates === undefined ? (
          <p className="set-note-inline">{t("checking")}</p>
        ) : lanCandidates === null ? (
          <p className="acct-warn" role="alert">
            {t("lanListFailed")}
          </p>
        ) : lanCandidates.length === 0 ? (
          <p className="acct-warn" role="alert">
            {t("lanNone")}
          </p>
        ) : (
          <SettingsRow
            label={t("lanPick")}
            description={t("lanPickWhy")}
            control={
              <select
                className="join-input set-tag-input"
                aria-label={t("lanPick")}
                value={lanChoice ?? ""}
                onChange={(e) => setLanChoice(e.target.value)}
              >
                {lanCandidates.map((c) => (
                  <option key={c.address} value={c.address}>
                    {c.name ? `${c.address} (${c.name})` : c.address}
                  </option>
                ))}
              </select>
            }
          />
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
      <SettingsSection className="acct">
        <h2 className="acct-h">{t("title")}</h2>
        <p className="acct-lead">{t("checking")}</p>
      </SettingsSection>
    );
  }

  // No shell (a dev server, the render check) — the honest sentence, not an error.
  if (host === null) {
    return (
      <SettingsSection className="acct">
        <h2 className="acct-h">{t("title")}</h2>
        <p className="acct-lead">{t("lead")}</p>
        <p className="set-note-inline">{t("notAvailable")}</p>
      </SettingsSection>
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
    return (
      <SettingsSection className="acct">
        <h2 className="acct-h">{t("title")}</h2>
        <p className="acct-lead">{t("lead")}</p>
        <p className="set-note-inline">{t("story")}</p>

        {problem ? (
          <p className="acct-warn" role="alert">
            {problem}
          </p>
        ) : null}

        {offProblem ? (
          <p className="acct-warn" role="alert">
            {t(offProblem)}
          </p>
        ) : null}

        {probe === undefined ? <p className="set-note-inline">{t("checking")}</p> : null}

        {probe === null ? (
          /* The shell answered nothing readable about the tailnet — said as a fact about the
             check, with the re-probe right there. Never a dead end. */
          <>
            <p className="acct-lead">{t("probeFailed")}</p>
            <div className="acct-actions">
              <Button onClick={() => void refresh()} disabled={busy !== null}>
                {t("checkAgain")}
              </Button>
            </div>
          </>
        ) : null}

        {guiding ? (
          <>
            <p className="acct-lead">{t(guideKey(probe.state))}</p>
            <div className="acct-actions">
              {probe.state === "no-cli" ? (
                <Button variant="primary" onClick={() => void openTailscaleDownload()}>
                  {t("getTailscale")}
                </Button>
              ) : null}
              <Button onClick={() => void refresh()} disabled={busy !== null}>
                {t("checkAgain")}
              </Button>
            </div>
            {/* THE NO-TAILSCALE PATH. The guided step above stays the recommendation — it is
                what gives a phone BROWSER a working, encrypted address — but same-network
                access does not owe its existence to it, so the option is offered here too,
                with the honest limitation in its own words (apps only; a browser needs the
                Tailscale address, because browsers require HTTPS for a network address). */}
            <SettingsSubhead>{t("lanAlone")}</SettingsSubhead>
            <p className="set-note-inline">{t("lanAloneWhy")}</p>
            {lanChooser}
            {lanDraft ? (
              <>
                {/* The ruled ceremony line, in THIS ceremony too: start-at-login is a visible,
                    default-checked choice wherever host mode can be enabled — arming must never
                    register a login item off a default nobody saw. */}
                <SettingsRow
                  label={t("autostart")}
                  description={t("autostartWhy")}
                  control={
                    <Switch
                      checked={autostartDraft}
                      ariaLabel={t("autostart")}
                      onChange={setAutostartDraft}
                    />
                  }
                />
                <div className="acct-actions">
                  <Button variant="primary" onClick={() => void arm(true)} disabled={busy !== null}>
                    {busy === "arm" ? t("enabling") : t("lanEnable")}
                  </Button>
                </div>
              </>
            ) : null}
          </>
        ) : null}

        {probe !== undefined && probe !== null && probe.state === "running" ? (
          /* READY — the enable ceremony. One reassuring fact, one visible default, one button.
             The port hides behind "Advanced" because nobody choosing between defaults should
             have to read about ports to turn their mail on. */
          <>
            <p className="acct-lead">{t("ready", { name: probe.dnsName })}</p>
            <SettingsRow
              label={t("autostart")}
              description={t("autostartWhy")}
              control={
                <Switch
                  checked={autostartDraft}
                  ariaLabel={t("autostart")}
                  onChange={setAutostartDraft}
                />
              }
            />
            {lanChooser}
            {advanced ? (
              <SettingsRow
                label={t("port")}
                description={t("portWhy")}
                control={
                  <input
                    className="join-input set-tag-input"
                    inputMode="numeric"
                    value={portDraft ?? String(host.port ?? DEFAULT_HOST_PORT)}
                    aria-label={t("port")}
                    onChange={(e) => setPortDraft(e.target.value)}
                  />
                }
              />
            ) : null}
            <div className="acct-actions">
              <Button variant="primary" onClick={() => void arm(lanDraft)} disabled={busy !== null}>
                {busy === "arm" ? t("enabling") : t("enable")}
              </Button>
              {!advanced ? (
                <Button variant="ghost" onClick={() => setAdvanced(true)}>
                  {t("advanced")}
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </SettingsSection>
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
    <SettingsSection className="acct">
      <h2 className="acct-h">{t("title")}</h2>

      {problem ? (
        <p className="acct-warn" role="alert">
          {problem}
        </p>
      ) : null}

      {serving ? (
        <p className="acct-lead">{t("serving", { origin: host.origin ?? "" })}</p>
      ) : (
        /* DEGRADED — armed, not serving, one guided sentence for the one thing in the way.
           `guideKey(null)` is the unknown-problem arm: a shell ahead of this bundle degrades to
           generic guidance, never to a raw code (the pane renders no problem name, ever). */
        <>
          <p className="acct-lead">{t(guideKey(host.problem))}</p>
          <div className="acct-actions">
            {host.problem === "no-cli" ? (
              <Button variant="primary" onClick={() => void openTailscaleDownload()}>
                {t("getTailscale")}
              </Button>
            ) : null}
            <Button onClick={() => void refresh()} disabled={busy !== null}>
              {t("checkAgain")}
            </Button>
          </div>
        </>
      )}

      {serving || lanOnlyServing ? (
        minted ? (
          <div className="acct-confirm">
            <p className="acct-lead">
              {serving
                ? minted.label
                  ? t("mintedLeadFor", { name: minted.label })
                  : t("mintedLead")
                : t("lanMintedLead")}
            </p>
            {/* The QR is the hand-over for the BROWSER flow — a camera on this screen — and the
                copy button is everything else. In LAN-only there is deliberately NO QR: a camera
                scan opens a phone browser, and this door refuses browsers by design, so the copy
                button is the whole hand-over. The raw link is printed nowhere either way. */}
            {serving ? (
              <div className="join-qr">
                <QrCode value={minted.link} ariaLabel={t("qrAria")} />
              </div>
            ) : null}
            <div className="acct-actions">
              <Button variant="primary" onClick={copy}>
                {t("copyLink")}
              </Button>
              {/* Done also re-reads the lists: in the ordinary scan-then-Done sequence the code
                  was just consumed and the paired device just appeared, and this dismissal is
                  the only moment the serving view naturally refreshes. */}
              <Button
                onClick={() => {
                  setMinted(null);
                  void refreshLists();
                }}
              >
                {t("mintedDone")}
              </Button>
            </div>
            <p className="acct-fine">{t("mintedOnce")}</p>
          </div>
        ) : (
          <>
            {/* The add-a-device row — the Invites mint's shape: the (optional) name is the one
                input, the button is the verb, Enter submits. */}
            <div className="set-row set-tag-edit invites-mint">
              <input
                className="join-input set-tag-input"
                value={labelDraft}
                placeholder={t("addFor")}
                aria-label={t("addFor")}
                maxLength={100}
                onChange={(e) => setLabelDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (busy === null) void mint();
                  }
                }}
              />
              <span className="set-tag-acts">
                <Button variant="primary" onClick={() => void mint()} disabled={busy === "mint"}>
                  {busy === "mint" ? t("working") : t("addAction")}
                </Button>
              </span>
            </div>
            <p className="set-note-inline">{serving ? t("addHint") : t("lanAddHint")}</p>
          </>
        )
      ) : null}

      {/* SAME-NETWORK ACCESS — rendered whenever it is chosen, independent of the tailnet half:
          a LAN-only install (the no-Tailscale path) is degraded above and serving here, and
          both sentences are true at once. The copy is the honest one the API-only decision requires:
          the API for apps, the awake qualifier, and the plain reason a phone browser still
          needs the Tailscale address. */}
      {host.lan !== null ? (
        <>
          <SettingsSubhead>{t("lanTitle")}</SettingsSubhead>
          <p className="acct-lead">
            {host.lanState === "serving" && host.port !== null
              ? t("lanServing", { address: `http://${host.lan}:${host.port}`, port: host.port })
              : host.lanState === "blocked" && host.port !== null
                ? t("lanBlocked", { address: `http://${host.lan}:${host.port}`, port: host.port })
                : host.lanState === "failed"
                  ? t("lanFailed")
                  : host.lanState === "invalid"
                    ? t("lanInvalid")
                    : t("lanPending")}
          </p>
          {/* THE HONEST-STATE ARM. The engine reached this state by READING the firewall's own
              files — never by probing itself, which on Linux is routed over `lo` and answers
              happily through a closed firewall (see `apps/sidecar/src/host-firewall.ts`). The
              command is composed here rather than carried on the wire because `blocked` has
              exactly one producer: the ufw reader. If a second firewall is ever read, the remedy
              has to travel with the state instead of being assumed from it. */}
          {host.lanState === "blocked" && host.port !== null ? (
            <>
              <p className="acct-warn" role="alert">
                {t("lanBlockedFix")}
              </p>
              <pre className="acct-cmd">{`sudo ufw allow ${host.port}/tcp`}</pre>
              <div className="acct-actions">
                <Button onClick={() => void refresh()} disabled={busy !== null}>
                  {t("checkAgain")}
                </Button>
              </div>
            </>
          ) : null}
          {lanUp && host.port !== null ? (
            <>
              <p className="set-note-inline">{t("lanBrowserNote")}</p>
              <div className="acct-actions">
                <Button onClick={() => copyLan(`http://${host.lan}:${host.port}`)}>
                  {t("lanCopy")}
                </Button>
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {/* In EVERY armed state, not only serving: disarming does not revoke pairing tokens and
          the stdio routes stay mounted while armed, so a code minted before a degradation must
          keep its take-back here — or it quietly comes back to life when serving recovers. */}
      {mints.length > 0 ? (
        <>
          <SettingsSubhead>{t("codesTitle")}</SettingsSubhead>
          {mints.map((m) => (
            <SettingsRow
              key={m.id}
              label={m.label || t("codeFallback")}
              description={t("codeMeta", { expires: moment(m.expiresAt) })}
              control={
                <span className="acct-row-act">
                  <Button onClick={() => void revokeMint(m.id)} disabled={busy === `revoke:${m.id}`}>
                    {busy === `revoke:${m.id}` ? t("working") : t("revoke")}
                  </Button>
                </span>
              }
            />
          ))}
        </>
      ) : null}

      {devices.length > 0 ? (
        <>
          <SettingsSubhead>{t("devicesTitle")}</SettingsSubhead>
          {devices.map((d) =>
            removing === d.id ? (
              <SettingsRow
                key={d.id}
                label={t("removeAsk", { name: d.label || kindWord(d.kind) })}
                description={t("removeWhat")}
                control={
                  <span className="set-tag-acts">
                    <Button
                      variant="primary"
                      className="danger"
                      onClick={() => void removeDevice(d.id)}
                      disabled={busy === `remove:${d.id}`}
                    >
                      {busy === `remove:${d.id}` ? t("working") : t("remove")}
                    </Button>
                    <Button variant="ghost" onClick={() => setRemoving(null)}>
                      {t("cancel")}
                    </Button>
                  </span>
                }
              />
            ) : (
              <SettingsRow
                key={d.id}
                label={d.label || kindWord(d.kind)}
                description={t("deviceMeta", {
                  kind: kindWord(d.kind),
                  created: day(d.createdAt),
                  seen: day(d.lastSeenAt),
                })}
                control={
                  <span className="acct-row-act">
                    <Button onClick={() => setRemoving(d.id)}>{t("remove")}</Button>
                  </span>
                }
              />
            ),
          )}
        </>
      ) : null}

      <SettingsSubhead>{t("runningTitle")}</SettingsSubhead>

      <SettingsRow
        label={t("autostart")}
        /* `autostart: null` is the platform declining to say — a fact, not "off". The row says
           so instead of drawing an off-position switch over an unknown; the switch stays,
           because flipping it WRITES a definite state either way. */
        description={host.autostart === null ? t("autostartUnknown") : t("autostartWhy")}
        control={
          <Switch
            checked={host.autostart === true}
            ariaLabel={t("autostart")}
            onChange={(v) => void flipAutostart(v)}
          />
        }
      />

      {confirmOff ? (
        <SettingsRow
          label={t("offAsk")}
          description={t("offWhat")}
          control={
            <span className="set-tag-acts">
              <Button
                variant="primary"
                className="danger"
                onClick={() => void disarm()}
                disabled={busy === "disarm"}
              >
                {busy === "disarm" ? t("offing") : t("off")}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmOff(false)} disabled={busy === "disarm"}>
                {t("cancel")}
              </Button>
            </span>
          }
        />
      ) : (
        <SettingsRow
          label={t("off")}
          description={t("offHint")}
          control={
            <Button onClick={() => setConfirmOff(true)} disabled={busy === "disarm"}>
              {t("off")}
            </Button>
          }
        />
      )}
    </SettingsSection>
  );
}
