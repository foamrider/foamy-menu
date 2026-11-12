// The environment for a qs that a node test starts itself, isolated the way
// foamy-kit's harness isolates its runs (preview/harness.py, hostenv.isolate):
// temporary HOME/TMPDIR/XDG directories, offscreen Qt, no compositor or X11
// display, a dead session and system bus, no audio server, and a PATH
// without Omarchy's bin directories or the running AppImage's ($APPDIR).
// Every `omarchy`/`omarchy-*` still on PATH (in ~/.local/bin or /usr/bin) is
// shadowed by a stub that exits 127 and logs the call; hostCommands() lists
// them. A test whose QML must run a host command gives it a stand-in in
// front of env.PATH.
const fs = require("node:fs")
const path = require("node:path")

const INSTALLED_BIN = "/usr/share/omarchy/bin"
const DISPLAY_VARIABLES = ["WAYLAND_DISPLAY", "HYPRLAND_INSTANCE_SIGNATURE", "DISPLAY"]
const HOST_STUB = `#!/bin/sh
printf '%s\\n' "\${0##*/} $*" >> "$FOAMY_HOST_COMMANDS_LOG"
echo "foamy-menu test: \${0##*/} is a host command; give the test a stand-in" >&2
exit 127
`

// A missing or unreadable directory on PATH is skipped, not an error.
function missing(error) {
  return error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES"
}

function realpath(folder) {
  try {
    return fs.realpathSync(folder)
  } catch (error) {
    if (!missing(error)) throw error
    return path.resolve(folder)
  }
}

// The installed bin directory, the test tree's and $OMARCHY_PATH's.
function omarchyBins() {
  const bins = [INSTALLED_BIN]
  if (process.env.OMARCHY_PATH) bins.push(path.join(process.env.OMARCHY_PATH, "bin"))
  if (process.env.OMARCHY_TEST_ROOT) bins.push(path.join(process.env.OMARCHY_TEST_ROOT, "bin"))
  if (process.env.FOAMY_HOST_45) bins.push(path.join(path.dirname(process.env.FOAMY_HOST_45), "bin"))
  return new Set(bins.map(realpath))
}

function inAppdir(folder) {
  const appdir = (process.env.APPDIR || "").replace(/\/+$/, "")
  return appdir !== "" && (folder === appdir || folder.startsWith(appdir + "/"))
}

function hostCommandNames(folder) {
  try {
    return fs.readdirSync(folder).filter(name => /^omarchy(-|$)/.test(name))
  } catch (error) {
    if (!missing(error)) throw error
    return []
  }
}

// `root` is the test's own temporary directory; everything goes inside it.
function isolatedQs(root) {
  const bins = omarchyBins()
  const kept = (process.env.PATH || "/usr/bin:/bin").split(":").filter(p => p && !bins.has(realpath(p)) && !inAppdir(p))
  const hostBin = path.join(root, "host-bin")
  fs.mkdirSync(hostBin)
  for (const name of new Set(kept.flatMap(hostCommandNames))) fs.writeFileSync(path.join(hostBin, name), HOST_STUB, { mode: 0o755 })
  const log = path.join(root, "host-commands.log")
  const env = { ...process.env }
  for (const name of [...DISPLAY_VARIABLES, "OMARCHY_PATH", "PULSE_RUNTIME_PATH", "PIPEWIRE_RUNTIME_DIR", "PULSE_COOKIE"]) delete env[name]
  const libraries = (env.LD_LIBRARY_PATH || "").split(":").filter(p => p && !inAppdir(p))
  if (libraries.length) env.LD_LIBRARY_PATH = libraries.join(":")
  else delete env.LD_LIBRARY_PATH
  Object.assign(env, {
    PATH: [hostBin, ...kept].join(":"),
    FOAMY_HOST_COMMANDS_LOG: log,
    HOME: root,
    TMPDIR: root,
    QT_QPA_PLATFORM: "offscreen",
    QT_QPA_PLATFORMTHEME: "basic",
    QML_DISABLE_DISK_CACHE: "1",
    // Set even when the caller had none: an unset session address falls
    // back to $XDG_RUNTIME_DIR/bus, the login session's.
    DBUS_SESSION_BUS_ADDRESS: "unix:path=" + path.join(root, "no-session-bus"),
    DBUS_SYSTEM_BUS_ADDRESS: "unix:path=" + path.join(root, "no-system-bus"),
    PULSE_SERVER: "unix:" + path.join(root, "no-pulse"),
    PIPEWIRE_REMOTE: path.join(root, "no-pipewire")
  })
  for (const key of ["XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) {
    env[key] = path.join(root, key)
    fs.mkdirSync(env[key], { mode: 0o700 })
  }
  function hostCommands() {
    try {
      return fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
      return []
    }
  }
  return { env, hostBin, hostCommands }
}

module.exports = { isolatedQs }
