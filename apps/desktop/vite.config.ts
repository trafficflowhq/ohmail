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
 *  · the PREVIEW (default) is what has shipped so far — fixture mail, no engine, no adapter that
 *    could reach anything. The sync client is aliased to a stub whose constructor throws, and the
 *    bridge to a local engine is not in the bundle at all;
 *  · the LOCAL-ENGINE build carries the real client and `src/bridge-fetch.ts`, which is the only
 *    thing in either output that can address anything outside the page — and it addresses the
 *    shell, not the network.
 *
 * An environment variable rather than a Vite `mode`, because the Rust half is selected by a Cargo
 * feature (`local-engine`) and the two must be set together: `npm run ui:build:engine` produces
 * the bundle that belongs in a binary built with that feature, and `npm run ui:build` produces the
 * one that belongs in a binary built without it. Pairing them the other way gives a window with a
 * bridge and no commands to call, or commands with nothing to call them.
 *
 * The variable is set by the SCRIPT rather than by the caller's shell — see `scripts/build-ui.mjs`
 * — because `OHMAIL_LOCAL_ENGINE=1 vite build` is POSIX syntax that cmd.exe reads as a program
 * name, and Windows is one of the platforms this app ships to.
 */
const LOCAL_ENGINE = process.env.OHMAIL_LOCAL_ENGINE === "1";

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
] as const;

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
        const missing = SHELL_MESSAGE_NAMESPACES.filter((ns) => !(ns in all));
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
 *  2. `./adapters/http-adapter.js` → `src/no-http-adapter.ts`, IN THE PREVIEW ONLY.
 *     That artifact has no engine to talk to, so its sync client is not merely
 *     unused, it is not in the module graph: grep the preview's output and there
 *     is no request builder to find.
 *
 *     The ENGINE build resolves the real module, and must — it is the client that
 *     runs the mail against the engine on this machine, over the bridge. That is
 *     what the `LOCAL_ENGINE ? [] : [alias]` below says, and it is why the real
 *     module is published: a binary that carries it has to offer it. This note
 *     used to claim the file was published nowhere, which stayed true right up
 *     until a second artifact existed, and then shipped a window that went blank
 *     the moment a mailbox served, because the stub was standing in for a class
 *     the artifact constructs. `scan-artifact.mjs` now asserts which of the two
 *     each bundle contains, in both directions.
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
  base: "./",
  plugins: [
    shellMessagesOnly(),
    updaterProgressPage(),
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
       mailbox current in the background. Set for BOTH desktop artifacts. The Next web build never
       defines this var, so `syncsWhileHidden()` is false there and browser tabs keep their
       hidden-tab-zero-syncs behaviour unchanged — a web-side guard fails if the flag ever leaks on
       (grep `syncsWhileHidden` in the web app's test suite). */
    "process.env.NEXT_PUBLIC_DESKTOP": JSON.stringify("1"),
    /* Which artifact this is, as a literal. `main.tsx` branches on it, and the
       bundler removes the branch it did not take — so the preview does not carry
       a dormant bridge and the engine build does not carry a dead stub. See
       `src/build-flags.d.ts` for the declaration the type checker reads. */
    __OHMAIL_LOCAL_ENGINE__: JSON.stringify(LOCAL_ENGINE),
    /* The version the installer is stamped with, for the About pane. Read from the manifest
       here rather than imported by the module that shows it: an import would compile the whole
       manifest — scripts, dependency ranges, the prose above them — into the artifact for one
       field. `tauri.conf.json` carries the same number and CI holds the two together. */
    __OHMAIL_VERSION__: JSON.stringify(
      (JSON.parse(fs.readFileSync(r("./package.json"), "utf8")) as { version: string }).version,
    ),
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
      { find: "dompurify", replacement: r("./node_modules/dompurify") },
      /* pdf.js is kept OUT of the runtime bundle: the shell is fixtures-only (no attachment bytes,
         worker-src 'none'), so it never previews a PDF, and the real library's module-init breaks
         boot under the locked CSP. The dynamic import resolves to a no-op stub. tsconfig.json still
         points the TYPE at the real package, so AttachmentPreview.tsx typechecks against pdf.js. */
      { find: "pdfjs-dist", replacement: r("./src/no-pdfjs.ts") },

      /* Anchored at both ends: a RegExp `find` replaces only the matched span,
         so a pattern that leaves the leading "./" behind yields a broken path.

         PRESENT IN THE PREVIEW ONLY. The local-engine build needs the real
         adapter — it is the client that runs against the engine, over the bridge
         in `src/bridge-fetch.ts` rather than over a socket — so the stub is not
         aliased in there. Everything the stub's header says about the preview
         stays exactly as true: that build still has no request builder, no CSRF
         header and no cursor protocol in it, because that build still has the
         alias. */
      ...(LOCAL_ENGINE
        ? []
        : [{ find: /^(?:.*\/)?adapters\/http-adapter\.js$/, replacement: r("./src/no-http-adapter.ts") }]),

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
      { find: "@ohmail/tokens", replacement: r("../../packages/tokens/src/index.ts") },
      { find: "@ohmail/fixtures", replacement: r("../../packages/fixtures/src/index.ts") },
      { find: "@ohmail/client-engine", replacement: r("../../packages/client-engine/src/index.ts") },
      { find: "@ohmail/ui", replacement: r("../../packages/ui/src/index.ts") },

      /* The calendar reader, and the ONE `@trafficflow/*` specifier that reaches this bundle.
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
    ],
  },

  build: {
    outDir: "dist",
    emptyOutDir: true,
    /* Vite's modulepreload polyfill is the one line of the output that calls
       `fetch()` — it re-requests preload hrefs on browsers without native
       support. Every webview ohmail runs in (WKWebView, WebView2, WebKitGTK)
       has had modulepreload for years, and a bundle that grep-cleanly contains
       no `fetch(` at all is worth more here than a polyfill for browsers this
       app cannot be opened in. */
    modulePreload: false,
    /* Tauri ships the sources' shape, not their names — but a preview that
       cannot be read back is not verifiable, so keep the module graph legible
       in the artifact inspection step. */
    sourcemap: false,
    target: "es2022",
    assetsInlineLimit: 0,
    /* Emit ONE chunk, no dynamic-import split. The shared shell's only dynamic import is
       AttachmentPreview.tsx's `import("pdfjs-dist")` (here a no-op stub — the preview never runs in
       this fixtures-only shell). Vite otherwise code-splits it and wraps the call in a preload helper
       that references `import.meta.url`; the smoke loads the bundle as a CLASSIC script (jsdom cannot
       run module scripts), where `import.meta` is a syntax error that aborts the whole boot and
       renders nothing. Inlining removes the split and the `import.meta`, so the bundle boots as one
       file. The stub is tiny, so nothing is deferred that mattered. */
    rollupOptions: { output: { inlineDynamicImports: true } },
  },

  server: { port: 5174, strictPort: true },
});
