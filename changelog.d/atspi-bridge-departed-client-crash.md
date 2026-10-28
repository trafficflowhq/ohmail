### The Linux AppImage no longer vanishes when an accessibility tool reads its window

With a screen reader, an automation tool or another accessibility client coming and going, the Linux
desktop app could close without a word: the accessibility bridge it bundles (at-spi2-core 2.52.0) kept
entries for parts of the window that were already gone, and the next client that looked at the app made
it read freed memory. The AppImage now carries that bridge with the upstream fixes, and also lets go of
clients that have left instead of keeping their connections. This is the AppImage only (x86_64 and
arm64); the .deb and the .rpm use your distribution's bridge.
