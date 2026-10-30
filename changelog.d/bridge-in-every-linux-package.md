### The .deb, .rpm and Flatpak builds no longer vanish when an accessibility tool reads their window

The Linux AppImage already carried an accessibility bridge with the upstream fixes for a crash: with a
screen reader, an automation tool or another accessibility client coming and going, the app could close
without a word. The .deb, the .rpm and the Flatpak now carry the same bridge too, and load it ahead of
your distribution's or the runtime's. Nothing else about how they use your system's libraries changes.
