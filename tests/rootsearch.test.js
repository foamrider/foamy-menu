const test = require("node:test")
const assert = require("node:assert/strict")
const Ranker = require("../core/Ranker.js")
const Frecency = require("../core/Frecency.js")
const OmarchyMenu = require("../core/OmarchyMenu.js")
const RS = require("../core/RootSearch.js")
const Scopes = require("../core/Scopes.js")

const deps = { Ranker, Frecency, OmarchyMenu, Scopes }
const searchScopes = Scopes.merge(Scopes.BUILTINS, []).scopes.filter(Scopes.isQuery)
const NOW = Date.UTC(2026, 9, 19, 12)

const apps = ["firefox", "chromium", "signal-desktop", "org.gnome.Nautilus", "Alacritty", "libreoffice-writer"].map((id) => ({
  id,
  name: { firefox: "Firefox", chromium: "Chromium", "signal-desktop": "Signal", "org.gnome.Nautilus": "Files", Alacritty: "Alacritty", "libreoffice-writer": "LibreOffice Writer" }[id],
  genericName: { firefox: "Web Browser", chromium: "Web Browser", "org.gnome.Nautilus": "File Manager" }[id] || "",
  keywords: [],
  icon: id
}))

const menu = OmarchyMenu.buildTree(OmarchyMenu.parse(`{
  "system": {"label":"System"},
  "system.lock": {"icon":"l","label":"Lock","action":"omarchy-system-lock"},
  "system.shutdown": {"label":"Shutdown","action":"omarchy-system shutdown"},
  "trigger": {"label":"Trigger"},
  "trigger.toggle": {"label":"Toggle"},
  "trigger.toggle.nightlight": {"label":"Nightlight","action":"omarchy-toggle-nightlight"},
  "style": {"label":"Style"},
  "style.font": {"label":"Font","provider":"fonts"}
}`).items, [])

function candidates(guards, providerItems) {
  return apps.map(RS.appCandidate)
    .concat(RS.menuCandidates(menu, guards || { when: {}, checked: {}, disabled: {} }, providerItems || {}, deps))
    .concat(RS.BUILTINS.map(RS.builtinCandidate))
}

function ctx(extra) {
  return Object.assign({ commands: {}, frecency: {}, nowMs: NOW, sensitivity: "medium", searchScopes }, extra || {})
}

const titles = (section) => section.rows.map((r) => r.candidate.title)
const results = (query, c) => RS.rootSections(candidates(), query, c || ctx(), deps)

test("fir finds Firefox first (Phase 1 accept)", () => {
  const sections = results("fir")
  assert.equal(sections[0].id, "results")
  assert.equal(titles(sections[0])[0], "Firefox")
})

test("a query always ends with the fallback section", () => {
  const sections = results("zzzz-nothing")
  assert.equal(sections.length, 1)
  assert.equal(sections[0].id, "fallback-commands")
  assert.equal(sections[0].title, "Use “%1” with…")
  assert.deepEqual(sections[0].titleValues, ["zzzz-nothing"])
  assert.deepEqual(titles(sections[0]), ["Search Google", "Search DuckDuckGo"])
  assert.deepEqual(sections[0].rows.map((r) => [r.candidate.id, r.candidate.subtitle]), [["scope-query:google", "zzzz-nothing"], ["scope-query:duckduckgo", "zzzz-nothing"]])
  assert.deepEqual(RS.rootSections(candidates(), "zzzz-nothing", ctx({ searchScopes: [] }), deps), [], "no query scopes, no fallback section")
})

test("an exact alias puts its command on top (Phase 1 accept)", () => {
  const c = ctx({ commands: { "app:chromium": { alias: "ff" } } })
  assert.equal(titles(results("ff", c)[0])[0], "Chromium")
  assert.equal(titles(results("f", c)[0])[0], "Chromium", "an alias prefix also wins over title scores")
})

test("launching bumps frecency and teaches the query (Phase 1 accept)", () => {
  const before = titles(results("web")[0])
  assert.deepEqual(before.slice(0, 2), ["Chromium", "Firefox"])
  const visit = Frecency.recordVisit(null, NOW - 1000, "web")
  const c = ctx({ frecency: { "app:firefox": visit } })
  assert.deepEqual(titles(results("web", c)[0]).slice(0, 2), ["Firefox", "Chromium"])
})

test("deep Omarchy items only appear while searching, with breadcrumbs", () => {
  const empty = results("")
  const all = empty.flatMap((s) => s.rows.map((r) => r.candidate.title))
  assert.ok(all.includes("System") && all.includes("Trigger"))
  assert.ok(!all.includes("Nightlight"))
  const night = results("nightlight")[0].rows[0].candidate
  assert.equal(night.title, "Nightlight")
  assert.equal(night.subtitle, "Trigger › Toggle")
  assert.equal(night.kind, "omarchy-action")
})

test("empty root: favorites, suggestions, commands, applications", () => {
  const c = ctx({
    commands: { "omarchy:system.lock": { favoriteOrder: 0 } },
    frecency: { "app:signal-desktop": Frecency.recordVisit(null, NOW - 1000, "") }
  })
  const sections = results("", c)
  assert.deepEqual(sections.map((s) => s.id), ["favorites", "suggestions", "commands", "apps"])
  assert.deepEqual(titles(sections[0]), ["Lock"])
  assert.deepEqual(titles(sections[1]), ["Signal"])
  assert.ok(!titles(sections[3]).includes("Signal"), "suggested apps are not repeated")
})

test("hidden menu rows (when: false) and disabled commands are left out", () => {
  const sections = RS.rootSections(candidates({ when: { "system.shutdown": false }, checked: {}, disabled: {} }), "shutdown", ctx(), deps)
  assert.equal(sections[0].id, "fallback-commands")
  const off = results("signal", ctx({ commands: { "app:signal-desktop": { enabled: false } } }))
  assert.ok(!off.some((s) => s.id === "results" && titles(s).includes("Signal")))
})

test("a submenu lists its children, and searches its descendants", () => {
  const children = RS.submenuSections(candidates(), "trigger", "", ctx(), deps)
  assert.deepEqual(titles(children[0]), ["Toggle"])
  const found = RS.submenuSections(candidates(), "trigger", "night", ctx(), deps)
  assert.deepEqual(titles(found[0]), ["Nightlight"])
})

test("the Apps grid lists only enabled apps, A–Z, and ranks a query", () => {
  const all = RS.appGridSections(candidates(), "", ctx(), deps)
  assert.equal(all.length, 1)
  assert.equal(all[0].title, "", "one untitled section, so the grid has no header rows")
  assert.deepEqual(titles(all[0]), ["Alacritty", "Chromium", "Files", "Firefox", "LibreOffice Writer", "Signal"])
  const off = RS.appGridSections(candidates(), "", ctx({ commands: { "app:signal-desktop": { enabled: false } } }), deps)
  assert.ok(!titles(off[0]).includes("Signal"))
  assert.equal(titles(RS.appGridSections(candidates(), "fir", ctx(), deps)[0])[0], "Firefox")
  assert.deepEqual(RS.appGridSections(candidates(), "zzzz-nothing", ctx(), deps), [])
})

test("the stock Apps item opens the inline grid and is labelled a menu", () => {
  const tree = OmarchyMenu.buildTree(OmarchyMenu.parse(`{
    "apps": {"label":"Apps","provider":"apps","action":"omarchy-shell omarchy.dock apps"},
    "about": {"label":"About","action":"omarchy-launch-about"}
  }`).items, [])
  const [apps, about] = RS.menuCandidates(tree, { when: {}, checked: {}, disabled: {} }, {}, deps)
  assert.ok(RS.isAppGridItem(apps))
  assert.equal(apps.typeLabel, "Menu")
  assert.ok(!RS.isAppGridItem(about))
  assert.equal(about.typeLabel, "Command")
})

test("a submenu follows the menu tree: an extension's explicit parent counts", () => {
  const tree = OmarchyMenu.buildTree(OmarchyMenu.parse(`{
    "tools": {"label":"Tools"},
    "custom": {"label":"Custom","parent":"tools","action":"true"},
    "tools.native": {"label":"Native","action":"true"},
    "tools.deep": {"label":"Deep"},
    "tools.deep.xylo": {"label":"Xylo","action":"true"}
  }`).items, [])
  const all = RS.menuCandidates(tree, { when: {}, checked: {}, disabled: {} }, {}, deps)
  assert.deepEqual(titles(RS.submenuSections(all, "tools", "", ctx(), deps)[0]), ["Custom", "Native", "Deep"])
  assert.deepEqual(titles(RS.submenuSections(all, "tools", "cust", ctx(), deps)[0]), ["Custom"])
  assert.deepEqual(titles(RS.submenuSections(all, "tools", "xylo", ctx(), deps)[0]), ["Xylo"], "a query searches every level below")
  assert.deepEqual(RS.submenuSections(all, "tools.deep", "cust", ctx(), deps), [])
})

test("provider rows are searchable under their menu", () => {
  const rows = OmarchyMenu.providerItems("style.font", "fonts", "Iosevka\tIosevka\tIosevka\n")
  const sections = RS.rootSections(candidates(null, { "style.font": rows }), "iosevka", ctx(), deps)
  const hit = sections[0].rows[0].candidate
  assert.equal(hit.title, "Iosevka")
  assert.equal(hit.subtitle, "Style › Font")
  assert.equal(hit.checked, true)
})

test("actions: primary first, favourites and alias offered", () => {
  const app = RS.decorate(RS.appCandidate(apps[0]), ctx(), deps)
  const ids = RS.actionsFor(app).map((a) => a.id)
  assert.equal(ids[0], "open")
  assert.ok(ids.includes("favorite-add") && ids.includes("set-alias") && ids.includes("copy-id"))
  const menuItem = RS.decorate(candidates().find((c) => c.id === "omarchy:system.lock"), ctx(), deps)
  assert.deepEqual(RS.actionsFor(menuItem).slice(0, 2).map((a) => a.id), ["open", "open-in-omarchy-menu"])
})

test("favourite reordering", () => {
  const cmds = { a: { favoriteOrder: 0 }, b: { favoriteOrder: 1 }, c: {} }
  assert.deepEqual(RS.reorderFavorites(cmds, "c", "favorite-add"), { a: 0, b: 1, c: 2 })
  assert.deepEqual(RS.reorderFavorites(cmds, "b", "favorite-up"), { b: 0, a: 1 })
  assert.deepEqual(RS.reorderFavorites(cmds, "a", "favorite-remove"), { a: null, b: 0 })
})

test("web searches are query scopes, not commands with argument pills", () => {
  assert.ok(!RS.BUILTINS.some((b) => b.arguments || (b.run && b.run.url)))
  const google = searchScopes.find((s) => s.id === "google")
  assert.equal(Scopes.fill(google.open, " a&b c ", "")[1], "https://www.google.com/search?q=a%26b%20c")
  assert.deepEqual(RS.actionsFor(Scopes.queryCandidate(google, "x", null, true)).map((a) => a.title), ["Search", "Copy Search URL"])
})

test("the root filter narrows by type and drops calculator and fallbacks", () => {
  const apps = results("", ctx({ filter: "applications" }))
  assert.deepEqual(apps.map((s) => s.id), ["apps"])
  const commands = results("lock", ctx({ filter: "commands", calculation: { result: "1" } }))
  assert.ok(commands.every((s) => s.id === "results"))
  assert.ok(commands[0].rows.every((r) => r.candidate.type === "command"))
  assert.deepEqual(RS.FILTERS.map((f) => f.id), ["all", "applications", "commands"])
})

test("power commands and delete-all ask for confirmation", () => {
  assert.equal(RS.confirmationFor("omarchy:system.shutdown", "open").primary, "Shut Down")
  assert.equal(RS.confirmationFor("omarchy:system.shutdown", "copy-command"), null)
  assert.equal(RS.confirmationFor("omarchy:system.lock", "open"), null)
  assert.ok(RS.confirmationFor("calculator-history:x", "delete-all-entries").destructive)
})

test("the about panel describes a row", () => {
  const lock = results("lock")[0].rows[0].candidate
  const about = Object.fromEntries(RS.aboutFor(lock, NOW).map((r) => [r.label, r.value]))
  assert.equal(about.Command, "omarchy-system-lock")
  assert.equal(about.ID, "omarchy:system.lock")
  assert.equal(about.Location, "System")
  const calc = RS.aboutFor({ kind: "calculator", calcInput: "2+2", calcResult: "4", calcPlain: "4" }, NOW)
  assert.deepEqual(calc.map((r) => r.label), ["Question", "Answer"])
  const grouped = RS.aboutFor({ kind: "calculator", calcInput: "1000*2", calcResult: "2 000", calcPlain: "2000" }, NOW)
  assert.deepEqual(grouped.map((r) => [r.label, r.value]), [["Question", "1000*2"], ["Answer", "2 000"], ["Plain", "2000"]])
})

test("app windows: keys from desktop id, StartupWMClass and web app URL", () => {
  assert.deepEqual(RS.appWindowKeys({ id: "sublime_text", startupClass: "subl" }), ["sublime_text", "subl"])
  assert.deepEqual(RS.appWindowKeys({ id: "WhatsApp", execString: '/home/u/.local/bin/chrome-webapp "https://web.whatsapp.com/"' }), ["whatsapp", "webapp:web.whatsapp.com"])
  assert.deepEqual(RS.appWindowKeys({ id: "Chat", command: ["omarchy-launch-webapp", "https://app.parlichat.com/chats"] }), ["chat", "webapp:app.parlichat.com/chats"])
  assert.deepEqual(RS.windowClassKeys("chrome-discord.com__channels_@me-Profile_1"), ["chrome-discord.com__channels_@me-profile_1", "webapp:discord.com/channels/@me"])
  assert.deepEqual(RS.appWindowKeys({ id: "firefox", execString: "firefox https://example.com" }), ["firefox"])
  assert.deepEqual(RS.windowClassKeys("chrome-web.whatsapp.com__-Default"), ["chrome-web.whatsapp.com__-default", "webapp:web.whatsapp.com"])
  assert.deepEqual(RS.windowClassKeys("brave-app.parlichat.com__chats-Default"), ["brave-app.parlichat.com__chats-default", "webapp:app.parlichat.com/chats"])
})

test("app windows: picks the most recently focused mapped window", () => {
  const clients = [
    { class: "firefox", address: "0xa", focusHistoryID: 3, mapped: true },
    { class: "Firefox", address: "0xb", focusHistoryID: 1, mapped: true },
    { class: "firefox", address: "0xc", focusHistoryID: 0, mapped: false },
    { class: "chrome-web.whatsapp.com__-Default", address: "0xd", focusHistoryID: 2, mapped: true }
  ]
  assert.equal(RS.findAppWindow(clients, ["firefox"]), "0xb")
  assert.equal(RS.findAppWindow(clients, ["whatsapp", "webapp:web.whatsapp.com"]), "0xd")
  assert.equal(RS.findAppWindow(clients, ["signal-desktop"]), "")
  assert.equal(RS.findAppWindow(clients, []), "")
})

test("actions: apps offer Open New Window on Shift+Enter", () => {
  const app = RS.decorate(RS.appCandidate(apps[0]), ctx(), deps)
  const openNew = RS.actionsFor(app).find((a) => a.id === "open-new")
  assert.equal(openNew.shortcut, "Shift ↵")
})

// Two rootSection scopes: the built-in Steam turned on by a scope file with
// no heading, then a user scope with one. Their root items join the usual
// candidates.
const sectionMerge = Scopes.merge(Scopes.BUILTINS, [
  { name: "steam.json", definition: { id: "steam", rootSection: true } },
  { name: "notes.json", definition: { id: "notes", title: "Notes", rootSection: true, rootSectionTitle: "My Notes", source: { type: "list", items: ["Firefox tips", "Portal ideas"] }, open: ["true"] } }
]).scopes
const sectionScopes = sectionMerge.filter((s) => s.rootSection).map((s) => ({ id: s.id, title: s.rootSectionTitle }))
const games = [{ title: "Portal 2", value: "620", subtitle: "" }, { title: "Hades", value: "1145360", subtitle: "" }, { title: "Deep Rock Galactic", value: "548430", subtitle: "" }]
function withSections() {
  const steam = sectionMerge.find((s) => s.id === "steam")
  const notes = sectionMerge.find((s) => s.id === "notes")
  return candidates()
    .concat(games.map((g) => Scopes.rootItemCandidate(steam, g)))
    .concat(notes.source.items.map((item) => Scopes.rootItemCandidate(notes, item)))
}
const sectionCtx = (extra) => ctx(Object.assign({ sectionScopes }, extra || {}))
const ids = (section) => section.rows.map((r) => r.candidate.id)

test("rootSection: the empty root lists untitled scopes' items among Applications, titled ones after it", () => {
  const sections = RS.rootSections(withSections(), "", sectionCtx(), deps)
  assert.deepEqual(sections.map((s) => s.id), ["commands", "apps", "scope-section:notes"])
  const plainApps = titles(RS.rootSections(withSections(), "", ctx(), deps)[1])
  assert.deepEqual(titles(sections[1]).sort(), plainApps.concat(["Deep Rock Galactic", "Hades", "Portal 2"]).sort(), "Steam has no heading, so its games join Applications")
  assert.deepEqual([sections[2].title, sections[2].titleValues], ["%1", ["My Notes"]])
  assert.deepEqual(titles(sections[2]).sort(), ["Firefox tips", "Portal ideas"])
  assert.ok(!titles(sections[1]).includes("Portal ideas"), "a titled scope's items are not also under Applications")
  assert.deepEqual(RS.rootSections(withSections(), "", ctx(), deps).map((s) => s.id), ["commands", "apps"], "no section without rootSection")
  assert.ok(!titles(RS.rootSections(withSections(), "", ctx(), deps)[1]).includes("Hades"), "no games without rootSection")
})

test("rootSection: scopes with the same title share one section, sorted together", () => {
  const merged = Scopes.merge(Scopes.BUILTINS, [
    { name: "steam.json", definition: { id: "steam", rootSection: true, rootSectionTitle: "Spill" } },
    { name: "notes.json", definition: { id: "notes", title: "Notes", rootSection: true, rootSectionTitle: "Notater", source: { type: "list", items: ["Firefox tips"] }, open: ["true"] } },
    { name: "prism.json", definition: { id: "prism", title: "Minecraft", rootSection: true, rootSectionTitle: "Spill", source: { type: "list", items: ["Atlas", "Zebra"] }, open: ["true"] } }
  ]).scopes
  const scopes = merged.filter((s) => s.rootSection).map((s) => ({ id: s.id, title: s.rootSectionTitle }))
  assert.deepEqual(scopes.map((s) => s.id), ["steam", "notes", "prism"], "scope order puts another section between them")
  const all = candidates()
    .concat(games.map((g) => Scopes.rootItemCandidate(merged.find((s) => s.id === "steam"), g)))
    .concat(["notes", "prism"].flatMap((id) => { const sc = merged.find((s) => s.id === id); return sc.source.items.map((item) => Scopes.rootItemCandidate(sc, item)) }))
  const sections = RS.rootSections(all, "", ctx({ sectionScopes: scopes }), deps)
  assert.deepEqual(sections.map((s) => [s.id, s.titleValues]), [["commands", undefined], ["apps", undefined], ["scope-section:steam", ["Spill"]], ["scope-section:notes", ["Notater"]]])
  assert.deepEqual(titles(sections[2]), ["Atlas", "Deep Rock Galactic", "Hades", "Portal 2", "Zebra"], "games and instances in one ranked list")
  const onlyPrism = all.filter((c) => c.scopeId !== "steam")
  assert.deepEqual(titles(RS.rootSections(onlyPrism, "", ctx({ sectionScopes: scopes }), deps).find((s) => s.titleValues && s.titleValues[0] === "Spill")), ["Atlas", "Zebra"], "the section stays when the first scope has no items")
})

test("rootSection: favorites and recently used items are not repeated among Applications or in a section", () => {
  const c = sectionCtx({
    commands: { "scope-item:steam:620": { favoriteOrder: 0 }, "scope-item:notes:Portal ideas": { favoriteOrder: 1 } },
    frecency: { "scope-item:steam:1145360": Frecency.recordVisit(null, NOW - 1000, "") }
  })
  const sections = RS.rootSections(withSections(), "", c, deps)
  assert.deepEqual(sections.map((s) => s.id), ["favorites", "suggestions", "commands", "apps", "scope-section:notes"])
  assert.deepEqual(ids(sections[0]), ["scope-item:steam:620", "scope-item:notes:Portal ideas"])
  assert.deepEqual(ids(sections[1]), ["scope-item:steam:1145360"], "a recently used game stays under Suggestions")
  assert.deepEqual(ids(sections[3]).filter((id) => id.startsWith("scope-item:")), ["scope-item:steam:548430"])
  assert.deepEqual(ids(sections[4]), ["scope-item:notes:Firefox tips"])
})

test("rootSection: while typing, section items rank in Results with everything else", () => {
  const all = withSections()
  for (const q of ["portal", "fir", "deep", "rock", "ha"]) {
    const sections = RS.rootSections(all, q, sectionCtx(), deps)
    assert.ok(!sections.some((s) => s.id.startsWith("scope-section:")), `no section heading for "${q}"`)
    assert.deepEqual(sections, RS.rootSections(all, q, ctx(), deps), `"${q}" ranks as without rootSection`)
  }
  const portal = RS.rootSections(all, "portal", sectionCtx(), deps)
  assert.deepEqual(portal[0].id, "results")
  assert.ok(ids(portal[0]).includes("scope-item:steam:620"))
  assert.equal(titles(RS.rootSections(all, "fir", sectionCtx(), deps)[0])[0], "Firefox")
})

test("rootSection: while typing, the helper's hits put section items in Results", () => {
  const all = withSections()
  const fleaHits = { "scope-item:steam:1145360": { index: 0, title: 4000000, alternate: null, subtitle: null, keyword: null } }
  assert.ok(!RS.rootSections(all, "qqq", sectionCtx(), deps).some((s) => s.id === "results"), "the JS ranker finds nothing")
  const sections = RS.rootSections(all, "qqq", sectionCtx({ fleaHits }), deps)
  assert.deepEqual(sections.map((s) => s.id), ["results", "fallback-commands"])
  assert.deepEqual(ids(sections[0]), ["scope-item:steam:1145360"])
})

test("rootSection: the Commands filter hides the scope items, Applications keeps them", () => {
  const commands = RS.rootSections(withSections(), "", sectionCtx({ filter: "commands" }), deps)
  assert.ok(!commands.some((s) => s.rows.some((r) => r.candidate.scopeId)))
  const apps = RS.rootSections(withSections(), "", sectionCtx({ filter: "applications" }), deps)
  assert.deepEqual(apps.map((s) => s.id), ["apps", "scope-section:notes"])
  assert.ok(titles(apps[0]).includes("Hades"))
})
