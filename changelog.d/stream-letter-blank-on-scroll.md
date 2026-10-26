### A letter in Receipts or News no longer goes blank when you scroll on Linux Wayland desktops

On the Linux desktop app under a Wayland compositor such as Hyprland, a letter shown in its original design
in Receipts or News could turn blank as soon as the stream scrolled, with its sender and subject still
drawn, and came back only when something opened over the window. On Wayland the app now asks WebKitGTK to
hand its frames to the window through shared memory instead of DMA-BUF buffers; painting stays on the GPU.
X sessions keep WebKitGTK's default. Setting `WEBKIT_DMABUF_RENDERER_FORCE_SHM=0` before starting ohmail
restores the default on Wayland too.
