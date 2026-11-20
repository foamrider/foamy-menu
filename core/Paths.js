// Foamy owns separate storage; never migrate or modify an Omacast installation.

var APP = "foamy-menu"

function xdg(env, name, homeFallback) {
  var value = String(env(name) || "")
  if (value.charAt(0) === "/") return value.replace(/\/+$/, "")
  return homeFallback
}

function resolve(env) {
  var home = String(env("HOME") || "").replace(/\/+$/, "")
  if (!home) throw new Error("HOME is not set")

  var config = xdg(env, "XDG_CONFIG_HOME", home + "/.config") + "/" + APP
  var data = xdg(env, "XDG_DATA_HOME", home + "/.local/share") + "/" + APP
  var cache = xdg(env, "XDG_CACHE_HOME", home + "/.cache") + "/" + APP

  // Only what the launcher uses: scope files, its stores and the rates cache.
  // Logs go to the journal (omarchy-shell).
  return {
    home: home,
    config: config,
    scopes: config + "/scopes",
    data: data,
    db: data + "/db",
    cache: cache
  }
}

function directoriesToCreate(paths) {
  return [paths.config, paths.scopes, paths.db, paths.cache]
}

// Histories and settings are private: other local users must not read them.
// Every base dir is made owner-only; config and data are repaired
// recursively (the cache holds only rates and a cargo build, so its 0700 root
// is enough). Store files are created 0600 before the first write, because
// atomic saves keep an existing file's mode but give a new one 0666 & umask.
function privateRoots(paths) {
  return [paths.config, paths.data, paths.cache]
}

function privateTrees(paths) {
  return [paths.config, paths.data]
}

// argv after the script name: --, dirs to create, --,
// private roots, --, private trees, --, files to create. chmod go-rwx only
// ever removes access, so a stricter existing mode stays as it is.
var SETUP_SCRIPT = [
  'umask 077',
  'shift',
  'dirs=(); while [[ $1 != -- ]]; do dirs+=("$1"); shift; done; shift',
  'roots=(); while [[ $1 != -- ]]; do roots+=("$1"); shift; done; shift',
  'trees=(); while [[ $1 != -- ]]; do trees+=("$1"); shift; done; shift',
  'mkdir -p -- "${dirs[@]}" || exit',
  'status=0',
  'chmod go-rwx -- "${roots[@]}" || status=1',
  'find "${trees[@]}" -xdev ! -type l -perm /077 -exec chmod go-rwx -- {} + || status=1',
  'for file; do [[ -e $file || -L $file ]] || : >"$file" || status=1; done',
  'exit $status'
].join("\n")

function setupArgv(paths, files) {
  return ["bash", "-c", SETUP_SCRIPT, "foamy-menu-setup"]
    .concat(["--"], directoriesToCreate(paths), ["--"],
      privateRoots(paths), ["--"], privateTrees(paths), ["--"], files)
}

if (typeof module !== "undefined") {
  module.exports = {
    APP: APP, resolve: resolve, directoriesToCreate: directoriesToCreate,
    privateRoots: privateRoots, privateTrees: privateTrees, SETUP_SCRIPT: SETUP_SCRIPT, setupArgv: setupArgv
  }
}
