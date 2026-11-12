const test = require("node:test")
const assert = require("node:assert/strict")
const { spawn } = require("node:child_process")
const readline = require("node:readline")
const R = require("../core/Ranker.js")
const F = require("../core/FleaSearch.js")
const Root = require("../core/RootSearch.js")
const Frecency = require("../core/Frecency.js")
const Scopes = require("../core/Scopes.js")
const Settings = require("../core/Settings.js")
const OmarchyMenu = require("../core/OmarchyMenu.js")
const searchScopes = Scopes.merge(Scopes.BUILTINS, []).scopes.filter(Scopes.isQuery)
const helper = require("./search-helper.js")

test("built helper feeds the actual root ranker and sections", { skip: helper.skip, timeout: 10000 }, async t => {
  const child = spawn(helper.argv[0], helper.argv.slice(1), { stdio: ["pipe", "pipe", "inherit"] })
  t.after(() => child.kill())
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const ask = async obj => { child.stdin.write(JSON.stringify(obj) + "\n"); return JSON.parse((await lines.next()).value) }
  const candidates = [
    { id: "chrome", title: "Chromium", type: "application", keywords: ["browser"] },
    { id: "cafe", title: "Café", type: "application", alternateTitles: ["Coffee"], subtitle: "Drinks" },
    { id: "lock", title: "Lock", type: "command" }
  ].map(c => ({ ...c, rootSearch: { when: "always" } }))
  const ids = candidates.map(c => c.id)
  assert.equal((await ask({ id: 1, entries: F.entries(candidates, R.transliterate) })).loaded, 3)
  for (const [query, expected] of [["chormium", "chrome"], ["cafe", "cafe"], ["coffee", "cafe"], ["drinks", "cafe"], ["browser", "chrome"], ["lcok", "lock"]]) {
    const reply = await ask({ id: 2, query: R.transliterate(query), sensitivity: "medium" })
    const fleaHits = F.hits(F.reply(JSON.stringify(reply)), ids)
    const ctx = { commands: {}, frecency: {}, nowMs: 1000, filter: "all", fleaHits, searchScopes }
    const sections = Root.rootSections(candidates, query, ctx, { Ranker: R, Frecency, Scopes })
    assert.equal(sections[0].rows[0].candidate.id, expected, query)
    assert.equal(sections.at(-1).id, "fallback-commands")
    ctx.commands[expected] = { enabled: false }
    const filtered = Root.rootSections(candidates, query, ctx, { Ranker: R, Frecency, Scopes })
    assert.ok(!filtered.flatMap(s => s.rows).some(r => r.candidate.id === expected))
  }
  assert.deepEqual((await ask({ id: 3, query: "lcok", sensitivity: "high" })).hits, [])
  assert.deepEqual((await ask({ id: 4, query: "" })).hits, [])
  child.stdin.end()
})

// Every view as Backend.qml searches it: root, submenus and the Apps grid on
// the "root" catalog, a scope's items and the settings rows on "view".
test("built helper feeds every view's sections, misspellings included", { skip: helper.skip, timeout: 10000 }, async t => {
  const child = spawn(helper.argv[0], helper.argv.slice(1), { stdio: ["pipe", "pipe", "inherit"] })
  t.after(() => child.kill())
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let serial = 0
  const ask = async obj => { child.stdin.write(JSON.stringify({ id: ++serial, ...obj }) + "\n"); return JSON.parse((await lines.next()).value) }
  const deps = { Ranker: R, Frecency, Scopes, Settings, OmarchyMenu }
  const ctx = fleaHits => ({ commands: {}, frecency: {}, nowMs: 1000, filter: "all", searchScopes, fleaHits, t: s => s })
  const ids = list => list.map(c => c.id)
  const found = sections => sections.flatMap(s => s.rows.map(r => r.candidate.id))
  const load = async (catalog, list) => assert.equal((await ask({ catalog, entries: F.entries(list, R.transliterate) })).loaded, list.length)
  const hits = async (catalog, list, query) => {
    const reply = await ask({ catalog, query: R.transliterate(query.toLowerCase()), sensitivity: "medium" })
    return F.hits(F.reply(JSON.stringify(reply)), ids(list))
  }

  const tree = OmarchyMenu.buildTree(OmarchyMenu.parse(`{
    "install": {"label":"Install"},
    "install.browser": {"label":"Browser"},
    "install.browser.firefox": {"label":"Firefox","action":"omarchy-install firefox"},
    "install.browser.chromium": {"label":"Chromium","action":"omarchy-install chromium"}
  }`).items, [])
  const root = [
    Root.appCandidate({ id: "firefox", name: "Firefox", genericName: "Web Browser", keywords: [], icon: "firefox" }),
    Root.appCandidate({ id: "chromium", name: "Chromium", genericName: "Web Browser", keywords: [], icon: "chromium" })
  ].concat(Root.menuCandidates(tree, {}, {}, deps))
  const menuFirefox = root.find(c => c.kind !== "app" && c.title === "Firefox").id
  await load("root", root)
  const rootHits = await hits("root", root, "fierfox")
  assert.ok(found(Root.rootSections(root, "fierfox", ctx(rootHits), deps)).includes("app:firefox"), "root")
  assert.deepEqual(found(Root.appGridSections(root, "fierfox", ctx(rootHits), deps)), ["app:firefox"], "Apps grid")
  assert.deepEqual(found(Root.submenuSections(root, "install", "fierfox", ctx(rootHits), deps)), [menuFirefox], "submenu")
  // The built-in matcher finds none of them: the helper's typo is what matched.
  assert.deepEqual(found(Root.appGridSections(root, "fierfox", ctx(null), deps)), [])
  assert.deepEqual(found(Root.submenuSections(root, "install", "fierfox", ctx(null), deps)), [])

  const builtins = Scopes.merge(Scopes.BUILTINS, []).scopes
  const ssh = builtins.find(s => s.id === "ssh"), steam = builtins.find(s => s.id === "steam")
  const hosts = ["webserver", "db"].map(value => Scopes.itemCandidate(ssh, { title: value, value, subtitle: "" }, s => s))
  await load("view", hosts)
  const hostHits = await hits("view", hosts, "wbeserver")
  assert.deepEqual(found(Root.scopeSections(hosts, "wbeserver", ctx(hostHits), deps, "Hosts", false)), ["scope-item:ssh:webserver"], "SSH host")
  assert.deepEqual(found(Root.scopeSections(hosts, "wbeserver", ctx(null), deps, "Hosts", false)), [])
  // The root list stays loaded beside the view's.
  assert.ok((await hits("root", root, "fierfox"))["app:firefox"])

  const games = [["548430", "Deep Rock Galactic"], ["8930", "Sid Meier's Civilization V"]]
    .map(([value, title]) => Scopes.itemCandidate(steam, { title, value, subtitle: "" }, s => s))
  await load("view", games)
  const gameHits = await hits("view", games, "galactik")
  assert.deepEqual(found(Root.scopeSections(games, "galactik", ctx(gameHits), deps, "Games", true)), ["scope-item:steam:548430"], "Steam game")
  assert.deepEqual(found(Root.scopeSections(games, "galactik", ctx(null), deps, "Games", true)), [])

  const values = Settings.resolve(require("../kit/node-loader.cjs").load("FoamyPrefs"), null)
  const rows = Root.settingsSections(values, "", ctx(null), deps).flatMap(s => s.rows.map(r => r.candidate))
  await load("view", rows)
  for (const query of ["strictnes", "stricntess"]) {
    const settingHits = await hits("view", rows, query)
    assert.deepEqual(found(Root.settingsSections(values, query, ctx(settingHits), deps)), ["setting:rootSearchSensitivity"], query)
  }
  assert.deepEqual(found(Root.settingsSections(values, "stricntess", ctx(null), deps)), [])
  child.stdin.end()
})

// Lowercasing a whole word gives a final sigma ("ΟΣ" gives "ος"); the
// helper's matcher lowercases each letter ("οσ"). Unless both sides fold it,
// the helper finds no item and its empty hits keep the built-in matcher out.
test("built helper finds a scope item whose title ends in a capital sigma", { skip: helper.skip, timeout: 10000 }, async t => {
  const child = spawn(helper.argv[0], helper.argv.slice(1), { stdio: ["pipe", "pipe", "inherit"] })
  t.after(() => child.kill())
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let serial = 0
  const ask = async obj => { child.stdin.write(JSON.stringify({ id: ++serial, ...obj }) + "\n"); return JSON.parse((await lines.next()).value) }
  const deps = { Ranker: R, Frecency, Scopes }
  const ssh = Scopes.merge(Scopes.BUILTINS, []).scopes.find(s => s.id === "ssh")
  const hosts = ["ΟΣ", "Οδυσσεύς", "db"].map(value => Scopes.itemCandidate(ssh, { title: value, value, subtitle: "" }, s => s))
  const ids = hosts.map(c => c.id)
  assert.equal((await ask({ catalog: "view", entries: F.entries(hosts, R.transliterate) })).loaded, hosts.length)
  for (const query of ["ΟΣ", "ος", "οσ"]) {
    const reply = await ask({ catalog: "view", query: R.transliterate(query.toLowerCase()), sensitivity: "medium" })
    const fleaHits = F.hits(F.reply(JSON.stringify(reply)), ids)
    const ctx = { commands: {}, frecency: {}, nowMs: 1000, filter: "all", searchScopes, fleaHits, t: s => s }
    const found = Root.scopeSections(hosts, query, ctx, deps, "Hosts", false).flatMap(s => s.rows.map(r => r.candidate.id))
    assert.deepEqual(found.sort(), ["scope-item:ssh:ΟΣ", "scope-item:ssh:Οδυσσεύς"], query)
  }
  child.stdin.end()
})
