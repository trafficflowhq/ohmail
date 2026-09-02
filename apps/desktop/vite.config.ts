import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { UPDATER_HTML, UPDATER_JS } from "./src/updater-window";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * WHICH OF THE TWO ARTIFACTS THIS BUILD IS.
 *
 * One directory, two outputs, and the difference is not a runtime switch:
 *
 *  · the WINDOW bundle (the default arm) is the desktop app's own UI: the real sync client over
 *    the bridge in `src/bridge-fetch.ts`, which is the only thing in either output that can
 *    address anything outside the page — and it addresses the shell, not the network. It belongs
 *    in a binary compiled with the Rust `local-engine` feature, whose commands it calls;
 *  · the HOST CLIENT (next constant) is the browser bundle the host door serves to a phone.
 *
 * There used to be a THIRD arm, and it was the default: an "interface preview" over fixture
 * mail, built and smoked but never shipped. Retired under the no-demo rule — the app has no
 * demo surface; the one demo lives on ohmail.app's landing page — so the window bundle is the
 * default now, `OHMAIL_LOCAL_ENGINE=1` remains as its explicit spelling (`scripts/build-ui.mjs
 * --engine` still sets it, and refuses a bare invocation so a build is always a named choice),
 * and a bare `vite` dev server gets the same arm: the real client, whose no-shell surface is
 * the door chooser rather than invented mail.
 *
 * The variable is set by the SCRIPT rather than by the caller's shell — see `scripts/build-ui.mjs`
 * — because `OHMAIL_LOCAL_ENGINE=1 vite build` is POSIX syntax that cmd.exe reads as a program
 * name, and Windows is one of the platforms this app ships to.
 */
const LOCAL_ENGINE = process.env.OHMAIL_HOST_CLIENT !== "1";

/**
 * THE THIRD ARTIFACT — the HOST CLIENT: the browser bundle the desktop's host door serves to a
 * phone on the user's own tailnet (Phase 3; the QR sends the phone's browser to
 * `https://<magicdns>/pair#<token>`, and the engine's static handler serves this dist).
 *
 * A third arm of THIS config rather than a config of its own, because the whole point is that it
 * is the SAME shared shell over the same aliases — the message filter, the react/tiptap/dompurify
 * pins, the ics seam — with exactly the deltas a real browser tab needs:
 *
 *  · entry `host.html` → `src/host-client/main.tsx`, outDir `dist-host` (the window's dist must
 *    stay byte-identical — the two artifacts never share an output directory);
 *  · `base: "/"` instead of `"./"` — the door serves `/pair` and every app route by INDEX
 *    FALLBACK, and a relative asset URL resolved against `/pair/` addresses nothing; this bundle
 *    has exactly one origin by construction, so absolute is both safe and required;
 *  · the REAL `http-adapter`, like the engine build — its transport is `fetch` in bearer mode
 *    over the served origin (the offline guard is NOT installed; that is the window entry's,
 *    and the reason the WINDOW dist can never be served);
 *  · `NEXT_PUBLIC_DESKTOP` stays UNDEFINED — this is a browser tab, and a hidden tab dropping to
 *    the slow sync cadence is the battery-correct behaviour the desktop define exists to disable;
 *  · no updater page — there is no updater window in a phone browser.
 *
 * Mutually exclusive with `OHMAIL_LOCAL_ENGINE` (`build-ui.mjs` refuses both), because an
 * artifact cannot be both the window bundle and the served one.
 */
const HOST_CLIENT = process.env.OHMAIL_HOST_CLIENT === "1";
if (HOST_CLIENT && process.env.OHMAIL_LOCAL_ENGINE === "1") {
  throw new Error("OHMAIL_HOST_CLIENT and OHMAIL_LOCAL_ENGINE select different artifacts — set one");
}

/**
 * The message namespaces the SHELL actually reads — and therefore the only ones
 * that belong in a desktop binary.
 *
 * `apps/webapp/messages/en.json` is one file for two products. It also holds the
 * marketing site's copy: the nav, the hero, the pricing table, the FAQ.
 * `main.tsx` imports it whole, so all of it was ending up inside the executable —
 * `strings ohmail_0.2.0_amd64.deb`'s binary printed `$9 a month`, which is a price
 * quoted by an app that cannot be subscribed to, in a build that has no account.
 * Wrong, and it dates the moment the price changes.
 *
 * Two provenances, because the shell reads translations two ways:
 *  · `useTranslations("<ns>")` — thirteen call sites across shell/ and views/;
 *  · `useTranslations()` in `AppShell.tsx`, unscoped, which then addresses
 *    `about.*`, `dock.*`, `palette.*`, `rail.*` and `ribbon.*` by dotted key.
 * Miss the second kind and the app renders raw key names at runtime, so the list
 * is DERIVED FROM THE SOURCE by `test/desktop-messages.test.ts` and compared with
 * this array — adding a `useTranslations` to a view without adding its namespace
 * here fails the suite rather than the app.
 */
export const SHELL_MESSAGE_NAMESPACES = [
  // `body` holds the two sentences a reading surface says when the message text is being
  // fetched or could not be. The desktop compiles them and can never render
  // them (its `FixturesAdapter` serves no bodies, so `hydrateBody` short-circuits and no
  // surface ever sees `loading`/`failed`), and it is listed for the reason `sync` is: the
  // guard compares this array against what the sources READ, not against what they display.
  // Omitting it would put `body.loading` in the binary where a sentence belongs.
  "about", "body", "compose", "dock", "ohbox", "palette", "rail", "reads", "receipts",
  // `ohmarchy` is the Option B offer's line (shell/OhmarchyOffer.tsx) — shared-shell code the
  // desktop compiles; its gates (Linux device, an account-wide write available) decide whether
  // it renders, and the census lists what the sources READ, not what they display.
  "ohmarchy",
  // `attachments` and `mailBody` belong to the two components the reading pane is composed from —
  // the paperclip strip and the sanitized HTML body. They were listed here for two migrations
  // before either component read a catalogue: each rendered from a local `COPY` constant whose
  // header named the namespace it would one day take, and the derivation below counted the
  // namespace that COMMENT named. The swap has happened. Both now read the catalogue through
  // `liveCopy` (see `app/shell/locale.ts`), so the derivation counts a CALL, and the entries here
  // mean what the rest of this list means.
  //
  // Why the swap mattered rather than being tidy: both surfaces are unreachable in the
  // fixtures-only preview — no attachment bytes, no bodies — and reachable on every real message
  // with a file and every real HTML body in an engine-bearing build. A German reader of the shipped
  // binary is exactly the person who would have found them still in English.
  "attachments", "mailBody",
  // `folder` is the folder VIEW's namespace (the folders foundation, FOLDERS-SPEC.md) — three
  // sentences: a count and the empty state naming where the folder list comes from. It is NOT
  // the marketing "folders" namespace, which stays excluded below with the other site copy.
  "folder",
  // `attachmentPreview` and `away` joined the list with the German translation, and by the ROUTE the
  // header above warns about rather than by a new `useTranslations` call. Both were local `COPY`
  // constants — a surface the catalogue cannot reach is a surface that stays English for ever — and
  // both now read the catalogue: the preview modal through `liveCopy("attachmentPreview", …)`
  // (`app/shell/locale.ts`, the non-hook translator the bare-rendered reading components need), the
  // away responder through an ordinary `useTranslations("away")`. `place` arrived the same way, from
  // `format.ts`'s hardcoded view-name table — the badge on every search hit and the "Moved to
  // Receipts." in every move toast.
  //
  // The derivation in `test/desktop-messages.test.ts` counts `liveCopy("<ns>", …)` as a read for
  // exactly this reason: it is a read.
  "attachmentPreview", "away", "place",
  // `icsEvent` is the calendar event card the attachment strip promotes a parsed `text/calendar`
  // part into — read by `app/components/IcsEventCard.tsx` through `liveCopy("icsEvent", …)`, the
  // same non-hook route as `attachmentPreview`, and counted by the derivation for the same
  // reason. Unreachable in the fixtures-only preview today (the desktop tier serves no
  // attachment bytes), listed for the reason `body` is: the guard compares what the sources
  // READ, and omitting it would put `icsEvent.request` in the binary where "Einladung" belongs.
  "icsEvent",
  // `bodyText` is the quoted-history fold's copy ("Show history"/"Hide history"), read by
  // `app/shell/BodyText.tsx` through `liveCopy("bodyText", …)` since the fold landed — the same
  // non-hook route `attachmentPreview` takes, and counted by the derivation for the same reason:
  // it is a read. The fold renders on every message whose text carries a quoted tail, which the
  // desktop preview's fixture thread does, so this one is reachable in the binary today.
  "bodyText",
  // `relativeTime` is the young arm of the shared relative-time stamp ("just now"), read by
  // `app/shell/format.ts` through `liveCopy("relativeTime", …)` — the same non-hook route
  // `bodyText` takes, counted by the derivation for the same reason. The stamp renders wherever
  // a sync age does, so omitting it ships a binary whose German reader gets the English
  // fallback on every "Synced … ago" line.
  "relativeTime",
  // `draftReply`, `history` and `seed` are the three the shell started reading without this
  // array following, which is precisely the omission `desktop-messages.test.ts` exists to
  // catch — and it was catching it: the guard has been red since those surfaces landed.
  // `draftReply` is the AI drafter's offer, and the desktop is the one place its
  // `unavailable` sentence is the ONLY reachable branch — `apiConfigured()` is false there,
  // so a stranger who presses "Draft reply" in the binary gets the explanation rather than a
  // raw key. `history` and `seed` are listed for the reason `body` and `sync` are: the guard
  // compares this array against what the sources READ, not against what they can display.
  "draftReply", "history", "seed",
  // `reply`, `screening` and `shortcuts` arrived with the 2026-08-02 frontend slice
  // (inline reply, sender screening, the `?` overlay). They are listed here because the
  // desktop shell renders all three; without them the binary shows `reply.send` where a
  // word belongs, which is exactly the failure the abort below exists to prevent — and
  // `desktop-messages.test.ts` caught the omission rather than a user finding it.
  // `providerPicker` arrived with the desktop's own door chooser: the provider tiles are the
  // shared client's control, moved into `app/shell` so all three "connect a mailbox" surfaces
  // render one list rather than three copies of it. Two strings — the field's label and the
  // subtitle on the generic IMAP entry.
  "providerPicker",
  // `reader` is the narrow-width reading overlay's chrome — AppShell addresses `reader.back` by
  // dotted key through its unscoped `useTranslations()`, the second call shape the header above
  // warns about. The overlay renders on every message opened under 900px, so without this the
  // binary shows `reader.back` on the one control that leaves it.
  "reader",
  // `profileImport` is the "we found your ohmail settings on this mailbox" card
  // (`app/shell/ProfileImportCard.tsx`), read through an ordinary `useTranslations`. GENUINELY
  // REACHABLE in the engine-bearing binary since the desktop door wired its transport
  // (`local-profile-import.ts`, both doors): a mailbox that arrives carrying another install's
  // settings puts this card on the stage, so without the namespace the restore moment renders
  // `profileImport.title` where the one sentence that must land as words belongs.
  "profileImport",
  // `pairLanding` is the host client's /pair fragment landing (`src/host-client/PairScreen.tsx`)
  // — the page the desktop's pairing QR sends a phone to, read through an ordinary
  // `useTranslations("pairLanding")`. Reachable only in the HOST-CLIENT artifact (the window
  // never routes to it), and listed for the reason `body` and `sync` are: the guard compares
  // this array against what the sources READ, not against what each artifact can display.
  "pairLanding",
  // `host` is the Settings → Devices pane (`src/DesktopDevices.tsx`) — host mode's whole
  // surface: the enable ceremony, the guided Tailscale ladder, the pairing QR and the device
  // list. Reachable only in the engine-bearing build on the standalone door, and listed for the
  // reason `body` is: the guard compares this array against what the sources READ. Without it
  // the binary renders `host.lead` where the one sentence that sells the tier belongs.
  "host",
  "reply", "ribbon", "screener", "screening", "search", "session", "settings",
  // `sync` is the shell's failing-sync strip. The desktop compiles it and
  // can never render it (a fixtures engine is permanently settled), but the guard compares
  // this list against what the sources READ, not against what they display.
  // `mailboxes` is read by the shell's sync strip for its `err_<code>` lookup, so the desktop
  // build needs it compiled in. Listed for the reason `body` and `sync` are: this array is
  // compared against what the sources READ, not against what they can display. Without it the
  // binary ships a sync strip whose error line resolves to a raw `mailboxes.err_…` key, which is
  // exactly the failure the abort below exists to prevent.
  "mailboxes",
  // `rules` is the surface that lets somebody see and revoke the rules the
  // Screener writes. The desktop shell renders it (SettingsView is published), and its
  // FixturesAdapter serves both rule verbs, so unlike `body` and `sync` this one is
  // genuinely reachable there: without it the pane shows `rules.revokeExplain` where a
  // sentence about not moving somebody's mail belongs.
  "rules",
  // `drafts` is the list of messages somebody started and has not sent. The desktop shell
  // renders it — `DraftsView` is published, and the rail carries its entry — and unlike `body`
  // or `sync` it is genuinely reachable there: the FixturesAdapter serves `draft_save` and
  // `draft_discard` out of `mutationEffects` like every other verb, so a preview build can
  // create a draft, list it and throw it away. Without the namespace the pane would render
  // `drafts.discardWhat` where the sentence explaining that a discard is not recoverable
  // belongs — which is the one string in it that must not arrive as a raw key.
  "drafts",
  // `message` is the reading pane's own header — the sender line, the timestamp and the
  // collapse control (`MessageCard`); `markAll` is the "mark everything read" action
  // (`MarkAllRead`). Both are shell surfaces the desktop renders, and both are present in
  // en.json. Listed for the same reason the rest are: this array is compared against what
  // the sources READ, not against what they display, so a `useTranslations` added to either
  // surface has to be followed here or the guard goes red rather than the app.
  // `viewError` is the shell's view-level error boundary — the three lines shown when a pane
  // fails to render (`AppShell`, via the unscoped `t("viewError.title|body|action")`), so it
  // is the second kind of read the header note warns about and is caught the same way.
  "markAll", "message", "viewError",
  "shortcuts", "sync", "tag", "triage",
  // `update` is Settings → About → Updates (`src/DesktopUpdate.tsx`) — the app's own update, in
  // the one place it can always be found. It is a DESKTOP-ONLY namespace: the browser client has
  // no build to update. Genuinely reachable in the engine-bearing binary, and on the desktops
  // where the compositor owns the window frame it is the ONLY update affordance there is
  // (`src-tauri/src/frame.rs` — no menu bar, so no menu item), which makes a missing namespace
  // here worse than the usual raw key: it would render `update.upToDate` on the one control that
  // tells somebody whether their mail client is current.
  "update",
  // `aiProvider` is the model form (`src/AiProviderForm.tsx`) — the provider choice, the key
  // field, the twelve verdicts and the model pickers, shared by Settings → Desktop and by the
  // first-run flow's provider step. A DESKTOP-ONLY namespace: the browser client has no local
  // model to configure. Genuinely reachable in the engine-bearing binary on the standalone door,
  // and the verdicts are the worst place in the product for a raw key — they are the only thing
  // that ever explains why a model is not answering.
  "aiProvider",
  "onboarding",
] as const;

/**
 * NAMESPACES SHIPPED AS A SUBSET — the named keys, and nothing else in them.
 *
 * ── WHY A SECOND LIST RATHER THAN A SECOND ENTRY ABOVE ────────────────────────────────────
 *
 * The list above is all-or-nothing, and for every namespace on it that is the right shape: the
 * shell either reads a surface or it does not. `join` is the first namespace the shell reads ONE
 * key out of. `FirstRun.tsx` composes the setup flow's "already connected" line from
 * `join.mailboxConnected` rather than writing a second sentence for a state the connect funnel had
 * already worded — one sentence, one translation — and the other 94 keys are the sign-up funnel's,
 * several of which name Cloud's prices and its metering unit.
 *
 * Adding `join` to the list above was tried and the guard refused it in the same minute: `no price
 * survives the filter` matched `/AI actions?/i` in the kept payload. That refusal is the whole
 * point of this file — a standalone binary sells nothing and must not carry the price of anything —
 * so the namespace is narrowed instead of admitted. Anything added here is scanned by the same
 * price guard, so a subset cannot be used to smuggle one in.
 *
 * It became load-bearing when the standalone door was given a first-run host
 * (`src/local-first-run.ts`): the stage's mailbox step withholds its form once a mailbox exists,
 * and on this door a mailbox ALWAYS exists by the time the stage can open, so that line is the
 * first thing standalone onboarding shows. Without it the screen reads `join.mailboxConnected`.
 */
export const SHELL_MESSAGE_KEYS: Record<string, readonly string[]> = {
  join: ["mailboxConnected"],
};

/**
 * Replace each catalogue module with just those namespaces, at build time.
 *
 * A runtime `pick()` would not do: a JSON import compiles to one object literal
 * and nothing tree-shakes the keys back out, so the strings would still be in the
 * artifact. This replaces the file's CONTENT before anything reads it, which is why
 * it is a `load` hook and cannot be an alias.
 *
 * It returns JSON, not an ES module, and that is deliberate: `vite:json` transforms
 * this id afterwards regardless of `enforce`, so emitting `export default …` here
 * gets handed to its `JSON.parse` and fails the build with "Failed to parse JSON
 * file". Returning the filtered document lets that plugin do the module conversion
 * it was going to do anyway.
 *
 * An absent namespace ABORTS the build. The alternative is a binary that renders
 * `rail.ohbox` where a word should be, discovered by a user.
 */
function shellMessagesOnly(): Plugin {
  /**
   * EVERY catalogue, not just English. `src/DesktopLocale.tsx` imports both, so a filter that named
   * one file would put the marketing site's GERMAN copy — the pricing table, the FAQ — straight back
   * into the executable through the second import: the exact defect this plugin exists for,
   * reintroduced by the slice that added a language.
   *
   * Derived from the directory rather than listed, so a third catalogue is filtered the day it lands.
   * `LOCALES` in `app/shell/locale.ts` is the closed set the APP resolves; the question here is
   * different and broader — "which files under `messages/` could a bundle import" — and answering it
   * from the filesystem is what makes the filter total instead of as up to date as this file is.
   */
  const dir = r("../webapp/messages");
  const targets = new Map(
    fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
      .map((f) => [path.resolve(path.join(dir, f)), f] as const),
  );
  if (targets.size === 0) {
    throw new Error("apps/webapp/messages holds no .json catalogue — the filter has nothing to do");
  }
  return {
    name: "ohmail-shell-messages-only",
    enforce: "pre",
    load(id) {
      const resolved = path.resolve(id.split("?")[0]!);
      const name = targets.get(resolved);
      if (name === undefined) return null;
      const all = JSON.parse(fs.readFileSync(resolved, "utf8")) as Record<string, unknown>;
      /**
       * A MISSING NAMESPACE ABORTS FOR `en.json` AND IS ACCEPTED FOR ANY OTHER — the fallback rule,
       * stated at build time. English is the base of every merge, so a namespace absent there is a
       * binary that renders `rail.ohbox` where a word belongs, which is what the abort was written
       * for. A namespace absent from a TRANSLATION is one that has not been translated yet, and
       * `fillFrom` resolves it to the English sentence; refusing the build over it would make an
       * incomplete translation unshippable rather than incomplete. Full key parity is asserted where
       * it can be reported usefully — the webapp's catalogue test names the missing keys — and not
       * by a bundler whose only vocabulary is "no".
       */
      if (name === "en.json") {
        const missing = [
          ...SHELL_MESSAGE_NAMESPACES.filter((ns) => !(ns in all)),
          /* A subset namespace is missing when the namespace is absent OR when the one key the
             shell reads out of it is — a renamed key is exactly as blank on screen as a renamed
             namespace, and the wholesale list cannot see the difference. */
          ...Object.entries(SHELL_MESSAGE_KEYS).flatMap(([ns, keys]) => {
            const held = all[ns] as Record<string, unknown> | undefined;
            if (!held) return [ns];
            return keys.filter((k) => !(k in held)).map((k) => `${ns}.${k}`);
          }),
        ];
        if (missing.length) {
          this.error(
            `apps/webapp/messages/en.json has no ${missing.join(", ")} — ` +
              `the shell reads ${missing.length > 1 ? "them" : "it"}. ` +
              `Renamed upstream? Update SHELL_MESSAGE_NAMESPACES in vite.config.ts.`,
          );
        }
      }
      const picked: Record<string, unknown> = {};
      for (const ns of SHELL_MESSAGE_NAMESPACES) {
        if (ns in all) picked[ns] = all[ns];
      }
      /* AND THE NARROWED ONES, key by key. A namespace absent from a TRANSLATION is skipped for
         the reason the abort above skips it: `fillFrom` resolves it to the English sentence. */
      for (const [ns, keys] of Object.entries(SHELL_MESSAGE_KEYS)) {
        const held = all[ns] as Record<string, unknown> | undefined;
        if (!held) continue;
        picked[ns] = Object.fromEntries(
          keys.filter((k) => k in held).map((k) => [k, held[k]]),
        );
      }
      return JSON.stringify(picked);
    },
  };
}

/**
 * Emit the auto-updater's progress page (`updater.html` + `updater.js`) into the bundle.
 *
 * These are NOT a Vite input and NOT under a `public/` folder, both deliberately: an extra HTML
 * input conflicts with `inlineDynamicImports`, and a `public/` asset would be outside the publish
 * payload (`scripts/publish-desktop.mjs` ships `apps/desktop/src` as `.ts` only), so a released
 * binary built from the mirror would open a blank updater window. Emitting them from a published
 * `.ts` module gets the same two bytes into both trees. See `src/updater-window.ts`.
 *
 * The Rust updater (`src-tauri/src/updater.rs`) opens a window at `updater.html`; that window is the
 * only one granted `core:event:allow-listen`, and it reaches nothing else.
 */
function updaterProgressPage(): Plugin {
  return {
    name: "ohmail:updater-progress-page",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "updater.html", source: UPDATER_HTML });
      this.emitFile({ type: "asset", fileName: "updater.js", source: UPDATER_JS });
    },
  };
}

/**
 * Emit the host client's document as `index.html`, whatever the INPUT file is called.
 *
 * The input has to be a second html file (`host.html` — two artifacts cannot share `index.html`
 * in one directory), and vite emits an html input under its own name. The static handler serves
 * `index.html` as the SPA fallback for `/`, `/pair` and every app route, so the rename happens
 * here, in the build, rather than as a special case in the server.
 */
function hostIndexName(): Plugin {
  return {
    name: "ohmail:host-index-name",
    enforce: "post",
    generateBundle(_opts, bundle) {
      const html = bundle["host.html"];
      if (html === undefined) {
        this.error("host.html was not emitted — the host-client build has no document to serve");
      }
      html.fileName = "index.html";
      bundle["index.html"] = html;
      delete bundle["host.html"];
    },
  };
}

/**
 * The desktop UI bundle: the SAME client shell app.ohmail.app renders, compiled to a
 * self-contained folder of files that Tauri embeds. No dev server, no CDN, no
 * remote origin, no Next.js.
 *
 * Four kinds of seam are aliased, and only four — everything else is the shared
 * source:
 *
 *  1. `next-intl` → `use-intl`. next-intl IS use-intl plus Next server plumbing
 *     (both are 3.26.5 here), and the thirteen shell/view files only ever call
 *     `useTranslations`. Aliasing the framework wrapper away keeps the ICU
 *     semantics byte-identical instead of re-implementing plurals in a shim.
 *
 *  2. `./adapters/fixtures-adapter.js` → `src/no-fixtures-adapter.ts`, IN BOTH ARTIFACTS.
 *     The shared shell keeps a demo arm because the landing page's demo is built
 *     from it; `engine-config.ts` therefore names `FixturesAdapter` in a branch a
 *     desktop build can never take — and a branch never taken still puts its
 *     import in the bundle, which here is the whole fixtures corpus: invented
 *     people and sample mail inside an app whose rule is that it opens EMPTY.
 *     So the module is replaced rather than merely unreached, and
 *     `scan-artifact.mjs` greps the output for the sample world in both
 *     directions.
 *
 *     (A sibling alias used to sit here the OTHER way round: the retired
 *     "interface preview" aliased the real `http-adapter` to a throwing stub.
 *     It once shipped a window that went blank the moment a mailbox served,
 *     because the published tree substituted the stub for the class the engine
 *     build constructs — the reason the scan asserts presence AND absence, and
 *     the reason no artifact aliases the sync client any more: both remaining
 *     artifacts are engine-bearing and carry the real one.)
 *
 *  3. `../api-client` → `src/no-api-client.ts`, IN BOTH ARTIFACTS. Neither has a
 *     Cloud account or a server; both talk to a local engine over a pipe. This one
 *     is unconditional because the PUBLISHED tree writes the same stub over
 *     `apps/webapp/app/api-client.ts`, so every shipped binary is already built
 *     against it — without the alias, the bundle built here is not the bundle that
 *     ships, and a module absent from the published tree (`app/session-refresh.ts`)
 *     put a CSRF-bearing request builder into a preview nobody could install.
 *
 *  4. Every third-party package the SHARED sources import is pinned to THIS
 *     package's copy by absolute path — react and react-dom, and the rich text
 *     editor and HTML sanitizer the compose, reply and reading surfaces use.
 *     `dedupe` is not enough, and neither is declaring them in package.json:
 *     resolution walks up from the IMPORTER, and in a published checkout there is
 *     no `node_modules` anywhere above `apps/webapp/app/` or `packages/ui/src/` to
 *     walk up into — the only install is this directory's. An absolute alias
 *     resolves identically in the monorepo and in a clone, and for react it also
 *     guarantees one instance for both.
 *
 *     This list has to move with `tsconfig.json`'s `paths`, which pins the same
 *     names for the same reason. They were out of step once: the editor and
 *     sanitizer were added to the manifest and to `paths`, so `tsc --noEmit`
 *     passed while `vite build` could not resolve them — one tool reading the
 *     pins and the other not.
 *
 * One further transform, and it is a `load` hook rather than an alias because it
 * rewrites a module's body: `shellMessagesOnly()` above keeps the marketing site's
 * copy — nav, pricing, FAQ — out of the executable. See its comment.
 *
 * `base: "./"` makes every emitted URL relative, so the bundle is origin-agnostic:
 * it works under `tauri://localhost`, `http://tauri.localhost` and `file://`
 * alike, and there is no absolute path for anything to escape through.
 */
export default defineConfig({
  /* The host client is served under real paths (`/pair`, deep links) by index fallback, so its
     asset URLs must be absolute; the two window artifacts stay origin-agnostic relative — see
     the HOST_CLIENT header above. */
  base: HOST_CLIENT ? "/" : "./",
  plugins: [
    shellMessagesOnly(),
    ...(HOST_CLIENT ? [hostIndexName()] : [updaterProgressPage()]),
    react(),
    {
      /* The webview loads the bundle as an ES module, where `import.meta` is valid; the smoke test
         loads it as a CLASSIC script in jsdom (which cannot run module scripts), where `import.meta`
         is a syntax error that aborts boot and renders nothing. With the single dynamic import
         inlined (AttachmentPreview's pdf stub), the only `import.meta.url` left is vite's dynamic-
         import preload-helper argument — and with no dependencies to resolve it is never read, in
         either load context. Neutralise it to an empty string so the classic-script load parses. */
      name: "ohmail:neutralise-unused-import-meta",
      enforce: "post",
      renderChunk(code) {
        return code.includes("import.meta.url") ? code.split("import.meta.url").join('""') : null;
      },
    },
  ],

  define: {
    /* apps/webapp/app/shell/engine.tsx branches on this to pick FixturesAdapter
       vs HttpAdapter. Folding it to `undefined` at build time makes the Cloud
       branch statically dead; alias (2) above makes it unreachable regardless. */
    "process.env.NEXT_PUBLIC_API_BASE": "undefined",
    /* THIS IS A DESKTOP BUILD, folded through `engine-config.ts` (`syncsWhileHidden`) so the shared
       sync scheduler is told to keep polling while the window is occluded or unfocused. A desktop
       window is not a browser tab: `document.visibilityState` reads `hidden` when the OS composites
       it out of view, which would stop the sync loop on a mail client that is supposed to keep the
       mailbox current in the background. Set for BOTH desktop WINDOW artifacts — and deliberately
       NOT for the host client, which IS a browser tab: a phone page in the background dropping to
       the slow cadence is the battery-correct behaviour this define exists to disable in a window.
       The Next web build never defines this var, so `syncsWhileHidden()` is false there and browser
       tabs keep their hidden-tab-zero-syncs behaviour unchanged — a web-side guard fails if the
       flag ever leaks on (grep `syncsWhileHidden` in the web app's test suite). */
    "process.env.NEXT_PUBLIC_DESKTOP": HOST_CLIENT ? "undefined" : JSON.stringify("1"),
    /* `__OHMAIL_LOCAL_ENGINE__` was defined here while a fixtures-only preview artifact shared
       this entry — `main.tsx` branched on it and the bundler removed the arm not taken. The
       preview is retired, the entry has one arm, and the flag is gone with its last consumer
       (a define nothing reads is a knob that looks load-bearing and is not). */
    /* The version the installer is stamped with, for the About pane. Read from the manifest
       here rather than imported by the module that shows it: an import would compile the whole
       manifest — scripts, dependency ranges, the prose above them — into the artifact for one
       field. `tauri.conf.json` carries the same number and CI holds the two together. */
    __OHMAIL_VERSION__: JSON.stringify(
      (JSON.parse(fs.readFileSync(r("./package.json"), "utf8")) as { version: string }).version,
    ),
    /* The platform this bundle ships to — which is the platform it is BUILT on: the release
       workflow runs `tauri build` per platform (macos-15 / windows-latest / ubuntu-latest), one
       artifact each, and `ui:dev` runs on the machine in front of you. `src/platform.ts` maps it
       to the word the setup and settings copy uses ("this Mac" / "this PC" / "this computer");
       the webview's user agent is deliberately not consulted — WebKitGTK may present a Mac UA
       for site compatibility, which would keep the Linux build saying "Mac". */
    __OHMAIL_PLATFORM__: JSON.stringify(process.platform),
  },

  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      /* order matters: @rollup/plugin-alias matches `find` as a path prefix, so
         the longer specifier has to come first. */
      { find: "react-dom", replacement: r("./node_modules/react-dom") },
      { find: "react", replacement: r("./node_modules/react") },
      { find: "next-intl", replacement: r("./node_modules/use-intl") },

      /* The editor and the sanitizer, imported from apps/webapp/app/** rather than
         from anything under this directory — so they need pinning for the reason
         react does, and they are listed after it because a prefix match on "react"
         must not be given the chance to see "@tiptap/react". */
      { find: "@tiptap/react", replacement: r("./node_modules/@tiptap/react") },
      { find: "@tiptap/starter-kit", replacement: r("./node_modules/@tiptap/starter-kit") },
      { find: "@tiptap/extension-link", replacement: r("./node_modules/@tiptap/extension-link") },
      /* The ProseMirror surface under the editor — RichEditor.tsx's line-scoped block
         commands import NodeSelection/TextSelection and the node/position types from
         these two subpaths, from apps/webapp/app/** like the entries above. This pair
         moves with tsconfig.json's `paths` (the header's rule): the editor slice added
         the manifest entry and neither pin, so in a published checkout `tsc --noEmit`
         failed on the types and, with that repaired alone, `vite build` still could not
         resolve the runtime import — one tool reading the pins and the other not, the
         exact drift the header warns about. The targets are the package's committed
         proxy dirs (`state/index.ts` re-exporting prosemirror-state, likewise `model/`). */
      { find: "@tiptap/pm/state", replacement: r("./node_modules/@tiptap/pm/state") },
      { find: "@tiptap/pm/model", replacement: r("./node_modules/@tiptap/pm/model") },
      { find: "dompurify", replacement: r("./node_modules/dompurify") },
      /* pdf.js is kept OUT of the runtime bundle: the desktop window never previews a PDF inline
         (worker-src 'none'; an attachment opens in the platform's own viewer over
         `open_attachment`), and the real library's module-init breaks boot under the locked CSP.
         The dynamic import resolves to a no-op stub. tsconfig.json still points the TYPE at the
         real package, so AttachmentPreview.tsx typechecks against pdf.js. */
      { find: "pdfjs-dist", replacement: r("./src/no-pdfjs.ts") },

      /* Anchored at both ends: a RegExp `find` replaces only the matched span,
         so a pattern that leaves the leading "./" behind yields a broken path.

         IN BOTH ARTIFACTS — see seam (2) in the header. The window bundle and the
         served host client each render the shared shell, whose demo branch names
         the fixtures adapter; neither may carry the sample world, so the module
         resolves to the refusing stub and the corpus behind it never enters the
         graph. (The sync client, by contrast, is aliased in NEITHER artifact:
         both are engine-bearing and construct the real `HttpAdapter`.) */
      { find: /^(?:.*\/)?adapters\/fixtures-adapter\.js$/, replacement: r("./src/no-fixtures-adapter.ts") },

      /* The Cloud API client, absent — IN BOTH ARTIFACTS, and the lack of a
         `LOCAL_ENGINE` condition is the whole point rather than an oversight.
         Neither desktop artifact has a Cloud account or a server to reach: both
         talk to a local engine over a pipe, and `src/cloud-suggest.ts` imports
         this module's types only (`import type`), taking its transport through
         `src/bridge-fetch.ts`. The ten shell and view modules that import it all
         ask `apiConfigured()` first, and the stub answers `false` exactly where
         the real client — with no API base compiled in — throws `api_unconfigured`.

         WITHOUT THIS ALIAS THE BUNDLE BUILT HERE IS NOT THE BUNDLE THAT SHIPS.
         The published tree writes this same stub over `apps/webapp/app/api-client.ts`
         (`DEST_ALIASES` in `scripts/publish-desktop.mjs`), so every released binary
         has always been built against it; only the monorepo compiled the real
         module. That divergence was not theoretical — it put a `POST /auth/refresh`
         with an `X-CSRF-Token` header into the preview built here, from
         `app/session-refresh.ts`, a module that does not exist in the published
         tree at all. `scan-artifact.mjs` read the header correctly and failed, on
         bytes that ship nowhere. Aliasing here makes the artifact under the guard
         the artifact under the installer.

         Anchored so `no-api-client` cannot match itself: the optional group must
         end in `/`, and the character before `api-client` there is `-`. */
      { find: /^(?:.*\/)?api-client$/, replacement: r("./src/no-api-client.ts") },

      { find: "@ohmail/tokens/tokens.css", replacement: r("../../packages/tokens/src/tokens.css") },
      { find: "@ohmail/tokens/faces.css", replacement: r("../../packages/tokens/src/faces.css") },
      { find: "@ohmail/tokens/ohmarchy.css", replacement: r("../../packages/tokens/src/ohmarchy.css") },
      { find: "@ohmail/tokens", replacement: r("../../packages/tokens/src/index.ts") },
      /* `@ohmail/fixtures` needs no entry: its one importer was the real fixtures adapter, which
         the stub alias above takes out of the graph — so the corpus is unresolvable here by
         construction, not merely unimported. */
      { find: "@ohmail/client-engine", replacement: r("../../packages/client-engine/src/index.ts") },
      { find: "@ohmail/ui", replacement: r("../../packages/ui/src/index.ts") },

      /* The calendar reader — with `folder-name` and `drain-policy` below, one of the THREE
         `@trafficflow/*` specifiers that reach this bundle.
         It is imported by `packages/client-engine/src/engine.ts` and by the attachment strip
         and event card under `apps/webapp/app/components/`, all three of which are published.
         In THIS tree the specifier resolves without help, through the workspace link and
         `packages/core`'s own exports map — which is exactly why its absence here was
         invisible until the published tree built it: over there `packages/core/src/ics.ts` is
         a single published FILE with no package.json beside it and no workspace to link, so
         Rollup could not resolve the import and every platform job died at `vite build` while
         the engine bundle (which has its own resolver) went green beside them. Same reason the
         four entries above exist; listed after them because it is the same kind of seam. */
      { find: "@trafficflow/core/ics", replacement: r("../../packages/core/src/ics.ts") },
      /* The folder-name validator (FOLDERS-SPEC.md stage 2) — the rail's Folders group
         validates a create/rename BEFORE the wire with the same rules the server runs, and
         `FoldersRailGroup.tsx` is published shell. A browser-safe leaf (`types.ts` re-export,
         zero imports), resolved here for exactly `ics`'s reason. */
      { find: "@trafficflow/core/folder-name", replacement: r("../../packages/core/src/folder-name.ts") },
      /* The mirrors' shared drain policy (INSTANT-ARCH §6.7) — the staleness threshold, the
         dense-page limit and the three freshness states, held in ONE module so the client engine
         and the desktop sidecar's mirror cannot drift. `packages/client-engine/src/engine.ts`
         imports it, and that file is in this bundle, so the specifier has to resolve HERE for the
         same reason `ics` does: in the published tree there is no workspace link and no
         package.json beside the file, and Rollup would die at `vite build` on every platform.
         A browser-safe leaf like the two above — zero imports, no store, no clock, no DOM. */
      { find: "@trafficflow/core/drain-policy", replacement: r("../../packages/core/src/drain-policy.ts") },
    ],
  },

  build: {
    /* Two output directories, never shared: the WINDOW dist is what Tauri embeds and what the
       publish pins, and a host build writing into it would hand the artifact censuses a bundle
       they were not written for. `dist-host` is what `tauri.engine.conf.json` packages as the
       `host-client` resource and the engine's static handler serves. */
    outDir: HOST_CLIENT ? "dist-host" : "dist",
    emptyOutDir: true,
    /* Vite's modulepreload polyfill is the one line of the output that calls
       `fetch()` — it re-requests preload hrefs on browsers without native
       support. Every webview ohmail runs in (WKWebView, WebView2, WebKitGTK)
       has had modulepreload for years, and a bundle that grep-cleanly contains
       no `fetch(` at all is worth more here than a polyfill for browsers this
       app cannot be opened in. */
    modulePreload: false,
    /* Tauri ships the sources' shape, not their names — but a bundle that
       cannot be read back is not verifiable, so keep the module graph legible
       in the artifact inspection step. */
    sourcemap: false,
    target: "es2022",
    assetsInlineLimit: 0,
    /* THE PAIRED HALF of the window bundle's declared IIFE format (`output.format` below).
       Vite emits a separate stylesheet only for the `es` and `cjs` output formats; for every
       other format it folds the whole sheet into the chunk as a script-created <style>, which
       would mean the window paints unstyled until 1.5 MB of JavaScript has parsed and run —
       a white flash on a cold start, and a dark-theme one at that. With ONE chunk
       (`inlineDynamicImports`) there is nothing to code-split anyway, so a single stylesheet is
       the honest spelling of what this build already produces: `assets/style-<hash>.css`, whose
       content is byte-identical to the `assets/index-<hash>.css` it replaces (same content
       hash). The host arm keeps Vite's default. */
    ...(HOST_CLIENT ? {} : { cssCodeSplit: false }),
    /* Emit ONE chunk, no dynamic-import split. The shared shell's only dynamic import is
       AttachmentPreview.tsx's `import("pdfjs-dist")` (here a no-op stub — the desktop opens
       attachments in the platform's viewer). Vite otherwise code-splits it and wraps the call in a preload helper
       that references `import.meta.url`; the smoke loads the bundle as a CLASSIC script (jsdom cannot
       run module scripts), where `import.meta` is a syntax error that aborts the whole boot and
       renders nothing. Inlining removes the split and the `import.meta`, so the bundle boots as one
       file. The stub is tiny, so nothing is deferred that mattered. */
    rollupOptions: {
      /* The host client enters through its own document; the window artifacts keep the implicit
         root `index.html`. `hostIndexName()` renames the emission — see the plugin. */
      ...(HOST_CLIENT ? { input: r("./host.html") } : {}),
      output: {
        inlineDynamicImports: true,
        /* THE WINDOW BUNDLE IS A CLASSIC, SELF-CONTAINED SCRIPT — AND NOW IT IS DECLARED,
           NOT INCIDENTAL. `scripts/smoke.mjs` drops the `type="module"` attribute and runs the
           chunk in jsdom, which has no ESM loader; that substitution is a no-op only while the
           chunk really carries no top-level `import`/`export`. Nothing DECLARED that, so one
           new import took it away, and the failure is worth writing down because it is not
           where anyone looks:

             `packages/tokens/omarchy/mapping.js` is the palette law, pinned byte-identical to
             the prototype spec by two tests, and its UMD body assigns `module.exports` at the
             top level. Once it entered this graph the single chunk had NO ESM syntax left of
             its own — while carrying that one CommonJS marker. Vite's `vite:esbuild-transpile`
             runs esbuild over the whole rendered chunk with `format: "esm"`; esbuild therefore
             read the chunk as CommonJS and CONVERTED it, emitting
             `var m = __commonJS(…); … export default m();`. jsdom then died on the `export`
             before React mounted: 33 of 43 checks, on all three platform jobs at once, with no
             artifact to attach to a release.

           Vite's CommonJS interop is NOT what did this — its `include` is `[/node_modules/]`
           and it never sees this file. Measured, not inferred: excluding the file from
           `commonjsOptions` changed the output not at one byte, and `esbuild.transform` of a
           UMD body with `format: "esm"` reproduces the `__commonJS` + `export default` pair on
           its own.

           `format: "iife"` closes both halves by construction. Rollup wraps the chunk in a
           function expression, so no CommonJS marker is top-level any more; and Vite maps no
           esbuild format for `iife`, so esbuild is never asked to convert a format in the
           first place. The output is `(function(){"use strict"; … })();` — zero `import`,
           zero `export`, zero `import.meta` — which is what the smoke's comment always claimed
           and can now rely on.

           The HOST arm stays an ES module deliberately: it is served over HTTP to a real
           browser, nothing loads it as a classic script, and `mapping.js` is not in its graph
           (zero `OHMARCHY_MAP` in `dist-host`) — so it never had this defect to fix. */
        ...(HOST_CLIENT ? {} : { format: "iife" as const }),
      },
    },
  },

  server: { port: 5174, strictPort: true },
});
