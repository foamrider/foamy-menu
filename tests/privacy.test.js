const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const Paths = require("../core/Paths.js")

// Marketplace review: histories must stay private under a normal umask 022,
// with every ancestor traversable, and no private text may reach any argv.
const root = path.join(__dirname, "..")
const mode = (p) => fs.statSync(p).mode & 0o777

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "foamy-menu-privacy-"))
  fs.chmodSync(home, 0o755)
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

function runSetup(home) {
  const p = Paths.resolve((name) => ({ HOME: home })[name] || "")
  const files = ["settings.json", "frecency.json", "calculator.json"].map((f) => p.db + "/" + f)
  const [cmd, ...args] = Paths.setupArgv(p, files)
  const r = spawnSync("bash", ["-c", "umask 022; exec \"$@\"", "umask-022", cmd, ...args], { encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  return p
}

// Every path under `dir`, relative to it, with its type and mode.
function tree(dir, prefix = "") {
  return fs.readdirSync(path.join(dir, prefix)).sort().flatMap((name) => {
    const rel = prefix ? prefix + "/" + name : name
    const stat = fs.lstatSync(path.join(dir, rel))
    const entry = [rel, stat.isDirectory() ? "dir" : "file", (stat.mode & 0o777).toString(8), stat.isDirectory() ? null : stat.size]
    return stat.isDirectory() ? [entry, ...tree(dir, rel)] : [entry]
  })
}

test("first start under umask 022 creates only owner-only dirs and empty 0600 store files", (t) => {
  const home = tempHome(t)
  runSetup(home)
  // Only the launcher's own folders must be private; the XDG parents are
  // listed without their mode.
  const parents = [".cache", ".config", ".local", ".local/share"]
  const listed = tree(home).map(([rel, type, perms, size]) => [rel, type, parents.includes(rel) ? "any" : perms, size])
  assert.deepEqual(listed, [
    [".cache", "dir", "any", null],
    [".cache/foamy-menu", "dir", "700", null],
    [".config", "dir", "any", null],
    [".config/foamy-menu", "dir", "700", null],
    [".config/foamy-menu/scopes", "dir", "700", null],
    [".local", "dir", "any", null],
    [".local/share", "dir", "any", null],
    [".local/share/foamy-menu", "dir", "700", null],
    [".local/share/foamy-menu/db", "dir", "700", null],
    [".local/share/foamy-menu/db/calculator.json", "file", "600", 0],
    [".local/share/foamy-menu/db/frecency.json", "file", "600", 0],
    [".local/share/foamy-menu/db/settings.json", "file", "600", 0]
  ])
})

test("the repair does not follow symlinks out of the private folders", (t) => {
  const home = tempHome(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "foamy-menu-outside-"))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.chmodSync(outside, 0o755)
  fs.writeFileSync(outside + "/shared.txt", "not ours")
  fs.chmodSync(outside + "/shared.txt", 0o644)
  const db = home + "/.local/share/foamy-menu/db"
  fs.mkdirSync(db, { recursive: true, mode: 0o755 })
  fs.symlinkSync(outside, db + "/link")
  fs.symlinkSync(outside + "/missing.json", db + "/frecency.json")
  runSetup(home)
  assert.equal(mode(outside), 0o755)
  assert.equal(mode(outside + "/shared.txt"), 0o644)
  assert.equal(fs.existsSync(outside + "/missing.json"), false, "a dangling store link was written through")
  assert.equal(mode(db), 0o700)
})

test("readable histories from older builds are repaired; stricter modes are kept", (t) => {
  const home = tempHome(t)
  const db = home + "/.local/share/foamy-menu/db"
  fs.mkdirSync(db, { recursive: true, mode: 0o755 })
  fs.chmodSync(home + "/.local/share/foamy-menu", 0o755)
  fs.writeFileSync(db + "/frecency.json", "{}", { mode: 0o644 })
  fs.writeFileSync(db + "/calculator.json", "{}", { mode: 0o644 })
  fs.writeFileSync(db + "/settings.json", "{}")
  fs.chmodSync(db + "/frecency.json", 0o644)
  fs.chmodSync(db + "/calculator.json", 0o664)
  fs.chmodSync(db + "/settings.json", 0o400)
  const p = runSetup(home)
  assert.equal(mode(p.data), 0o700)
  assert.equal(mode(p.db), 0o700)
  assert.equal(mode(db + "/frecency.json"), 0o600)
  assert.equal(mode(db + "/calculator.json"), 0o600)
  assert.equal(mode(db + "/settings.json"), 0o400)
  assert.equal(fs.readFileSync(db + "/frecency.json", "utf8"), "{}", "repair never rewrites contents")
})

test("comparison installation and legacy data remain untouched", (t) => {
  const home = tempHome(t)
  for (const name of ["omacast", "oma-cast"]) {
    const db = home + "/.local/share/" + name + "/db"
    fs.mkdirSync(db, { recursive: true })
    fs.writeFileSync(db + "/calculator.json", '{"history":["comparison"]}', { mode: 0o644 })
  }
  const p = runSetup(home)
  for (const name of ["omacast", "oma-cast"]) {
    const file = home + "/.local/share/" + name + "/db/calculator.json"
    assert.equal(fs.readFileSync(file, "utf8"), '{"history":["comparison"]}')
    assert.equal(mode(file), 0o644)
  }
  assert.equal(fs.readFileSync(p.db + "/calculator.json", "utf8"), "")
})

// The clipboard scripts run with the text on stdin. A fake wl-copy/wtype on
// PATH records each process's /proc cmdline while the text is in flight.
function clipboardScripts() {
  const source = fs.readFileSync(path.join(root, "services/ClipboardWriter.qml"), "utf8")
  const grab = (name) => source.match(new RegExp("property string " + name + ": '([^']*)'"))[1]
  return { copy: grab("copyScript"), paste: grab("pasteScript") }
}

for (const kind of ["copy", "paste"]) {
  test(`calculator ${kind} keeps the text out of every command line`, (t) => {
    const home = tempHome(t)
    const log = home + "/cmdlines"
    const fake = '#!/bin/bash\ntr "\\0" " " </proc/$$/cmdline >>"$LOG"; echo >>"$LOG"\n'
    fs.writeFileSync(home + "/wl-copy", fake + 'cat >"$LOG.clipboard"\n', { mode: 0o755 })
    fs.writeFileSync(home + "/wtype", fake, { mode: 0o755 })
    fs.writeFileSync(home + "/sleep", "#!/bin/bash\nexit 0\n", { mode: 0o755 })
    const secret = "1234 * 5678 = 7006652 my private question"
    const script = clipboardScripts()[kind]
    const r = spawnSync("bash", ["-c", script], {
      input: secret, encoding: "utf8",
      env: { ...process.env, LOG: log, PATH: home + ":" + process.env.PATH }
    })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(fs.readFileSync(log + ".clipboard", "utf8"), secret)
    const cmdlines = fs.readFileSync(log, "utf8")
    assert.ok(!cmdlines.includes("private"), cmdlines)
    if (kind === "paste") assert.match(cmdlines, /wtype -M shift -k Insert -m shift/)
  })
}
