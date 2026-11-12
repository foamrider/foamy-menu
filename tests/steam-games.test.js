// The Steam Games scope: its settings, the grid layouts, item pictures and
// `foamy-menu-search steam-games` over a fixture Steam root. The parsers
// themselves are tested in search/src/steam_games.rs.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const helper = require("./search-helper.js")
const Scopes = require("../core/Scopes.js")
const Settings = require("../core/Settings.js")
const RS = require("../core/RootSearch.js")
const Prefs = require("../kit/node-loader.cjs").load("FoamyPrefs")
const FoamyNative = require("../kit/node-loader.cjs").load("FoamyNative")

const root = path.join(__dirname, "..")
const skip = helper.skip && "no bundled search helper for this CPU"
const deps = { Ranker: require("../core/Ranker.js"), Frecency: require("../core/Frecency.js"), OmarchyMenu: require("../core/OmarchyMenu.js"), Scopes, Settings }
const ctx = { commands: {}, frecency: {}, nowMs: 0, sensitivity: "medium" }
const steamWith = (entry) => Scopes.merge(Settings.applyToScopes(Scopes.BUILTINS, Settings.resolve(Prefs, entry)), []).scopes.find((s) => s.id === "steam")

test("Games is a cover grid shown once Steam has games; steamGames adds them to the root search", () => {
  const defaults = Settings.resolve(Prefs, null)
  assert.equal(defaults.steamGames, false)
  const steam = steamWith(null)
  assert.deepEqual([steam.title, steam.subtitle, steam.keyword, steam.layout], ["Games", "Steam", "steam", "covers"])
  assert.deepEqual([steam.requireItems, steam.rootSearch], [true, false], "always a grid; not in the root search by default")
  assert.equal(steamWith({ steamGames: true }).rootSearch, true)
  assert.equal(steamWith({ steamGames: true }).layout, "covers", "the switch never changes the grid")
  assert.ok(!Scopes.isShown(steam, undefined), "hidden before the helper answers, or when it fails")
  assert.ok(!Scopes.isShown(steam, []), "hidden without Steam or games")
  assert.ok(Scopes.isShown(steam, [{ title: "Deep Rock Galactic", value: "548430" }]))
  assert.ok(Scopes.isShown(Scopes.BUILTINS[0], undefined), "other scopes need no items")
  assert.ok(Scopes.loadsEarly(steam) && !Scopes.loadsEarly(Scopes.BUILTINS[0]))
  const row = Scopes.scopeCandidate(steam)
  assert.deepEqual([row.title, row.subtitle, row.typeLabel], ["Games", "Steam", "Menu"], "the root row reads like Apps")
  assert.equal(Scopes.scopeCandidate(Scopes.BUILTINS[0]).typeLabel, "Scope", "list scopes stay scopes")
  const listed = Scopes.merge(Settings.applyToScopes(Scopes.BUILTINS, defaults),
    [{ name: "steam.json", definition: { id: "steam", layout: "list", keyword: "games" } }]).scopes.find((s) => s.id === "steam")
  assert.deepEqual([listed.layout, listed.keyword], ["list", "games"], "a scope file still overrides the built-in")
  const keys = RS.settingsSections(defaults, "", ctx, deps).flatMap((s) => s.rows.map((r) => r.candidate.settingKey)).filter(Boolean)
  assert.ok(keys.includes("steamGames") && !keys.some((k) => k.endsWith("Art")), "one switch, no art choice")
})

test("games are found from the root search, ranked and filtered as applications", () => {
  const steam = steamWith({ steamGames: true })
  assert.equal(steam.rootSearch, true)
  assert.equal(RS.actionsFor(Scopes.scopeCandidate(steam))[0].title, "Run", "Games runs like Apps")
  assert.equal(RS.actionsFor(Scopes.scopeCandidate(Scopes.BUILTINS[0]))[0].title, "Open Scope")
  const game = Scopes.rootItemCandidate(steam, { title: "Deep Rock Galactic", value: "548430", subtitle: "" })
  assert.deepEqual([game.id, game.type, game.kind, game.subtitle, game.typeLabel, game.rootSearch.when],
    ["scope-item:steam:548430", "application", "scope-item", "Steam", "Game", "searching"])
  const app = RS.appCandidate({ id: "deep-rock-notes", name: "Deep Notes" })
  const found = RS.rootSections([app, game], "deep rock", ctx, deps)
  assert.equal(found[0].rows[0].candidate.id, game.id)
  assert.ok(!RS.rootSections([app, game], "", ctx, deps).some((s) => s.rows.some((r) => r.candidate.id === game.id)), "not listed until you type")
  assert.ok(RS.rootSections([app, game], "deep", Object.assign({}, ctx, { filter: "applications" }), deps)[0].rows.some((r) => r.candidate.id === game.id), "under the Applications filter")
  assert.deepEqual(RS.appGridSections([app, game], "", ctx, deps)[0].rows.map((r) => r.candidate.id), [app.id], "the Apps grid keeps to apps")
  assert.match(Scopes.normalize({ id: "q", title: "Q", source: { type: "query" }, open: ["true"], rootSearch: true }).errors[0], /no items for rootSearch/)
  assert.match(Scopes.normalize({ id: "q", title: "Q", source: { type: "query" }, open: ["true"], requireItems: true }).errors[0], /no items for rootSearch or requireItems/)
  assert.equal(Scopes.merge(Scopes.BUILTINS, []).scopes.find((s) => s.id === "ssh").rootSearch, false, "SSH hosts stay in their scope")
})

test("Enter plays through the steam:// handler; only app ids are used", () => {
  const steam = steamWith({ steamGames: true })
  assert.deepEqual(Scopes.fill(steam.open, "548430", root), ["uwsm-app", "--", "xdg-open", "steam://rungameid/548430"])
  assert.deepEqual(steam.actions.map((a) => a.title), ["Show in Library", "Open Store Page", "Copy App ID"])
  assert.ok(Scopes.valueAllowed(steam, "8930"))
  for (const bad of ["-1", "8930; rm", "", "12345678901"]) assert.ok(!Scopes.valueAllowed(steam, bad), bad)
})

test("layout is list, icons or covers; query scopes stay lists", () => {
  const base = { id: "x", title: "X", source: { type: "list", items: ["a"] }, open: ["true"] }
  assert.equal(Scopes.normalize(base).scope.layout, "list")
  assert.equal(Scopes.normalize(Object.assign({}, base, { layout: "icons" })).scope.layout, "icons")
  assert.match(Scopes.normalize(Object.assign({}, base, { layout: "tiles" })).errors[0], /layout must be/)
  assert.match(Scopes.normalize({ id: "q", title: "Q", source: { type: "query" }, open: ["true"], layout: "covers" }).errors[0], /no grid layout/)
})

test("items carry an icon and a cover: absolute paths, or an icon name for the icon", () => {
  const out = [
    "Game\t1\t\t/art/1.ico\t/art/1 cover.jpg",
    "Named\t2\t\tsteam\trelative.jpg",
    "Bare\t3",
    "Escape\t4\t\t/art/../etc/x\t/a/\u0001b"
  ].join("\n")
  assert.deepEqual(Scopes.parseOutput(out), [
    { title: "Game", value: "1", subtitle: "", icon: "/art/1.ico", cover: "/art/1 cover.jpg" },
    { title: "Named", value: "2", subtitle: "", icon: "steam" },
    { title: "Bare", value: "3", subtitle: "" },
    { title: "Escape", value: "4", subtitle: "" }
  ])
  const list = Scopes.normalize({ id: "x", title: "X", open: ["true"], source: { type: "list", items: [{ title: "a", icon: "/i.png", cover: "c.jpg" }] } })
  assert.deepEqual(list.scope.source.items, [{ title: "a", value: "a", subtitle: "", icon: "/i.png" }])
  const steam = steamWith({ steamGames: true })
  const c = Scopes.itemCandidate(steam, Scopes.parseOutput(out)[0])
  assert.deepEqual([c.image, c.cover, c.fallbackIcon, c.glyph], ["/art/1.ico", "/art/1 cover.jpg", "steam", steam.icon])
})

test("image URLs: .ico through the icon provider (largest size), files encoded", () => {
  assert.equal(Scopes.imageUrl("/s/games/ab.ico"), "image://icon//s/games/ab.ico")
  assert.equal(Scopes.imageUrl("/s/My Art/#1.jpg"), "file:///s/My%20Art/%231.jpg")
  assert.equal(Scopes.imageUrl("steam"), "", "an icon name is the app library's to resolve")
  assert.equal(Scopes.imageUrl(""), "")
})

test("a grid scope is one untitled section in the source's order, ranked by a query", () => {
  const steam = steamWith({ steamGames: true })
  const items = ["Alpha", "Rocket League", "Zeta"].map((t, i) => Scopes.itemCandidate(steam, { title: t, value: String(i + 1), subtitle: "" }))
  const frecency = { [items[2].id]: { anchor: 1e9, openedAt: 1e12, searchTerms: {} } }
  const all = RS.scopeSections(items, "", Object.assign({}, ctx, { frecency }), deps, "Games", true)
  assert.deepEqual(all.map((s) => s.title), [""], "no Recent section in a grid")
  assert.deepEqual(all[0].rows.map((r) => r.candidate.title), ["Alpha", "Rocket League", "Zeta"])
  const found = RS.scopeSections(items, "rocket", ctx, deps, "Games", true)
  assert.deepEqual([found.length, found[0].title, found[0].rows[0].candidate.title], [1, "", "Rocket League"])
  assert.deepEqual(RS.scopeSections([], "", ctx, deps, "Games", true), [])
})

// ------------------------------------------------------------ the helper

const HASH_A = "2dfa1f3e740ae5300bf59e9a14066391dab4727a"
const HASH_B = "e033e23c29a192a17c16a7645a2b423ac64ff447"

// appinfo.vdf version 28 (keys inline) with appinfo/common/{fields} per app.
function appinfo(apps) {
  const parts = [Buffer.from([0x28, 0x44, 0x56, 0x07, 1, 0, 0, 0])]
  const cstr = (s) => Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])])
  for (const [appid, fields] of apps) {
    const kv = Buffer.concat([
      Buffer.from([0x00]), cstr("appinfo"), Buffer.from([0x00]), cstr("common"),
      ...Object.entries(fields).flatMap(([k, v]) => [Buffer.from([0x01]), cstr(k), cstr(v)]),
      Buffer.from([0x08, 0x08, 0x08])
    ])
    const head = Buffer.alloc(8)
    head.writeUInt32LE(appid, 0)
    head.writeUInt32LE(60 + kv.length, 4)
    parts.push(head, Buffer.alloc(60), kv)
  }
  parts.push(Buffer.alloc(4))
  return Buffer.concat(parts)
}

function makeSteam() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "foamy-steam-"))
  const steam = path.join(home, ".local/share/Steam")
  const write = (rel, data) => {
    const file = path.join(steam, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, data)
    return file
  }
  const manifest = (appid, name) => write(`steamapps/appmanifest_${appid}.acf`,
    `"AppState"\n{\n\t"appid"\t\t"${appid}"\n\t"name"\t\t"${name}"\n\t"StateFlags"\t\t"4"\n}\n`)
  write("steamapps/libraryfolders.vdf", `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${steam}"\n\t}\n}\n`)
  manifest(548430, "Deep Rock Galactic")
  manifest(8930, "Sid Meier's Civilization V")
  manifest(1493710, "Proton Experimental")
  manifest(228980, "Steamworks Common Redistributables")
  write("appcache/appinfo.vdf", appinfo([
    [8930, { type: "Game", icon: HASH_B }],
    [548430, { type: "game", clienticon: HASH_A }],
    [228980, { type: "Config" }]
  ]))
  const art = {
    ico: write(`steam/games/${HASH_A}.ico`, "ico"),
    small: write(`appcache/librarycache/8930/${HASH_B}.jpg`, "jpg"),
    capsule: write(`appcache/librarycache/548430/${HASH_B}/library_capsule.jpg`, "jpg"),
    cover: write("appcache/librarycache/8930/library_600x900.jpg", "jpg")
  }
  return { home, steam, art }
}

test("the Steam Games scope runs the bundled helper's steam-games, as FoamyNative launches it", { skip }, () => {
  const steam = Scopes.BUILTINS.find((s) => s.id === "steam")
  const argv = Scopes.fill(steam.source.command, "", root)
  assert.deepEqual(argv, Array.from(FoamyNative.command(root, "foamy-menu-search", ["steam-games"])))
  assert.ok(Scopes.isNativeCommand(argv))
  const fixture = makeSteam()
  try {
    const [program, ...args] = helper.required ? [...helper.argv, "steam-games"] : argv
    const out = execFileSync(program, args, { env: { HOME: fixture.home, PATH: process.env.PATH }, encoding: "utf8", timeout: 10000 })
    const real = fs.realpathSync(fixture.steam)
    const at = (file) => path.join(real, path.relative(fixture.steam, file))
    assert.deepEqual(Scopes.parseOutput(out), [
      { title: "Deep Rock Galactic", value: "548430", subtitle: "", icon: at(fixture.art.ico), cover: at(fixture.art.capsule) },
      { title: "Sid Meier's Civilization V", value: "8930", subtitle: "", icon: at(fixture.art.small), cover: at(fixture.art.cover) }
    ], "tools are left out, games sorted by name with their art")
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "foamy-steam-none-"))
    try {
      assert.equal(execFileSync(program, args, { env: { HOME: empty, PATH: process.env.PATH }, encoding: "utf8" }), "", "no Steam, no games")
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true })
  }
})

test("steam-games rejects other arguments without the exits FoamyNative reserves", { skip }, () => {
  const [program, ...args] = [...helper.argv, "steam-games", "extra"]
  let status = 0
  try { execFileSync(program, args, { stdio: "pipe" }) } catch (error) { status = error.status }
  assert.equal(status, 2)
  assert.ok(!FoamyNative.unavailable(status))
})
