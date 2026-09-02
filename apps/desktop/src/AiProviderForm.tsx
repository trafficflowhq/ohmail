/**
 * THE MODEL THIS INSTALL USES — the form, on its own, so two surfaces can ask the same question.
 *
 * Settings → Desktop renders it, and so does the first-run flow's provider step. That is the whole
 * reason it is a file: the alternative is a second form over `/local/ai`, and two write paths to
 * one settings file is how the two disagree about which vendor a key belongs to. It takes no
 * `door`, no pane, no navigation — everything it needs comes back from the engine on every read
 * and write, and everything it says comes from the `aiProvider` catalogue.
 *
 * ── WHAT THIS COMPONENT IS NOT ALLOWED TO DECIDE ────────────────────────────────────────────
 *
 * Whether the model works, which models exist, and where message content goes. All three come from
 * the engine. A form that decided "available" for itself would show a working model to somebody
 * whose key was revoked last night; a form that offered a model list of its own would offer names
 * the endpoint does not have. The `<select>`s below are filled from `probe.models` and from
 * nothing else, which is why they are empty until a test has run — honest, rather than a list of
 * plausible ids typed from memory.
 *
 * ── THERE IS NO ADDRESS FIELD, AND THAT IS DELIBERATE ───────────────────────────────────────
 *
 * The endpoint a provider is reached at selects where message content is sent, so it is a literal
 * the engine holds rather than something this window offers to change. What the form does instead
 * is NAME the address the engine actually holds (`settings.ollama.baseUrl`), because an install
 * that stored a different one while the field existed still holds it — so the sentence is read off
 * the status, and the "nothing leaves this computer" half is a separate sentence that renders only
 * when that origin is loopback. "Forget the provider and keys" restores the default.
 *
 * ── AND THE KEY IS NEVER ON SCREEN ──────────────────────────────────────────────────────────
 *
 * Nothing reads a stored key back — not this form, not the engine's own status. The field is
 * write-only: empty every time the form opens, and leaving it empty keeps whatever is stored.
 * "A key is stored" is the whole of what is ever said about it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Button,
  SettingsActions,
  SettingsChoice,
  SettingsField,
  SettingsNote,
  SettingsRow,
  SettingsSubhead,
  SettingsVerdict,
  type SettingsVerdictState,
} from "@ohmail/ui";

import { agoStamp } from "../../webapp/app/shell/format.js";
import {
  clearAiProvider,
  readAiStatus,
  saveAiSettings,
  verifyAiProvider,
  type AiProviderKind,
  type LocalAiStatus,
  type LocalAiWrite,
} from "./local-ai.js";

/** The four choices, including the one that is not a provider. */
export type AiChoice = "none" | AiProviderKind;

/** The two that take a key of your own. */
type KeyedKind = "anthropic" | "openai";

const VENDOR: Record<AiProviderKind, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  ollama: "Ollama",
};

/**
 * WHERE EACH HOSTED VENDOR IS REACHED, as a literal.
 *
 * Named in the consequence line under each option so the choice states its own cost — a key of
 * yours, billed to you, and this host is what your mail's sender and subject are sent to. Neither
 * is settable anywhere in the product; they are here so the sentence can be checked against the
 * transport, not so the transport can be pointed elsewhere.
 */
const VENDOR_HOST: Record<KeyedKind, string> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
};

type Copy = ReturnType<typeof useTranslations<"aiProvider">>;

function isKeyed(choice: AiChoice): choice is KeyedKind {
  return choice === "anthropic" || choice === "openai";
}

/** The host part of the engine's stored Ollama origin, or the raw value when it will not parse. */
export function ollamaHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Whether the stored Ollama origin is on this computer.
 *
 * The engine reports `contentGoesTo: "this_machine"` for Ollama whatever the address is, so the
 * "nothing leaves this computer" claim cannot be taken from it. This is the check that makes that
 * sentence true, and it is narrow on purpose: anything that is not plainly loopback gets the other
 * sentence, which names the host and says it is elsewhere.
 */
export function ollamaIsLocal(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * THE VERDICT BLOCK'S CONTENT, from the engine's status — one derivation, every outcome named.
 *
 * Exported and pure so each outcome is a thing a test can hold rather than JSX to be re-read by
 * eye. A verdict surface is worth having only if the verdicts differ, and there are twelve of
 * them; the arm that is easiest to lose is the one nobody reaches by hand (`key_unreadable`,
 * `internal`), which is exactly why they are pinned one by one.
 */
export function verdictOf(
  status: LocalAiStatus,
  t: Copy,
  now: number,
  /** The provider a write is in flight for, or null. Named so "Asking …" names the right vendor. */
  pending: AiChoice | null,
): { state: SettingsVerdictState; headline: string; detail?: string; when?: string } {
  if (pending !== null) {
    const vendor = pending === "none" ? "" : VENDOR[pending];
    return { state: "wait", headline: t("testing", { vendor }) };
  }

  const p = status.provider;
  if (!p) return { state: "off", headline: t("summaryOff") };

  const vendor = VENDOR[p];
  const host = p === "ollama" ? ollamaHost(status.settings.ollama.baseUrl) : VENDOR_HOST[p];
  const when = status.probe ? t("checked", { when: agoStamp(status.probe.at, now).rel }) : undefined;
  const stamped = when === undefined ? {} : { when };

  if (status.available && status.probe) {
    const set = status.settings[p];
    return {
      state: "ok",
      headline: t("verdictReady", { classify: set.classifyModel, draft: set.draftModel }),
      ...stamped,
    };
  }

  switch (status.unavailableReason) {
    case "key_absent":
      return { state: "off", headline: t("verdictNoKey"), detail: t("verdictNoKeyDetail") };
    case "key_unreadable":
      return { state: "bad", headline: t("verdictCredential") };
    case "unverified":
      return { state: "off", headline: t("verdictUntested"), detail: t("verdictUntestedDetail") };
    case "unreachable": {
      const reason = status.probe?.reason ?? null;
      const count = status.probe?.models.length ?? 0;
      switch (reason) {
        case "unauthorized":
          return {
            state: "bad",
            headline: t("verdictUnauthorized", { vendor }),
            detail: t("verdictUnauthorizedDetail", { vendor }),
            ...stamped,
          };
        case "timeout":
          return { state: "bad", headline: t("verdictTimeout", { vendor }), ...stamped };
        /**
         * `probe.detail` IS A COMPLETE SENTENCE, NOT A MODEL ID.
         *
         * The engine writes `the model server is running and does not have "llama3.2"` and
         * `"gpt-x" is not a chat model, so it cannot answer suggestions or drafts`
         * (`ai-ollama.ts:244`, `ai-openai.ts:336`). Interpolating that into "the key works, but
         * {model} is not on its list" produced a mangled sentence AND told an Ollama user their
         * key works, when Ollama has no key at all.
         *
         * So the headline is OURS — translated, provider-neutral, true of both — and the engine's
         * sentence rides in the detail beside the pointer that repairs it. That is `local-ai.ts`'s
         * standing rule: the engine's words for what happened, ours for what to do next.
         */
        case "model_absent":
          return {
            state: "bad",
            headline: t("verdictModelAbsent"),
            detail: t("verdictModelAbsentDetail", { count, said: status.probe?.detail ?? "" }).trim(),
            ...stamped,
          };
        case "bad_response":
          return { state: "bad", headline: t("verdictBadResponse", { vendor }), ...stamped };
        case "credential":
          return { state: "bad", headline: t("verdictCredential"), ...stamped };
        case "internal":
          return { state: "bad", headline: t("verdictInternal"), ...stamped };
        default:
          return {
            state: "bad",
            headline:
              p === "ollama"
                ? t("verdictUnreachableOllama", { host })
                : t("verdictUnreachable", { host }),
            ...stamped,
          };
      }
    }
    default:
      return { state: "off", headline: t("summaryOff") };
  }
}

/** The one word the summary row carries on the right. */
export function summaryWord(status: LocalAiStatus, t: Copy): string {
  if (!status.provider) return t("summaryOff");
  if (status.available) return t("summaryOn");
  if (status.unavailableReason === "key_absent") return t("summaryKey");
  if (status.unavailableReason === "unverified") return t("summaryUntested");
  return t("summaryDown");
}

/** What choosing this option means, in one line — and it names the host content would go to. */
function consequence(kind: AiChoice, status: LocalAiStatus, t: Copy): string {
  switch (kind) {
    case "anthropic":
      return t("choiceAnthropicWhy");
    case "openai":
      return t("choiceOpenaiWhy");
    case "ollama": {
      const base = status.settings.ollama.baseUrl;
      const host = ollamaHost(base);
      return ollamaIsLocal(base)
        ? t("choiceOllamaWhy", { host })
        : t("choiceOllamaWhyElsewhere", { host });
    }
    default:
      return t("choiceNoneWhy");
  }
}

/**
 * A MODEL WRITE, SPELLED OUT PER VENDOR rather than composed with a computed key.
 *
 * Three near-identical branches instead of `{ [kind]: models }`, because the shape of the write is
 * the one place a vendor's models can be saved into another vendor's block, and a computed key is
 * exactly the construction that lets the compiler stop caring which. It is also what keeps the
 * anti-exfiltration invariant structural: neither hosted branch has anywhere to put a `baseUrl`,
 * and the Ollama branch omits it, so the engine keeps the origin it holds.
 */
function modelWrite(kind: AiProviderKind, classifyModel: string, draftModel: string): LocalAiWrite {
  const models = { classifyModel, draftModel };
  if (kind === "anthropic") return { provider: kind, anthropic: models };
  if (kind === "openai") return { provider: kind, openai: models };
  return { provider: kind, ollama: models };
}

/** A key write, for the vendor whose field was on screen when it was typed. Same argument. */
function keyWrite(kind: KeyedKind, apiKey: string): LocalAiWrite {
  return kind === "anthropic" ? { provider: kind, anthropic: { apiKey } } : { provider: kind, openai: { apiKey } };
}

export interface AiProviderFormProps {
  /**
   * Published upward on every landing, so a host that cares — the Screener's own suggest control,
   * the first-run flow's next step — learns about a key that was just saved without a relaunch.
   */
  onStatus?: (status: LocalAiStatus | null) => void;
}

export function AiProviderForm({ onStatus }: AiProviderFormProps) {
  const t = useTranslations("aiProvider");
  const [status, setStatus] = useState<LocalAiStatus | null>(null);
  /** Has the first read finished? Distinct from "there is nothing configured", which is a state. */
  const [read, setRead] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<null | "choice" | "test" | "save" | "clear">(null);
  /** Which provider the in-flight write is about, so the wait line names the right vendor. */
  const [pending, setPending] = useState<AiChoice | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [classify, setClassify] = useState("");
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);

  /**
   * THE HOST'S ECHO THROUGH A REF, so the load effect below keeps its once-per-mount `[]` deps.
   *
   * This is not tidiness. `land` closes over `onStatus`, and with `land` in the effect's deps a
   * host that passes an inline arrow — `onStatus={(s) => setThing(s)}`, the obvious way to write
   * it — gives a new function every render, a new `land`, a re-run of the effect, a `setStatus`,
   * and another render. A read loop against the engine for as long as the form is open. The pane
   * that used to hold this form got away with it because its one host passes a `useState` setter,
   * which is stable; the form now has a second host and the first-run flow has no reason to know
   * that rule. `AwayResponderRow` holds its echo the same way, for the same reason.
   */
  const echo = useRef(onStatus);
  echo.current = onStatus;

  const land = useCallback((next: LocalAiStatus | null) => {
    setStatus(next);
    // Cleared on every landing, success or not: a field still holding a key after a save is a
    // secret sitting in the window's memory for as long as the form is open.
    setApiKey("");
    if (next?.provider) {
      setClassify(next.settings[next.provider].classifyModel);
      setDraft(next.settings[next.provider].draftModel);
    }
    echo.current?.(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await readAiStatus();
        if (!cancelled) land(next);
      } catch (err) {
        if (!cancelled) setProblem(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setRead(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [land]);

  if (!read) {
    return <SettingsRow label={t("summaryLabel")} description={t("offDescription")} value="…" />;
  }

  /* NOTHING AT ALL ON A DOOR THAT SERVES NO LOCAL MODEL. `readAiStatus` answers null for a 404,
     which is a state and not a fault: an install pointed at a hosted account has no settings of
     its own to show. Both hosts of this form mount it on the standalone door only, so this is a
     structural guard rather than a rendered state — the same choice `DesktopAutoSuggest` makes,
     and for its reason: a form over a route that does not exist is a control that cannot control. */
  if (!status) {
    return problem ? (
      <p className="set-note-inline" role="alert">
        {problem}
      </p>
    ) : null;
  }

  const choice: AiChoice = status.provider ?? "none";
  const keyed = isKeyed(choice);
  const hasKey = keyed && status.settings[choice].hasKey;
  /**
   * THE ENDPOINT'S LIST IS THE ENDPOINT'S LIST, WHETHER OR NOT THE VERIFICATION PASSED.
   *
   * This was `probe.ok ? probe.models : []`, which reads as caution and is a dead end. The one
   * failure that carries a NON-EMPTY list is exactly the one the list repairs: `model_absent`
   * means the endpoint answered, listed what it has, and did not have the model in the settings
   * (`ai-ollama.ts:239-246` returns `models` alongside the failure, as does `ai-openai.ts`). So
   * the arm that discarded it hid both selectors at the only moment they were needed, left the
   * verdict pointing at "the models below" with nothing below, and made every retry repeat the
   * same failure — an Ollama install holding `mistral:latest` while the settings asked for
   * `llama3.2` could not be fixed from the pane at all.
   *
   * Every other failure returns an empty list anyway (`unreachable`, `timeout`, `unauthorized`),
   * so reading it unconditionally can only ever ADD the list where the endpoint really sent one.
   */
  const models = status.probe?.models ?? [];
  const listed = models.length > 0 && choice !== "none";
  const stored = choice === "none" ? null : status.settings[choice];
  const dirty =
    stored !== null && (classify !== stored.classifyModel || draft !== stored.draftModel);
  const working = busy !== null;

  const run = async (
    what: NonNullable<typeof busy>,
    about: AiChoice,
    fn: () => Promise<LocalAiStatus>,
  ): Promise<void> => {
    if (busy) return;
    setBusy(what);
    setPending(about);
    setProblem(null);
    setSaved(false);
    try {
      land(await fn());
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setPending(null);
    }
  };

  const verdict = verdictOf(status, t, Date.now(), pending);

  return (
    <>
      <SettingsRow
        label={t("summaryLabel")}
        description={status.provider ? consequence(choice, status, t) : t("offDescription")}
        value={summaryWord(status, t)}
      />

      <p className="set-field-label" style={{ paddingTop: 14 }}>
        {t("providerLabel")}
      </p>
      <SettingsChoice<AiChoice>
        name="ai-provider"
        ariaLabel={t("providerLabel")}
        value={choice}
        disabled={working}
        /* THE RADIO DOES NOT MOVE UNTIL THE ENGINE HAS ANSWERED. `choice` is read off the status,
           so a refused write leaves the control showing the provider that is actually stored —
           the same "resolve to what the database holds, never to what the click hoped for"
           contract every other settings control here keeps. It also disposes of the old pane's
           sharpest edge for free: there is no typed key to carry across a vendor change, because
           a key is submitted by its own form the moment it is typed. */
        onChange={(next) => {
          if (next === choice) return;
          void run("choice", next, () =>
            saveAiSettings({ provider: next === "none" ? null : next }),
          );
        }}
        options={[
          { id: "none", label: t("choiceNone"), description: t("choiceNoneWhy") },
          { id: "anthropic", label: t("choiceAnthropic"), description: t("choiceAnthropicWhy") },
          { id: "openai", label: t("choiceOpenai"), description: t("choiceOpenaiWhy") },
          { id: "ollama", label: t("choiceOllama"), description: consequence("ollama", status, t) },
        ]}
      />

      {keyed ? (
        status.canStoreKey ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const typed = apiKey.trim();
              if (!typed && !hasKey) return;
              /* Typed ⇒ seal it and verify what was just sealed. Empty with one stored ⇒ verify
                 the stored one. Both come back as a status about the configuration NOW in force,
                 because the engine discards the previous verification on every write. */
              void run("test", choice, () =>
                typed ? saveAiSettings(keyWrite(choice, typed)) : verifyAiProvider(),
              );
            }}
          >
            <SettingsField
              htmlFor="ai-key"
              label={hasKey ? t("keyStoredLabel") : t("keyLabel")}
              hint={t("keyHint", { vendor: VENDOR[choice] })}
            >
              <div className="set-field-row">
                <input
                  id="ai-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  className="set-mono"
                  placeholder={hasKey ? t("keyStoredPlaceholder") : t("keyPlaceholder")}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={working}
                />
                <Button variant="primary" type="submit" disabled={working || (!apiKey.trim() && !hasKey)}>
                  {apiKey.trim() || !hasKey ? t("testKey") : t("testStoredKey")}
                </Button>
              </div>
            </SettingsField>
          </form>
        ) : (
          <p className="set-note-inline">{t("keyCannotStore")}</p>
        )
      ) : null}

      {choice === "ollama" ? (
        <SettingsActions>
          <Button variant="primary" disabled={working} onClick={() => void run("test", choice, verifyAiProvider)}>
            {t("testServer")}
          </Button>
        </SettingsActions>
      ) : null}

      {/* THE ANSWER TO A PRESS, UNDER THE PRESS THAT ASKED FOR IT. The old pane rendered its
          verdict near the top while the buttons sat at the bottom behind the provider's fields, so
          pressing "Test connection" changed one line above the fold and the control read as dead.
          It is reported as exactly that. `SettingsVerdict` is a live region, so the outcome also
          reaches a screen reader without focus leaving the button. */}
      {choice !== "none" ? (
        <SettingsVerdict
          state={verdict.state}
          headline={verdict.headline}
          {...(verdict.detail === undefined ? {} : { detail: verdict.detail })}
          {...(verdict.when === undefined ? {} : { when: verdict.when })}
        />
      ) : null}
      {problem ? (
        <p className="set-note-inline" role="alert">
          {problem}
        </p>
      ) : null}

      {/* THE MODEL LIST IS THE ENDPOINT'S OWN, and there is no other source for it. Empty until a
          test has run, which is honest — nothing has asked it yet — and a name that is not on the
          list cannot be chosen, so a saved model is always one the endpoint said it has. */}
      {listed ? (
        <>
          <SettingsSubhead>{t("modelsSubhead")}</SettingsSubhead>
          <div className="set-fields">
            <SettingsField htmlFor="ai-classify" label={t("modelClassify")} hint={t("modelClassifyHint")}>
              <select
                id="ai-classify"
                value={models.includes(classify) ? classify : ""}
                onChange={(e) => {
                  setClassify(e.target.value);
                  setSaved(false);
                }}
                disabled={working}
              >
                <option value="" disabled>
                  {t("modelChoose")}
                </option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </SettingsField>
            <SettingsField htmlFor="ai-draft" label={t("modelDraft")} hint={t("modelDraftHint")}>
              <select
                id="ai-draft"
                value={models.includes(draft) ? draft : ""}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setSaved(false);
                }}
                disabled={working}
              >
                <option value="" disabled>
                  {t("modelChoose")}
                </option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </SettingsField>
          </div>
          <SettingsActions>
            <Button
              variant="primary"
              disabled={working || !dirty || !models.includes(classify) || !models.includes(draft)}
              onClick={() =>
                void run("save", choice, async () => {
                  const next = await saveAiSettings(
                    modelWrite(choice as AiProviderKind, classify, draft),
                  );
                  setSaved(true);
                  return next;
                })
              }
            >
              {t("save")}
            </Button>
            {saved ? (
              <span className="set-note-inline" role="status">
                {t("saved")}
              </span>
            ) : null}
          </SettingsActions>
        </>
      ) : choice !== "none" ? (
        <p className="set-note-inline">{t("modelsWait", { vendor: VENDOR[choice] })}</p>
      ) : null}

      {/* OFFERED WHENEVER ANYTHING IS STORED — a provider, or EITHER vendor's key. A key outlives
          the choice that saved it: selecting None clears the provider and keeps the sealed
          envelope, which is deliberate (switching away is not an instruction to forget a
          credential). That makes this row the only path to the deletion, so it names both keys —
          while it named Anthropic's alone, a stored OpenAI key with no provider selected had no
          way to be removed at all. It is also what restores a non-default Ollama origin. */}
      {status.provider || status.settings.anthropic.hasKey || status.settings.openai.hasKey ? (
        <SettingsRow
          label={t("remove")}
          description={t("removeWhy")}
          control={
            <Button
              variant="ghost"
              className="danger"
              disabled={working}
              onClick={() => void run("clear", "none", clearAiProvider)}
            >
              {t("forget")}
            </Button>
          }
        />
      ) : null}

      {/* WRITTEN FOR THIS FORM AND NOT BORROWED FROM THE PANE AROUND IT, because the two are not
          the same claim. The mailbox password never passes through this window. An API key does —
          you type it here — and what is true of it is the sentence below. */}
      <SettingsNote>{t("note")}</SettingsNote>
    </>
  );
}
