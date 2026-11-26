const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { spawn } = require("node:child_process")
const readline = require("node:readline")
const helperUnderTest = require("./search-helper.js")
const FoamyNative = require("../kit/node-loader.cjs").load("FoamyNative")
const F = require("../core/FleaSearch.js")
const R = require("../core/Ranker.js")
const Scopes = require("../core/Scopes.js")

const source = fs.readFileSync(path.join(__dirname, "../services/NativeSearch.qml"), "utf8")
// The text of `name: ` in the first block after `from`, to the end of the
// line, or with `block` to the closing brace at that indentation.
function binding(name, from, block) {
  assert.ok(source.indexOf(from) >= 0, from)
  const start = source.indexOf(name + ": ", source.indexOf(from))
  assert.ok(start >= 0, name)
  const indent = start - (source.lastIndexOf("\n", start) + 1)
  const end = block ? source.indexOf("\n" + " ".repeat(indent) + "}", start) + indent + 2 : source.indexOf("\n", start)
  return source.slice(start + name.length + 2, end)
}

// NativeSearch.qml's functions on plain objects; "root" starts with one entry.
function harness() {
  const events = [], writes = [], messages = []
  const service = {
    catalogs: {}, serial: 0, disabled: false, pending: null, reportedLimits: {}, failed: m => events.push(m),
    message: (level, text, metadata) => messages.push({ level, text, metadata }), pluginDir: path.join(__dirname, "..")
  }
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
  const onExited = binding("onExited", "id: helper", true)
  const onTriggered = binding("onTriggered", "id: timeout")
  return {
    service, helper, timeout, events, writes, messages, start, loadId, reply: obj => service.receive(JSON.stringify(obj)),
    // The helper Process ends: its own onExited handler.
    exit(code) {
      helper.running = false
      vm.runInContext("(" + onExited + ")(" + code + ", 0)", context)
    },
    // The timeout Timer fires: its own onTriggered expression.
    expire() { vm.runInContext(onTriggered, context) },
    // The helper Process's command binding.
    command: () => Array.from(vm.runInContext(binding("command", "id: helper"), context))
  }
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
    if (failure === "timeout") {
      assert.equal(h.timeout.active, true, "a pending search runs the timeout")
      h.expire()
    }
    if (failure === "exit") h.exit(101)
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

test("FleaSearch rejects every malformed reply", () => {
  const replies = [
    ["a line over 8 MiB", "x".repeat(8 * 1024 * 1024 + 1), /size limit/],
    ["null", "null", /request id/],
    ["no id", '{"hits":[]}', /request id/],
    ["a fractional id", '{"id":1.5,"hits":[]}', /request id/],
    ["a string id", '{"id":"1","hits":[]}', /request id/],
    ["an id past the safe integers", '{"id":9007199254740992,"hits":[]}', /request id/]
  ]
  for (const [name, line, error] of replies) assert.throws(() => F.reply(line), error, name)
  const ids = ["x", "y"]
  const hitsReplies = [
    ["no hits", {}, /no hits/],
    ["hits not an array", { hits: {} }, /no hits/],
    ["a null hit", { hits: [null] }, /index/],
    ["index -1", { hits: [{ ...hit, index: -1 }] }, /index/],
    ["index past the list", { hits: [{ ...hit, index: 2 }] }, /index/],
    ["a fractional index", { hits: [{ ...hit, index: 0.5 }] }, /index/],
    ["a string index", { hits: [{ ...hit, index: "0" }] }, /index/],
    ["a repeated index", { hits: [hit, { ...hit, title: 3000000 }] }, /repeats/],
    ["score 0", { hits: [{ ...hit, title: 0 }] }, /score/],
    ["score -1", { hits: [{ ...hit, title: -1 }] }, /score/],
    ["score past 5000000", { hits: [{ ...hit, title: 5000001 }] }, /score/],
    ["a fractional score", { hits: [{ ...hit, keyword: 1.5 }] }, /score/],
    ["a string score", { hits: [{ ...hit, title: "500" }] }, /score/],
    ["a missing channel", { hits: [{ index: 0, title: 4000000, alternate: null, subtitle: null }] }, /score/],
    ["every channel null", { hits: [{ ...hit, title: null }] }, /empty hit/]
  ]
  for (const [name, data, error] of hitsReplies) assert.throws(() => F.hits(data, ids), error, name)
  assert.equal(F.reply('{"id":9007199254740991,"hits":[]}').id, 9007199254740991)
  const edges = F.hits({ hits: [{ ...hit, title: 1 }, { ...hit, index: 1, title: 5000000 }] }, ids)
  assert.deepEqual([edges.x.title, edges.y.title], [1, 5000000])
})

test("entries reach the helper folded like the query", () => {
  const entries = F.entries([{ title: "Café", subtitle: "Åpne", keywords: ["Straße"], bundleId: "no.Ærlig" }, {}], R.transliterate)
  assert.deepEqual(entries, [
    { title: "Cafe", subtitle: "Apne", alternateTitles: [], keywords: ["Strasse"], bundleId: "no.AErlig" },
    { title: "", subtitle: "", alternateTitles: [], keywords: [], bundleId: "" }
  ])
})

test("helper hits keep exact aliases, learned terms and frecency, and an exact title leads", () => {
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
  c[1].frecency = 100
  assert.equal(ids()[1], "short")
  c[0].openedAt = 1000
  c[0].searchTerms = ["fir"]
  assert.equal(ids()[1], "long")
  // An exact title from the helper beats a more used row with a title and an
  // alias that only start with the query.
  const fresh = [
    { id: "long", title: "Firefox Developer Edition", type: "application", frecency: 100, alias: "firefoxdev" },
    { id: "short", title: "Firefox", type: "application" }
  ]
  const exact = R.rank(fresh, "firefox", { fleaHits: { long: { ...hit }, short: { ...hit, title: 5000000 } }, nowMs: 1000 })
  assert.deepEqual(exact.map(r => r.candidate.id), ["short", "long"])
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
  // The launch command of NativeSearch.qml itself, unless FOAMY_HELPER names
  // another helper (the aarch64 one under qemu).
  const argv = helperUnderTest.required ? helperUnderTest.argv : h.command()
  const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "inherit"] })
  t.after(() => child.kill())
  readline.createInterface({ input: child.stdout }).on("line", line => h.service.receive(line))
  // An exit before the end goes through the Process handler: the pending
  // search gets null and the test fails at once instead of waiting.
  child.on("exit", code => { if (!child.stdin.writableEnded) h.exit(code) })
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

// The helper refuses a request line over 8 MiB and a list over 20,000
// entries, and a refusal turns it off in every view. A list past either
// limit is never sent: the built-in matcher searches that list alone, the
// other list keeps the helper, and it is logged once per list. The SSH scope
// at its item cap (10,000), with each title and subtitle at the length cap,
// is past the line limit.
test("a list past the helper's limits stays with the built-in matcher, and the other list keeps the helper", { skip: helperUnderTest.skip, timeout: 60000 }, async t => {
  const h = harness()
  const argv = helperUnderTest.required ? helperUnderTest.argv : h.command()
  const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "inherit"] })
  t.after(() => child.kill())
  readline.createInterface({ input: child.stdout }).on("line", line => h.service.receive(line))
  child.on("exit", code => { if (!child.stdin.writableEnded) h.exit(code) })
  const sent = []
  h.helper.write = s => {
    const load = /^\{"id":\d+,"catalog":"(\w+)","entries":/.exec(s)
    if (load) sent.push(load[1] + " " + Buffer.byteLength(s.trimEnd()))
    child.stdin.write(s)
  }
  // A search's answer: hits from the helper, or null when the built-in
  // matcher answers. The first search starts the helper, which then loads
  // every list (the Process's onStarted).
  const ask = (name, query) => new Promise(resolve => {
    const running = h.helper.running
    h.service.search(name, query, "medium", resolve)
    if (!running && h.helper.running) h.start()
  })
  // The ids the helper found, or null when the built-in matcher answers.
  const found = async (name, query) => {
    const answer = await ask(name, query)
    return answer && Object.keys(answer)
  }
  const entries = titles => F.entries(titles.map(title => ({ title })), R.transliterate)
  const set = (name, list) => h.service.setCatalog(name, list, list.map((_, i) => name + i))

  set("root", entries(["Files", "Firefox"]))
  assert.deepEqual(await found("root", "files"), ["root0"], "the helper answers")
  const ssh = Scopes.merge(Scopes.BUILTINS, []).scopes.find(s => s.id === "ssh")
  const text = (prefix, i) => prefix + String(i).padStart(Scopes.MAX_TEXT - prefix.length, "0")
  const output = Array.from({ length: Scopes.maxItems(ssh) }, (_, i) => text("h", i) + "\t\t" + text("u@", i)).join("\n")
  const hosts = Scopes.parseOutput(output, Scopes.maxItems(ssh)).map(item => Scopes.itemCandidate(ssh, item))
  assert.equal(hosts.length, 10000)
  h.service.setCatalog("view", F.entries(hosts, R.transliterate), hosts.map(c => c.id))
  assert.equal(await ask("view", "h1"), null, "the scope at its caps is searched by the built-in matcher")
  assert.deepEqual(await found("root", "files"), ["root0"], "the root list keeps the helper")
  assert.ok(!sent.some(load => load.startsWith("view ")), "the scope's list never reaches the helper: " + sent)

  // The line limit to the byte, counted in UTF-8 as the helper reads it:
  // titles of 2-, 3- and 4-byte characters (15,003 bytes; the helper takes
  // 16 KiB a field), the last one sized to make the request `bytes` long
  // with the longest id a request can have.
  const sized = bytes => {
    const entry = title => ({ title, subtitle: "", alternateTitles: [], keywords: [], bundleId: "" })
    const full = entry("é€😀".repeat(1667))
    const base = F.loadSize("view", JSON.stringify([entry("")]))
    const per = F.loadSize("view", JSON.stringify([full, entry("")])) - base
    const count = Math.floor((bytes - base) / per)
    const list = Array(count).fill(full).concat([entry("a".repeat(bytes - base - count * per))])
    const request = F.loadRequest(Number.MAX_SAFE_INTEGER, "view", JSON.stringify(list))
    assert.equal(Buffer.byteLength(request), bytes, "the request is as long as asked")
    return list
  }
  set("view", sized(F.MAX_REQUEST_BYTES))
  assert.notEqual(await ask("view", "a"), null, "a list at the line limit loads")
  set("view", sized(F.MAX_REQUEST_BYTES + 1))
  assert.equal(await ask("view", "a"), null, "one byte more stays with the built-in matcher")
  assert.deepEqual(await found("root", "files"), ["root0"], "the root list keeps the helper")

  // The entry limit: two root search scopes at their cap and the apps are
  // more than the helper takes.
  set("root", entries(Array.from({ length: F.MAX_ENTRIES }, (_, i) => "app " + i)))
  assert.ok(await ask("root", "app 19999"), "a list at the entry limit loads")
  set("root", entries(Array.from({ length: F.MAX_ENTRIES + 1 }, (_, i) => "app " + i)))
  assert.equal(await ask("root", "app 1"), null, "one entry more stays with the built-in matcher")
  set("view", entries(["web", "db"]))
  assert.deepEqual(await found("view", "web"), ["view0"], "the view's list keeps the helper")
  // A list that fits again goes back to the helper.
  set("root", entries(["Terminal"]))
  assert.deepEqual(await found("root", "term"), ["root0"], "a list that fits again goes back to the helper")

  assert.equal(h.service.disabled, false)
  assert.deepEqual(h.events, [], "the helper never failed")
  const logged = h.messages.map(m => [m.level, m.text.split(" ")[1], m.metadata.entries])
  assert.deepEqual(logged, [["warning", "view", 10000], ["warning", "root", F.MAX_ENTRIES + 1]], "one line for each list, however often it was past the limits")
  child.stdin.end()
})

// A search waits for its list to load; a list past the limits never loads,
// so without an answer the timeout would turn the helper off in every view.
test("a search waiting for a list that grows past the helper's limits gets the built-in matcher at once", () => {
  const h = harness(), got = []
  h.start()
  h.reply({ id: h.loadId("root"), loaded: 1 })
  h.service.search("root", "fi", "medium", r => got.push(r))
  const writes = h.writes.length
  const many = Array.from({ length: F.MAX_ENTRIES + 1 }, (_, i) => ({ title: "app " + i }))
  h.service.setCatalog("root", many, many.map((_, i) => "app" + i))
  assert.deepEqual(got, [null], "the built-in matcher answers the waiting search")
  assert.equal(h.service.pending, null)
  assert.equal(h.timeout.active, false, "no timeout is left to turn the helper off")
  assert.equal(h.writes.length, writes, "the list is not sent")
  assert.equal(h.service.disabled, false)
})

// A lone surrogate (a text cut inside a pair) counts as the U+FFFD that
// replaces it on the way out.
test("a load request is measured in the UTF-8 bytes the helper reads", () => {
  for (const text of ["", "a", "é", "€", "😀", "é€😀a", "\ud800", "\udc00", "\ud800a\udc00", "a\udc00\ud800😀"])
    assert.equal(F.utf8Length(text), Buffer.byteLength(text), JSON.stringify(text))
})

test("no helper for this CPU, or one that can't run, falls back to the built-in matcher once", () => {
  for (const code of [127, 126]) {
    const h = harness(), got = []
    h.service.search("root", "fi", "medium", r => got.push(r))
    assert.equal(h.helper.running, true)
    h.exit(code)
    assert.deepEqual(got, [null])
    assert.equal(h.service.disabled, true)
    assert.deepEqual(h.events, ["Search helper isn't available for this CPU; using the built-in matcher"])
    h.exit(code)
    h.service.search("root", "files", "medium", r => got.push(r))
    assert.deepEqual(got, [null, null], "no retry: later searches use the built-in matcher")
    assert.equal(h.helper.running, false)
    assert.equal(h.events.length, 1)
  }
  const crashed = harness(), got = []
  crashed.service.search("root", "fi", "medium", r => got.push(r))
  crashed.exit(101)
  assert.deepEqual(got, [null])
  assert.deepEqual(crashed.events, ["Search helper exited; using the built-in matcher"])
})
