### The settings document in ohmail/_meta names the app version that wrote it

The phone and the desktop app wrote `0.0.0` as the writer's version in the "ohmail settings for this mailbox"
document they keep in `ohmail/_meta`. They now write their own app version, so another device can tell which
build saved the settings.
