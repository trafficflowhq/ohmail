; THE WINDOWS MAIL-CLIENT REGISTRATION — what makes ohmail a CANDIDATE, never the choice.
;
; Windows keeps "which app opens mailto links" as the user's own setting, under a UserChoice key
; whose Hash value exists precisely so a program cannot write it. So this installer does the two
; things an app legitimately does, and no third:
;
;   1. registers a ProgId (`ohmail.mailto`) that says HOW to open a mailto link with this app, and
;   2. registers the app's CAPABILITIES (RegisteredApplications → Capabilities → URLAssociations),
;      which is what makes ohmail appear under Settings → Apps → Default apps → Email.
;
; The choice itself is made by the person, on that Settings page — the app's "Make default" action
; deep-links `ms-settings:defaultapps` and stops there (`src/default_mail.rs` states the same rule
; from the other side). Nothing here touches UserChoice.
;
; The bundler's own deep-link section (generated from `plugins.deep-link.desktop.schemes`) has
; already written `Software\Classes\mailto` and `Software\Classes\ohmail` by the time the
; POSTINSTALL hook runs — the per-scheme legacy keys, which UserChoice outranks and the
; uninstaller cleans. What it cannot write is the capability model below, which is why this file
; exists.
;
; SHCTX follows the install mode — `currentUser` in `tauri.conf.json`, so these land in HKCU,
; the hive a per-user install owns. `desktop-shell.test.ts` holds the ProgId spelling together
; with the one `default_mail.rs` detects against.

!macro NSIS_HOOK_POSTINSTALL
  ; The ProgId: how a mailto link opens with this app, under a name that is ours alone.
  WriteRegStr SHCTX "Software\Classes\ohmail.mailto" "" "ohmail email link"
  WriteRegStr SHCTX "Software\Classes\ohmail.mailto\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\ohmail.mailto\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  ; The capability record, under the mail clients' own branch.
  WriteRegStr SHCTX "Software\Clients\Mail\ohmail" "" "ohmail"
  WriteRegStr SHCTX "Software\Clients\Mail\ohmail\Capabilities" "ApplicationName" "ohmail"
  WriteRegStr SHCTX "Software\Clients\Mail\ohmail\Capabilities" "ApplicationDescription" "Consent-first email on the mailbox you already have."
  WriteRegStr SHCTX "Software\Clients\Mail\ohmail\Capabilities\URLAssociations" "mailto" "ohmail.mailto"

  ; The pointer Settings reads: an application name, and where its capabilities are written.
  WriteRegStr SHCTX "Software\RegisteredApplications" "ohmail" "Software\Clients\Mail\ohmail\Capabilities"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Everything the hook above wrote, and nothing else — the per-scheme keys are the bundler's
  ; own section's to clean, and UserChoice is not ours to touch in either direction. Windows
  ; drops a choice whose ProgId has gone.
  DeleteRegValue SHCTX "Software\RegisteredApplications" "ohmail"
  DeleteRegKey SHCTX "Software\Clients\Mail\ohmail"
  DeleteRegKey SHCTX "Software\Classes\ohmail.mailto"
!macroend
