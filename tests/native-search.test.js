const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { spawn } = require("node:child_process")
const readline = require("node:readline")
const os = require("node:os")
const { spawnSync } = require("node:child_process")
const helperUnderTest = require("./search-helper.js")
const FoamyNative = require("../kit/node-loader.cjs").load("FoamyNative")
const F = require("../core/FleaSearch.js")
const R = require("../core/Ranker.js")

const source = fs.readFileSync(path.join(__dirname, "../services/NativeSearch.qml"), "utf8")
// NativeSearch.qml's functions on plain objects; "root" starts with one entry.
function harness() {
  const events = [], writes = []
  const service = { catalogs: {}, serial: 0, disabled: false, pending: null, failed: m => events.push(m) }
  const helper = { running: false, write: s => writes.push(JSON.parse(s)) }
  const timeout = { active: false, restart() { this.active = true }, stop() { this.active = false } }
  const context = vm.createContext({ service, helper, timeout, FleaSearch: F, FoamyNative })
  for (const name of ["cancel", "setCatalog", "search", "load", "loadAll", "send", "fail", "exited", "loading", "receive"]) {
    const start = source.indexOf("  function " + name + "(")
    const end = source.indexOf("\n  }", start) + 4
    vm.runInContext(source.slice(start, end).trim(), context)
    service[name] = context[name]
  }
  service.setCatalog("root", [{ title: "Files" }], ["files"])
  // The helper starting (Process onStarted) loads every catalog.
  const start = () => { helper.running = true; service.loadAll() }
  const loadId = name => service.catalogs[name].loadId
  return { service, helper, timeout, events, writes, start, loadId, reply: obj => service.receive(JSON.stringify(obj)) }
}
const hit = { index: 0, title: 4000000, alternate: null, subtitle: null, keyword: null }

test("native service waits for load, suppresses stale replies, and cancels hidden queries", () => {
  const h = harness(), got = []
  h.service.search("root", "fi", "medium", r => got.push(r))
  assert.equal(h.helper.running, true)
  const first = h.service.pending.id
  h.start()
  assert.deepEqual(h.writes.at(-1), { id: h.loadId("root"), catalog: "root", entries: [{ title: "Files" }] })
  h.reply({ id: h.loadId("root"), loaded: 1 })
  assert.deepEqual(h.writes.at(-1), { id: first, catalog: "root", query: "fi", sensitivity: "medium" })
  h.service.search("root", "files", "medium", r => got.push(r))
  h.reply({ id: first, hits: [hit] })
  assert.equal(got.length, 0)
  h.reply({ id: h.service.pending.id, hits: [hit] })
  assert.equal(got[0].files.title, 4000000)
  assert.equal(h.timeout.active, false)
  h.service.search("root", "new", "medium", r => got.push(r))
  const hidden = h.service.pending.id
  h.service.cancel()
  h.reply({ id: hidden, hits: [hit] })
  assert.equal(got.length, 1)
})

test("a catalog reload while a search is pending never applies a reply on the old list", () => {
  const h = harness(), got = []
  h.start()
  h.reply({ id: h.loadId("root"), loaded: 1 })
  h.service.search("root", "fi", "medium", r => got.push(r))
  const stale = h.service.pending.id
  const oldLoad = h.loadId("root")
  h.service.setCatalog("root", [{ title: "Terminal" }, { title: "Firefox" }], ["terminal", "firefox"])
  assert.notEqual(h.service.pending.id, stale, "the pending search gets a new id")
  assert.equal(h.service.catalogs.root.loaded, false)
  assert.equal(h.writes.at(-1).catalog, "root")
  // The helper answers in order: the old search (old indexes), then the load.
  h.reply({ id: stale, hits: [hit] })
  h.reply({ id: oldLoad, loaded: 1 })
  assert.deepEqual(got, [])
  assert.equal(h.service.disabled, false)
  h.reply({ id: h.loadId("root"), loaded: 2 })
  assert.deepEqual(h.writes.at(-1), { id: h.service.pending.id, catalog: "root", query: "fi", sensitivity: "medium" })
  h.reply({ id: h.service.pending.id, hits: [{ ...hit, index: 1 }] })
  assert.deepEqual(Object.keys(got[0]), ["firefox"])
  assert.equal(h.service.pending, null)
  assert.equal(h.timeout.active, false)
})

test("a view's catalog loads once per change, and a reply for another view is never applied", () => {
  const h = harness(), got = []
  h.start()
  h.reply({ id: h.loadId("root"), loaded: 1 })
  const ssh = [{ title: "web" }, { title: "db" }]
  h.service.setCatalog("view", ssh, ["scope-item:ssh:web", "scope-item:ssh:db"])
  const loads = () => h.writes.filter(w => w.entries).length
  assert.equal(loads(), 2)
  h.reply({ id: h.loadId("view"), loaded: 2 })
  // Keystrokes in the same view: the same entries load nothing again.
  for (const query of ["d", "db"]) {
    h.service.setCatalog("view", ssh.map(e => ({ ...e })), ["scope-item:ssh:web", "scope-item:ssh:db"])
    h.service.search("view", query, "medium", r => got.push(r))
  }
  assert.equal(loads(), 2)
  // A root search pending while the view's list changes keeps its id.
  h.service.search("root", "fi", "medium", r => got.push(r))
  const root = h.service.pending.id
  h.service.setCatalog("view", [{ title: "Settings" }], ["setting:width"])
  assert.equal(h.service.pending.id, root)
  assert.equal(loads(), 3)
  // The user moves to the settings view: the root reply is stale.
  h.service.search("view", "set", "medium", r => got.push(r))
  h.reply({ id: root, hits: [hit] })
  assert.deepEqual(got, [])
  // The settings search waits for its load, then maps through its own ids.
  assert.equal(h.writes.at(-1).entries.length, 1)
  h.reply({ id: h.loadId("view"), loaded: 1 })
  h.reply({ id: h.service.pending.id, hits: [hit] })
  assert.deepEqual(Object.keys(got[0]), ["setting:width"])
  // Same entries under new ids map through the new ids, without a load.
  h.service.setCatalog("view", [{ title: "Settings" }], ["setting:height"])
  assert.equal(loads(), 3)
  h.service.search("view", "set", "medium", r => got.push(r))
  h.reply({ id: h.service.pending.id, hits: [hit] })
  assert.deepEqual(Object.keys(got[1]), ["setting:height"])
})

test("a search on a catalog that was never set uses the built-in matcher", () => {
  const h = harness(), got = []
  h.service.search("view", "fi", "medium", r => got.push(r))
  assert.deepEqual(got, [null])
  assert.equal(h.service.pending, null)
  assert.equal(h.helper.running, false)
  assert.equal(h.service.disabled, false)
})

test("malformed replies, invalid scores and service failures all permit fallback", () => {
  for (const reply of ["not json", '{"id":1}', JSON.stringify({ id: 1, hits: [{ ...hit, title: "500" }] })]) {
    const h = harness(), got = []
    h.service.search("root", "bad", "medium", r => got.push(r))
    h.service.receive(reply)
    assert.deepEqual(got, [null])
    assert.equal(h.service.disabled, true)
    assert.equal(h.helper.running, false)
  }
  const h = harness(), got = []
  h.service.search("root", "one", "medium", r => got.push(r))
  h.service.fail("missing executable or timeout")
  h.service.fail("late exit")
  h.service.search("root", "two", "medium", r => got.push(r))
  assert.deepEqual(got, [null, null])
})

test("a failure in one view leaves every view on the built-in matcher, and the busy state settles", () => {
  for (const failure of ["load error", "wrong count", "timeout", "exit"]) {
    const h = harness(), got = []
    h.start()
    h.reply({ id: h.loadId("root"), loaded: 1 })
    h.service.setCatalog("view", [{ title: "web" }], ["scope-item:ssh:web"])
    h.service.search("view", "we", "medium", r => got.push(r))
    if (failure === "load error") h.reply({ id: h.loadId("view"), error: "entries exceeds 20000 candidates" })
    if (failure === "wrong count") h.reply({ id: h.loadId("view"), loaded: 5 })
    if (failure === "timeout") h.service.fail("Search helper timed out; using the built-in matcher")
    if (failure === "exit") h.service.exited(101)
    assert.deepEqual(got, [null], failure)
    assert.equal(h.service.pending, null, failure)
    assert.equal(h.timeout.active, false, failure)
    assert.equal(h.service.disabled, true, failure)
    assert.equal(h.helper.running, false, failure)
    const writes = h.writes.length
    for (const name of ["root", "view"]) h.service.search(name, "we", "medium", r => got.push(r))
    h.service.setCatalog("view", [{ title: "db" }], ["scope-item:ssh:db"])
    assert.deepEqual(got, [null, null, null], failure)
    assert.equal(h.writes.length, writes, failure + ": nothing more reaches the helper")
    assert.equal(h.events.length, 1, failure)
  }
})

test("hits merge an id the list holds twice, and still reject a repeated index", () => {
  const hits = F.hits({ hits: [{ ...hit, index: 0, title: 2000000 }, { ...hit, index: 1, title: null, keyword: 999000 }] }, ["x", "x"])
  assert.deepEqual(hits.x, { index: 0, title: 2000000, alternate: null, subtitle: null, keyword: 999000 })
  const higher = F.hits({ hits: [{ ...hit, title: 2000000 }, { ...hit, index: 1, title: 4000000 }] }, ["x", "x"])
  assert.equal(higher.x.title, 4000000)
  assert.throws(() => F.hits({ hits: [hit, { ...hit, title: 3000000 }] }, ["x", "y"]), /repeats/)
})

test("protocol rejects duplicate entries and bounds, and folds native input like the ranker", () => {
  assert.throws(() => F.hits({ hits: [hit, hit] }, ["x"]), /repeats/)
  assert.throws(() => F.hits({ hits: [{ ...hit, index: 1 }] }, ["x"]), /index/)
  assert.throws(() => F.hits({ hits: [{ index: 0 }] }, ["x"]), /score/)
  assert.equal(F.entries([{ title: "Café", keywords: ["Straße"] }], R.transliterate)[0].keywords[0], "Strasse")
})

test("native scores retain exact aliases, learning, pins, alternate names and frecency", () => {
  const c = [
    { id: "long", title: "Firefox Developer Edition", type: "application" },
    { id: "short", title: "Firefox", type: "application" },
    { id: "alias", title: "Unrelated", alias: "fir", type: "application" }
  ]
  const scores = { long: { ...hit }, short: { ...hit } }
  const ids = extra => R.rank(c, "fir", { fleaHits: scores, nowMs: 1000, ...extra }).map(r => r.candidate.id)
  assert.deepEqual(ids(), ["alias", "short", "long"])
  c[0].frecency = 100
  assert.deepEqual(ids(), ["alias", "long", "short"])
  c[1].pinPriority = 1
  assert.equal(ids()[0], "short")
  delete c[1].pinPriority
  c[1].frecency = 100
  assert.equal(ids()[1], "short")
  c[0].openedAt = 1000
  c[0].searchTerms = ["fir"]
  assert.equal(ids()[1], "long")
  scores.short = { ...hit, title: null, alternate: 5000000 }
  assert.equal(R.buildRecord(c[1], "fir", { fleaHits: scores }).titleMatch, "exact")
})


test("obsolete errors cannot disable a newer valid request", () => {
  const h = harness(), got = []
  h.start()
  h.reply({ id: h.loadId("root"), loaded: 1 })
  h.service.search("root", "old", "unsupported", r => got.push(r))
  const old = h.service.pending.id
  h.service.search("root", "new", "medium", r => got.push(r))
  h.reply({ id: old, error: "unsupported sensitivity" })
  assert.equal(h.service.disabled, false)
  assert.equal(got.length, 0)
  h.reply({ id: h.service.pending.id, hits: [hit] })
  assert.equal(got.length, 1)
})

test("all-null hits trigger fallback instead of phantom results", () => {
  const invalid = harness(), got = []
  invalid.service.search("root", "fi", "medium", r => got.push(r))
  invalid.reply({ id: invalid.service.pending.id, hits: [{ ...hit, title: null }] })
  assert.equal(invalid.service.disabled, true)
  assert.equal(got.at(-1), null)
})

test("keyword-only tiers rank exact ahead of typo while titles keep priority", () => {
  const c = [{ id: "typo", title: "Alpha", frecency: 100 }, { id: "exact", title: "Zulu", frecency: 1 }]
  const fleaHits = {
    typo: { title: null, alternate: null, subtitle: null, keyword: 999000 },
    exact: { title: null, alternate: null, subtitle: null, keyword: 5000000 }
  }
  assert.deepEqual(R.rank(c, "browser", { fleaHits }).map(r => r.candidate.id), ["exact", "typo"])
  fleaHits.typo.title = 2000001
  assert.equal(R.rank(c, "browser", { fleaHits })[0].candidate.id, "typo")
})

test("the service drives the real helper: load, query, reload, two catalogs", { skip: helperUnderTest.skip, timeout: 10000 }, async t => {
  const h = harness(), got = []
  const child = spawn(helperUnderTest.argv[0], helperUnderTest.argv.slice(1), { stdio: ["pipe", "pipe", "inherit"] })
  t.after(() => child.kill())
  readline.createInterface({ input: child.stdout }).on("line", line => h.service.receive(line))
  h.helper.write = s => child.stdin.write(s)
  const answer = () => new Promise(resolve => {
    const before = got.length
    const poll = setInterval(() => { if (got.length > before) { clearInterval(poll); resolve(got.at(-1)) } }, 5)
  })
  h.service.setCatalog("root", F.entries([{ title: "Files" }, { title: "Firefox" }], R.transliterate), ["files", "firefox"])
  h.service.search("root", "fi", "medium", r => got.push(r))
  h.start()
  const first = await answer()
  assert.ok(first.files.title > 0 && first.firefox.title > 0)
  h.service.search("root", "firefox", "medium", r => got.push(r))
  const second = await answer()
  assert.equal(second.firefox.title, 5000000)
  h.service.setCatalog("view", F.entries([{ title: "web" }, { title: "Firefox" }], R.transliterate), ["scope-item:ssh:web", "scope-item:ssh:firefox"])
  h.service.search("view", "fierfox", "medium", r => got.push(r))
  assert.deepEqual(Object.keys(await answer()), ["scope-item:ssh:firefox"])
  // The root list is still there beside the view's.
  h.service.search("root", "files", "medium", r => got.push(r))
  assert.deepEqual(Object.keys(await answer()), ["files"])
  h.service.setCatalog("root", F.entries([{ title: "Terminal" }], R.transliterate), ["terminal"])
  h.service.search("root", "term", "medium", r => got.push(r))
  assert.deepEqual(Object.keys(await answer()), ["terminal"])
  // A search sent, then its catalog reloaded before the reply is read.
  h.service.search("view", "web", "medium", r => got.push(r))
  h.service.setCatalog("view", F.entries([{ title: "db" }, { title: "web" }], R.transliterate), ["scope-item:ssh:db", "scope-item:ssh:web"])
  const reloaded = await answer()
  assert.deepEqual(Object.keys(reloaded), ["scope-item:ssh:web"])
  assert.equal(reloaded["scope-item:ssh:web"].index, 1)
  assert.equal(h.service.disabled, false)
  assert.deepEqual(h.events, [])
  child.stdin.end()
})

test("the launch command uses the bundled helper for this CPU", () => {
  assert.match(source, /command: FoamyNative\.command\(service\.pluginDir, "foamy-menu-search", \[\]\)/)
  assert.match(source, /pluginDir: FoamyNative\.localPath\(Qt\.resolvedUrl\("\.\."\)\)/)
  assert.match(source, /onExited: function ?\(exitCode, exitStatus\) \{\s*service\.exited\(exitCode\)\s*\}/)
})

test("no helper for this CPU, or one that can't run, falls back to the built-in matcher once", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foamy-menu-native-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const launch = () => {
    const [cmd, ...args] = FoamyNative.command(dir, "foamy-menu-search", [])
    return spawnSync(cmd, args, { input: "", stdio: ["pipe", "ignore", "ignore"] }).status
  }
  const helperFor = arch => path.join(dir, "bin", arch, "foamy-menu-search")
  fs.mkdirSync(path.dirname(helperFor("riscv64")), { recursive: true })
  fs.writeFileSync(helperFor("riscv64"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  assert.equal(launch(), 127, "only another CPU's helper")
  const arch = spawnSync("bash", ["-c", 'printf %s "$HOSTTYPE"'], { encoding: "utf8" }).stdout
  fs.mkdirSync(path.dirname(helperFor(arch)))
  fs.writeFileSync(helperFor(arch), "#!/bin/sh\nexit 0\n", { mode: 0o644 })
  assert.equal(launch(), 126, "helper not executable")
  for (const code of [127, 126]) {
    const h = harness(), got = []
    h.service.search("root", "fi", "medium", r => got.push(r))
    assert.equal(h.helper.running, true)
    h.service.exited(code)
    assert.deepEqual(got, [null])
    assert.equal(h.service.disabled, true)
    assert.deepEqual(h.events, ["Search helper isn't available for this CPU; using the built-in matcher"])
    h.service.exited(code)
    h.service.search("root", "files", "medium", r => got.push(r))
    assert.deepEqual(got, [null, null], "no retry: later searches use the built-in matcher")
    assert.equal(h.helper.running, false)
    assert.equal(h.events.length, 1)
  }
  const crashed = harness(), got = []
  crashed.service.search("root", "fi", "medium", r => got.push(r))
  crashed.service.exited(101)
  assert.deepEqual(got, [null])
  assert.deepEqual(crashed.events, ["Search helper exited; using the built-in matcher"])
  const fallback = R.rank([{ id: "files", title: "Files" }, { id: "firefox", title: "Firefox" }], "fire", { fleaHits: null, nowMs: 1000 })
  assert.equal(fallback[0].candidate.id, "firefox")
})
