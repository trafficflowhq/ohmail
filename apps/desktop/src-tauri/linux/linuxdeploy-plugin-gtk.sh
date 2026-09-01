#! /usr/bin/env bash
#
# ── THE APPIMAGE'S GTK PLUGIN, VENDORED ──────────────────────────────────────────────────────
#
# Upstream is linuxdeploy/linuxdeploy-plugin-gtk (MIT), by way of the tauri-apps fork. The Tauri
# bundler does not carry this file: it DOWNLOADS it, at bundle time, from the fork's `master`
# branch, into `~/.cache/tauri/linuxdeploy-plugin-gtk.sh`, and then uses whatever it got. That is
# the recipe for our Linux artifacts tracking somebody else's moving branch, so the workflow copies
# this file into that cache path first and the bundler finds it already there and downloads
# nothing. Pinning it is worth as much as the four changes below.
#
# The changes, each marked `ohmail:` at the line it touches:
#
#  1. **The bundled `libwayland-client.so.0` is removed.** The AppImage does not bundle the GL
#     stack — libEGL, libGL, libgbm and libdrm come from the host, by design, because they are the
#     host's drivers. But Mesa's `libEGL_mesa.so.0` has a `DT_NEEDED` on `libwayland-client.so.0`,
#     and an AppImage puts its own `usr/lib` ahead of the system path for every process it starts.
#     So the host's EGL driver gets loaded against OUR copy of libwayland-client rather than the
#     one it was built against. Where the host's Mesa is newer than the wayland this was built on,
#     that copy is missing interfaces the driver needs, the driver fails to load, and the only
#     thing said out loud is `Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...`
#     from inside the web process, which then aborts — a window that maps and never renders. The
#     AppImage project's own exclude list has carried `libwayland-client.so.0` for this exact
#     reason since 2024 ("New version of Mesa has some dependency issues with libwayland-client if
#     it is bundled"); the linuxdeploy build the bundler downloads has an older list compiled into
#     it and does not know. The removal is at the END of this script, after the nested linuxdeploy
#     run below, which is the last thing that can deploy a library.
#
#  2. **`GDK_BACKEND` is no longer forced to x11.** Forcing it sent every Wayland session through
#     XWayland, where the window is scaled 1x and reads blurry on a HiDPI display, and it did so
#     even when the caller had asked for something else. The comment it carried cites a 2024 crash
#     on GTK's Wayland backend that is a GSettings schema mismatch against a two-years-older GDK
#     than the one bundled here; the GDK in this bundle guards those reads. Anyone who needs the
#     old behaviour can now get it, because the variable is left to the caller.
#
#  3. **`GTK_PATH`'s system fallback is the running architecture's.** It was spelled
#     `/usr/lib/x86_64-linux-gnu/gtk-3.0` unconditionally, so the arm64 build carried a path no
#     arm64 machine has.
#
#  4. **The launcher takes `OHMAIL_SYSTEM_WEBKIT`.** Set it and the app runs against the host's
#     GTK and WebKitGTK instead of the bundled ones — one command for a machine where the bundled
#     stack cannot start, and a way to tell the two apart in a bug report.
#
# GTK3 environment variables: https://docs.gtk.org/gtk3/running.html
# GTK4 environment variables: https://docs.gtk.org/gtk4/running.html

# abort on all errors
set -e

if [ "$DEBUG" != "" ]; then
    set -x
    verbose="--verbose"
fi

script=$(readlink -f "$0")

show_usage() {
    echo "Usage: $script --appdir <path to AppDir>"
    echo
    echo "Bundles resources for applications that use GTK into an AppDir"
    echo
    echo "Required variables:"
    echo "  LINUXDEPLOY=\".../linuxdeploy\" path to linuxdeploy (e.g., AppImage); set automatically when plugin is run directly by linuxdeploy"
    #echo
    #echo "Optional variables:"
    #echo "  DEPLOY_GTK_VERSION (major version of GTK to deploy, e.g. '2', '3' or '4'; auto-detect by default)"
}

variable_is_true() {
    local var="$1"

    if [ -n "$var" ] && { [ "$var" == "true" ] || [ "$var" -gt 0 ]; } 2> /dev/null; then
        return 0 # true
    else
        return 1 # false
    fi
}

get_pkgconf_variable() {
    local variable="$1"
    local library="$2"
    local default_path="$3"

    path="$("$PKG_CONFIG" --variable="$variable" "$library")"
    if [ -n "$path" ]; then
        echo "$path"
    elif [ -n "$default_path" ]; then
        echo "$default_path"
    else
        echo "$0: there is no '$variable' variable for '$library' library." > /dev/stderr
        echo "Please check the '$library.pc' file is present in \$PKG_CONFIG_PATH (you may need to install the appropriate -dev/-devel package)." > /dev/stderr
        exit 1
    fi
}

copy_tree() {
    local src=("${@:1:$#-1}")
    local dst="${*:$#}"

    for elem in "${src[@]}"; do
        mkdir -p "${dst::-1}$elem"
        cp "$elem" --archive --parents --target-directory="$dst" $verbose
    done
}

search_tool() {
    local tool="$1"
    local directory="$2"

    if command -v "$tool"; then
        return 0
    fi

    PATH_ARRAY=(
        "/usr/lib/$(uname -m)-linux-gnu/$directory/$tool"
        "/usr/lib/$directory/$tool"
        "/usr/bin/$tool"
        "/usr/bin/$tool-64"
        "/usr/bin/$tool-32"
    )

    for path in "${PATH_ARRAY[@]}"; do
        if [ -x "$path" ]; then
            echo "$path"
            return 0
        fi
    done
}

#DEPLOY_GTK_VERSION="${DEPLOY_GTK_VERSION:-0}" # When not set by user, this variable use the integer '0' as a sentinel value
DEPLOY_GTK_VERSION=3 # Force GTK3 for tauri apps
APPDIR=

while [ "$1" != "" ]; do
    case "$1" in
        --plugin-api-version)
            echo "0"
            exit 0
            ;;
        --appdir)
            APPDIR="$2"
            shift
            shift
            ;;
        --help)
            show_usage
            exit 0
            ;;
        *)
            echo "Invalid argument: $1"
            echo
            show_usage
            exit 1
            ;;
    esac
done

if [ "$APPDIR" == "" ]; then
    show_usage
    exit 1
fi

mkdir -p "$APPDIR"
# make lib64 writable again.
chmod +w "$APPDIR"/usr/lib64 || true

if command -v pkgconf > /dev/null; then
    PKG_CONFIG="pkgconf"
elif command -v pkg-config > /dev/null; then
    PKG_CONFIG="pkg-config"
else
    echo "$0: pkg-config/pkgconf not found in PATH, aborting"
    exit 1
fi

if ! command -v find &>/dev/null && ! type find &>/dev/null; then
    echo -e "$0: find not found.\nInstall findutils then re-run the plugin."
    exit 1
fi

if [ -z "$LINUXDEPLOY" ]; then
    echo -e "$0: LINUXDEPLOY environment variable is not set.\nDownload a suitable linuxdeploy AppImage, set the environment variable and re-run the plugin."
    exit 1
fi

gtk_versions=0 # Count major versions of GTK when auto-detect GTK version
if [ "$DEPLOY_GTK_VERSION" -eq 0 ]; then
    echo "Determining which GTK version to deploy"
    while IFS= read -r -d '' file; do
        if [ "$DEPLOY_GTK_VERSION" -ne 2 ] && ldd "$file" | grep -q "libgtk-x11-2.0.so"; then
            DEPLOY_GTK_VERSION=2
            gtk_versions="$((gtk_versions+1))"
        fi
        if [ "$DEPLOY_GTK_VERSION" -ne 3 ] && ldd "$file" | grep -q "libgtk-3.so"; then
            DEPLOY_GTK_VERSION=3
            gtk_versions="$((gtk_versions+1))"
        fi
        if [ "$DEPLOY_GTK_VERSION" -ne 4 ] && ldd "$file" | grep -q "libgtk-4.so"; then
            DEPLOY_GTK_VERSION=4
            gtk_versions="$((gtk_versions+1))"
        fi
    done < <(find "$APPDIR/usr/bin" -executable -type f -print0)
fi

if [ "$gtk_versions" -gt 1 ]; then
    echo "$0: can not deploy multiple GTK versions at the same time."
    echo "Please set DEPLOY_GTK_VERSION to {2, 3, 4}."
    exit 1
elif [ "$DEPLOY_GTK_VERSION" -eq 0 ]; then
    echo "$0: failed to auto-detect GTK version."
    echo "Please set DEPLOY_GTK_VERSION to {2, 3, 4}."
    exit 1
fi

echo "Installing AppRun hook"
HOOKSDIR="$APPDIR/apprun-hooks"
HOOKFILE="$HOOKSDIR/linuxdeploy-plugin-gtk.sh"
mkdir -p "$HOOKSDIR"
cat > "$HOOKFILE" <<\EOF
#! /usr/bin/env bash

gsettings get org.gnome.desktop.interface gtk-theme 2> /dev/null | grep -qi "dark" && GTK_THEME_VARIANT="dark" || GTK_THEME_VARIANT="light"
APPIMAGE_GTK_THEME="${APPIMAGE_GTK_THEME:-"Adwaita:$GTK_THEME_VARIANT"}" # Allow user to override theme (discouraged)

export APPDIR="${APPDIR:-"$(dirname "$(realpath "$0")")"}" # Workaround to run extracted AppImage

# ohmail: run against the host's GTK and WebKitGTK instead of the bundled ones.
#
# Two things have to be defeated, not one, and the second is easy to miss. The AppImage's own
# launcher puts $APPDIR/usr/lib on LD_LIBRARY_PATH for everything it starts and nothing downstream
# can take it back off — hence the exec from HERE, which the launcher sources before it sets
# anything, and hence this being the first thing in the file rather than the last.
#
# But exec'ing the binary is NOT enough on its own: linuxdeploy patches `usr/bin/ohmail` with
# DT_RUNPATH=$ORIGIN/../lib, and every bundled library with DT_RUNPATH=$ORIGIN, so the loader
# finds our copies from the binary's own headers with the environment completely clean. The
# loader searches LD_LIBRARY_PATH BEFORE DT_RUNPATH, so naming the system directories explicitly
# is what actually moves the resolution. Measured on a released artifact: exec alone resolved
# libwebkit2gtk, libgtk-3 and libsoup out of the AppDir; with the list below, none of the
# binary's dependencies came from the AppDir at all.
#
# A library the host does NOT have still falls through to DT_RUNPATH and loads from the bundle —
# the tray's appindicator, typically. That is the intended order: prefer the host's, keep ours as
# the fallback for the pieces a distribution does not ship.
if [ -n "$OHMAIL_SYSTEM_WEBKIT" ]; then
    echo "ohmail: OHMAIL_SYSTEM_WEBKIT is set — using the system GTK and WebKitGTK" >&2
    _ohmail_sys=""
    for _ohmail_d in "/usr/lib/$(uname -m)-linux-gnu" /usr/lib64 /usr/lib \
                     "/lib/$(uname -m)-linux-gnu" /lib64 /lib; do
        # `if`, not `[ -d … ] && …`: AppRun sources this file under `set -e`, where a compound
        # ending in a false test would take the whole launcher down.
        if [ -d "$_ohmail_d" ]; then
            _ohmail_sys="${_ohmail_sys:+$_ohmail_sys:}$_ohmail_d"
        fi
    done
    # An empty list would mean LD_LIBRARY_PATH="" — no directories, the loader falls straight
    # through to the binary's own DT_RUNPATH, and the escape silently does not escape. That is the
    # exact failure this branch was rewritten to stop being, so it says so instead of pretending.
    if [ -z "$_ohmail_sys" ]; then
        echo "ohmail: no system library directory found — cannot use the system GTK and WebKitGTK" >&2
        exit 1
    fi
    LD_LIBRARY_PATH="$_ohmail_sys" exec "$APPDIR/usr/bin/ohmail" "$@"
fi

export GTK_DATA_PREFIX="$APPDIR"
export GTK_THEME="$APPIMAGE_GTK_THEME" # Custom themes are broken
# ohmail: GDK_BACKEND is the caller's to set. Upstream exports x11 here unconditionally, which
# puts every Wayland session on XWayland at 1x — blurry on a HiDPI display — and overrides a
# caller who asked for something else. The crash it cites
# (https://github.com/tauri-apps/tauri/issues/8541) is a GSettings schema mismatch reported
# against a GDK two years older than the one bundled here, which guards those reads.
export XDG_DATA_DIRS="$APPDIR/usr/share:/usr/share:$XDG_DATA_DIRS" # g_get_system_data_dirs() from GLib
EOF

echo "Installing GLib schemas"
# Note: schemasdir is undefined on Ubuntu 16.04
glib_schemasdir="$(get_pkgconf_variable "schemasdir" "gio-2.0" "/usr/share/glib-2.0/schemas")"
copy_tree "$glib_schemasdir" "$APPDIR/"
glib-compile-schemas "$APPDIR/$glib_schemasdir"
cat >> "$HOOKFILE" <<EOF
export GSETTINGS_SCHEMA_DIR="\$APPDIR/$glib_schemasdir"
EOF

case "$DEPLOY_GTK_VERSION" in
    2)
        # https://github.com/linuxdeploy/linuxdeploy-plugin-gtk/pull/20#issuecomment-826354261
        echo "WARNING: Gtk+2 applications are not fully supported by this plugin"
        ;;
    3)
        echo "Installing GTK 3.0 modules"
        gtk3_exec_prefix="$(get_pkgconf_variable "exec_prefix" "gtk+-3.0")"
        gtk3_libdir="$(get_pkgconf_variable "libdir" "gtk+-3.0")/gtk-3.0"
        #gtk3_path="$gtk3_libdir/modules" export GTK_PATH="\$APPDIR/$gtk3_path"
        gtk3_immodulesdir="$gtk3_libdir/$(get_pkgconf_variable "gtk_binary_version" "gtk+-3.0")/immodules"
        gtk3_printbackendsdir="$gtk3_libdir/$(get_pkgconf_variable "gtk_binary_version" "gtk+-3.0")/printbackends"
        gtk3_immodules_cache_file="$(dirname "$gtk3_immodulesdir")/immodules.cache"
        gtk3_immodules_query="$(search_tool "gtk-query-immodules-3.0" "libgtk-3-0")"
        copy_tree "$gtk3_libdir" "$APPDIR/"
        # ohmail: GTK_PATH's system fallback below is `$gtk3_libdir` — the SAME directory
        # pkg-config just named, minus the AppDir prefix. Upstream spells one architecture's
        # triple there as a literal, which put a GTK module directory no arm64 machine has into
        # the arm64 build. The comment is out here rather than in the heredoc on purpose: what
        # goes into the heredoc is written into the launcher, and CI reads the launcher for
        # foreign architecture triples — a comment naming one would fail that check.
        cat >> "$HOOKFILE" <<EOF
export GTK_EXE_PREFIX="\$APPDIR/$gtk3_exec_prefix"
export GTK_PATH="\$APPDIR/$gtk3_libdir:/usr/lib64/gtk-3.0:$gtk3_libdir"
export GTK_IM_MODULE_FILE="\$APPDIR/$gtk3_immodules_cache_file"

EOF
        if [ -x "$gtk3_immodules_query" ]; then
            echo "Updating immodules cache in $APPDIR/$gtk3_immodules_cache_file"
            "$gtk3_immodules_query" > "$APPDIR/$gtk3_immodules_cache_file"
        else
            echo "WARNING: gtk-query-immodules-3.0 not found"
        fi
        if [ ! -f "$APPDIR/$gtk3_immodules_cache_file" ]; then
            echo "WARNING: immodules.cache file is missing"
        fi
        sed -i "s|$gtk3_libdir/3.0.0/immodules/||g" "$APPDIR/$gtk3_immodules_cache_file"
        ;;
    4)
        echo "Installing GTK 4.0 modules"
        gtk4_exec_prefix="$(get_pkgconf_variable "exec_prefix" "gtk4" "/usr")"
        gtk4_libdir="$(get_pkgconf_variable "libdir" "gtk4")/gtk-4.0"
        gtk4_path="$gtk4_libdir/modules"
        copy_tree "$gtk4_libdir" "$APPDIR/"
        cat >> "$HOOKFILE" <<EOF
export GTK_EXE_PREFIX="\$APPDIR/$gtk4_exec_prefix"
export GTK_PATH="\$APPDIR/$gtk4_path"
EOF
        ;;
    *)
        echo "$0: '$DEPLOY_GTK_VERSION' is not a valid GTK major version."
        echo "Please set DEPLOY_GTK_VERSION to {2, 3, 4}."
        exit 1
esac

echo "Installing GDK PixBufs"
gdk_libdir="$(get_pkgconf_variable "libdir" "gdk-pixbuf-2.0")"
gdk_pixbuf_binarydir="$(get_pkgconf_variable "gdk_pixbuf_binarydir" "gdk-pixbuf-2.0")"
gdk_pixbuf_cache_file="$(get_pkgconf_variable "gdk_pixbuf_cache_file" "gdk-pixbuf-2.0")"
gdk_pixbuf_moduledir="$(get_pkgconf_variable "gdk_pixbuf_moduledir" "gdk-pixbuf-2.0")"
# Note: gdk_pixbuf_query_loaders variable is not defined on some systems
gdk_pixbuf_query="$(search_tool "gdk-pixbuf-query-loaders" "gdk-pixbuf-2.0")"
copy_tree "$gdk_pixbuf_binarydir" "$APPDIR/"
cat >> "$HOOKFILE" <<EOF
export GDK_PIXBUF_MODULE_FILE="\$APPDIR/$gdk_pixbuf_cache_file"
EOF
if [ -x "$gdk_pixbuf_query" ]; then
    echo "Updating pixbuf cache in $APPDIR/$gdk_pixbuf_cache_file"
    "$gdk_pixbuf_query" > "$APPDIR/$gdk_pixbuf_cache_file"
else
    echo "WARNING: gdk-pixbuf-query-loaders not found"
fi
if [ ! -f "$APPDIR/$gdk_pixbuf_cache_file" ]; then
    echo "WARNING: loaders.cache file is missing"
fi
sed -i "s|$gdk_pixbuf_moduledir/||g" "$APPDIR/$gdk_pixbuf_cache_file"

echo "Copying more libraries"
gobject_libdir="$(get_pkgconf_variable "libdir" "gobject-2.0")"
gio_libdir="$(get_pkgconf_variable "libdir" "gio-2.0")"
librsvg_libdir="$(get_pkgconf_variable "libdir" "librsvg-2.0")"
pango_libdir="$(get_pkgconf_variable "libdir" "pango")"
pangocairo_libdir="$(get_pkgconf_variable "libdir" "pangocairo")"
pangoft2_libdir="$(get_pkgconf_variable "libdir" "pangoft2")"
FIND_ARRAY=(
    "$gdk_libdir"     "libgdk_pixbuf-*.so*"
    "$gobject_libdir" "libgobject-*.so*"
    "$gio_libdir"     "libgio-*.so*"
    "$librsvg_libdir" "librsvg-*.so*"
    "$pango_libdir"      "libpango-*.so*"
    "$pangocairo_libdir" "libpangocairo-*.so*"
    "$pangoft2_libdir"   "libpangoft2-*.so*"
)
LIBRARIES=()
for (( i=0; i<${#FIND_ARRAY[@]}; i+=2 )); do
    directory=${FIND_ARRAY[i]}
    library=${FIND_ARRAY[i+1]}
    while IFS= read -r -d '' file; do
        LIBRARIES+=( "--library=$file" )
    done < <(find "$directory" \( -type l -o -type f \) -name "$library" -print0)
done

env LINUXDEPLOY_PLUGIN_MODE=1 "$LINUXDEPLOY" --appdir="$APPDIR" "${LIBRARIES[@]}"

# Create symbolic links as a workaround
# Details: https://github.com/linuxdeploy/linuxdeploy-plugin-gtk/issues/24#issuecomment-1030026529
echo "Manually setting rpath for GTK modules"
PATCH_ARRAY=(
    "$gtk3_immodulesdir"
    "$gtk3_printbackendsdir"
    "$gdk_pixbuf_moduledir"
)
for directory in "${PATCH_ARRAY[@]}"; do
    while IFS= read -r -d '' file; do
        ln $verbose -s "${file/\/usr\/lib\//}" "$APPDIR/usr/lib"
    done < <(find "$directory" -name '*.so' -print0)
done

# set write permission on lib64 again to make it deletable.
chmod +w "$APPDIR"/usr/lib64 || true

# We have to copy the files first to not get permission errors when we assign gio_extras_dir
find /usr/lib* -name libgiognutls.so -exec mkdir -p "$APPDIR"/"$(dirname '{}')" \; -exec cp --parents '{}' "$APPDIR/" \; || true
# related files that we seemingly don't need:
# libgiolibproxy.so - libgiognomeproxy.so - glib-pacrunner

gio_extras_dir=$(find "$APPDIR"/usr/lib* -name libgiognutls.so -exec dirname '{}' \; 2>/dev/null)
cat >> "$HOOKFILE" <<EOF
export GIO_EXTRA_MODULES="\$APPDIR/${gio_extras_dir#"$APPDIR"/}"
EOF

#binary patch absolute paths in libwebkit files
find "$APPDIR"/usr/lib* -name 'libwebkit*' -exec sed -i -e "s|/usr|././|g" '{}' \;

# ── ohmail: THE EXCLUDE LIST linuxdeploy IS TOO OLD TO KNOW ABOUT ────────────────────────────
#
# linuxdeploy refuses to bundle a set of libraries that have to come from the host — the GL
# drivers, the C library, libstdc++ — from a list compiled into the binary when it was built. The
# AppImage project maintains that list, and it has moved since: `libwayland-client.so.0` was added
# in 2024, with the reason recorded beside it — "New version of Mesa has some dependency issues
# with libwayland-client if it is bundled". The linuxdeploy build in use here predates the entry,
# deploys the library, and the AppImage then shadows the host's copy for every process it starts,
# including the web process. Where the host's Mesa is newer than the wayland this was built
# against, its EGL driver cannot load against our copy; the failure surfaces only as
#
#     Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
#
# from the web process, which aborts, leaving a window that maps and never draws.
#
# This runs LAST on purpose. The nested `linuxdeploy` call above is the final thing in this script
# that can deploy a library, so anything removed before it can come back.
#
# https://github.com/AppImage/pkg2appimage/blob/master/excludelist
# https://gitlab.freedesktop.org/mesa/mesa/-/issues/11316
for excluded in libwayland-client.so.0; do
    while IFS= read -r -d '' found; do
        echo "ohmail: removing $found (host-provided; see the exclude list note above)"
        rm -f "$found"
    done < <(find "$APPDIR" -name "$excluded" -print0 2>/dev/null)
done
