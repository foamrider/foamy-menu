const test = require("node:test")
const assert = require("node:assert/strict")
const Ranker = require("../core/Ranker.js")
const Frecency = require("../core/Frecency.js")
const OmarchyMenu = require("../core/OmarchyMenu.js")
const RS = require("../core/RootSearch.js")
const Scopes = require("../core/Scopes.js")

const deps = { Ranker, Frecency, OmarchyMenu, Scopes }
const NOW = Date.UTC(2026, 10, 6, 12)
const ctx = (extra) => Object.assign({ commands: {}, frecency: {}, nowMs: NOW, sensitivity: "medium" }, extra || {})
const file = (name, definition) => ({ name, definition })

test("the built-in SSH scope is enabled and valid", () => {
  const { scopes, errors } = Scopes.merge(Scopes.BUILTINS, [])
  assert.deepEqual(errors, [])
  // Games (steam) is enabled; the launcher offers it only once Steam lists games.
  assert.deepEqual(scopes.map((s) => s.id), ["ssh", "google", "duckduckgo", "steam"])
  const ssh = scopes[0]
  assert.equal(ssh.keyword, "ssh")
  assert.equal(ssh.source.type, "command")
  assert.equal(ssh.source.timeout, 10000)
  assert.ok(ssh.open.includes("{value}"))
})

test("a user file overrides a built-in by id, and enabled: false turns it off", () => {
  assert.deepEqual(Scopes.merge(Scopes.BUILTINS, [file("ssh.json", { id: "ssh", enabled: false })]).scopes.map((s) => s.id), ["google", "duckduckgo", "steam"])
  const renamed = Scopes.merge(Scopes.BUILTINS, [file("ssh.json", { id: "ssh", keyword: "s", openTitle: "Go" })]).scopes[0]
  assert.equal(renamed.keyword, "s")
  assert.equal(renamed.openTitle, "Go")
  assert.equal(renamed.title, "SSH", "fields the file leaves out stay built-in")
  assert.equal(renamed.builtin, true, "a file cannot clear the built-in flag")
})

test("user scopes are added after built-ins; invalid ones are reported, not loaded", () => {
  const { scopes, errors } = Scopes.merge(Scopes.BUILTINS, [
    file("tmux.json", { id: "tmux", title: "Tmux", source: { type: "command", command: ["tmux", "ls", "-F", "#S"] }, open: ["omarchy-launch-tui", "tmux", "attach", "-t", "{value}"] }),
    file("bad.json", { id: "bad", title: "Bad", source: { type: "command", command: "ls" }, open: ["x"] }),
    file("clash.json", { id: "clash", title: "Clash", keyword: "SSH", source: { type: "list", items: ["a"] }, open: ["x", "{value}"] }),
    file("off.json", { id: "off", enabled: false, title: "Off", source: { type: "list", items: [] }, open: ["x"] }),
    { name: "broken.json", errors: ["not valid JSON"] }
  ])
  assert.deepEqual(scopes.map((s) => s.id), ["ssh", "google", "duckduckgo", "steam", "tmux"])
  assert.deepEqual(errors.map((e) => e.file).sort(), ["bad.json", "broken.json", "clash.json"])
  assert.match(errors.find((e) => e.file === "clash.json").errors[0], /already used by ssh/)
  assert.match(errors.find((e) => e.file === "bad.json").errors.join(), /source.command/)
})

test("a scope file takes its id from the file name and must be an object", () => {
  assert.equal(Scopes.parseFile("bookmarks.json", '{"title":"Bookmarks"}').definition.id, "bookmarks")
  assert.ok(Scopes.parseFile("x.json", "[1]").errors)
  assert.ok(Scopes.parseFile("x.json", "{").errors)
  assert.ok(Scopes.normalize({ id: "Bad Id", title: "x" }).errors)
  assert.ok(Scopes.normalize({ id: "x", title: "X", source: { type: "list", items: [] }, open: ["{value}"] }).errors, "{value} cannot be the program")
  assert.ok(Scopes.normalize({ id: "x", title: "X", source: { type: "list", items: [] }, open: ["a"], valuePattern: "(" }).errors)
  assert.ok(Scopes.normalize({ id: "x", title: "X", source: { type: "list", items: [] }, open: ["a"], actions: [{ title: "Both", copy: "a", open: ["b"] }] }).errors)
})

test("Tab names a scope by its keyword, with or without a search after it", () => {
  const { scopes } = Scopes.merge(Scopes.BUILTINS, [])
  assert.equal(Scopes.matchKeyword(scopes, "ssh").scope.id, "ssh")
  assert.equal(Scopes.matchKeyword(scopes, "SSH").rest, "")
  assert.deepEqual([Scopes.matchKeyword(scopes, "  ssh  prod web").rest], ["prod web"])
  assert.equal(Scopes.matchKeyword(scopes, "sshd"), null)
  assert.equal(Scopes.matchKeyword(scopes, "s"), null)
})

test("command output: title, value and subtitle per line; blanks and duplicates skipped", () => {
  const items = Scopes.parseOutput("web\tweb\tdeploy@10.0.0.4\n\nweb\tweb\tagain\ndb\r\n\tnovalue\nlabel\tvalue\n")
  assert.deepEqual(items, [
    { title: "web", value: "web", subtitle: "deploy@10.0.0.4" },
    { title: "db", value: "db", subtitle: "" },
    { title: "label", value: "value", subtitle: "" }
  ])
})

test("commands fill {value} and {plugin} inside one argument each; values are checked", () => {
  const ssh = Scopes.merge(Scopes.BUILTINS, []).scopes[0]
  assert.deepEqual(Scopes.fill(ssh.open, "web; rm -rf ~", "/p"), ["omarchy-launch-tui", "--app-id=TUI.tile", "/p/bin/foamy-ssh-connect", "web; rm -rf ~"])
  assert.equal(Scopes.fillText("ssh {value}", "web"), "ssh web")
  assert.ok(Scopes.valueAllowed(ssh, "user@host.example:22"))
  assert.ok(!Scopes.valueAllowed(ssh, "-oProxyCommand=x"))
  assert.ok(!Scopes.valueAllowed(ssh, "web; rm"))
  assert.ok(!Scopes.valueAllowed(ssh, ""))
})

test("inside a scope: recent items first, then all of them; a query ranks", () => {
  const ssh = Scopes.merge(Scopes.BUILTINS, []).scopes[0]
  const items = ["alpha", "bravo", "charlie"].map((h) => Scopes.itemCandidate(ssh, { title: h, value: h, subtitle: "" }))
  const plain = RS.scopeSections(items, "", ctx(), deps, "Hosts")
  assert.deepEqual(plain.map((s) => [s.id, s.title]), [["items", ""]], "no header without recents")
  const visits = { [Scopes.itemId("ssh", "charlie")]: Frecency.recordVisit(null, NOW, "") }
  const withRecent = RS.scopeSections(items, "", ctx({ frecency: visits }), deps, "Hosts")
  assert.deepEqual(withRecent.map((s) => [s.title, s.rows.map((r) => r.candidate.title)]), [["Recent", ["charlie"]], ["Hosts", ["alpha", "bravo"]]])
  assert.deepEqual(RS.scopeSections(items, "brav", ctx(), deps, "Hosts")[0].rows.map((r) => r.candidate.title), ["bravo"])
})

test("scope rows and items: actions, and items stay out of root search", () => {
  const ssh = Scopes.merge(Scopes.BUILTINS, []).scopes[0]
  const row = Scopes.scopeCandidate(ssh)
  assert.equal(row.id, "scope:ssh")
  assert.equal(RS.actionsFor(row)[0].title, "Open Scope")
  const item = RS.decorate(Scopes.itemCandidate(ssh, { title: "web", value: "web", subtitle: "" }), ctx(), deps)
  assert.deepEqual(RS.actionsFor(item).map((a) => [a.id, a.title]), [
    ["open", "Connect"], ["scope-action:0", "Copy SSH Command"], ["scope-action:1", "Copy Host Name"], ["scope-action:2", "Open in Files (SFTP)"]
  ])
  const root = RS.rootSections([row], "web", ctx(), deps)
  assert.ok(!root.some((s) => s.rows.some((r) => r.candidate.kind === "scope-item")))
  assert.equal(RS.rootSections([row], "ssh", ctx(), deps)[0].rows[0].candidate.id, "scope:ssh")
})

test("a translated scope stays searchable by its keyword and English title", () => {
  const ssh = Scopes.merge(Scopes.BUILTINS, []).scopes[0]
  const row = Scopes.scopeCandidate(Object.assign({}, ssh, { title: "Hosts" }), (s) => (s === "Hosts" ? "Verter" : s))
  assert.equal(row.title, "Verter")
  assert.deepEqual(row.keywords, ["ssh", "Hosts"])
})

test("Omarchy's menu catalog translates stock labels and keeps English searchable", () => {
  const items = OmarchyMenu.parse('{"apps":{"label":"Apps","aliases":["app"]},"about":{"label":"About"}}').items
  const translated = OmarchyMenu.applyCatalog(items, { apps: { label: "Apper" }, about: { title: "x" } })
  assert.equal(translated[0].label, "Apper")
  assert.deepEqual(translated[0].aliases, ["app", "Apps"])
  assert.equal(translated[1].label, "About")
  assert.equal(translated[1].title, "x")
  assert.equal(OmarchyMenu.applyCatalog(items, null)[0].label, "Apps")
  assert.deepEqual(OmarchyMenu.parseCatalog("{"), {})
})

const queryScope = (overrides) => Scopes.merge(Scopes.BUILTINS, overrides ? [file("google.json", Object.assign({ id: "google" }, overrides))] : []).scopes.find((s) => s.id === "google")
const qctx = (extra) => Object.assign(ctx(extra), { t: undefined })

test("web search: Google and DuckDuckGo are query scopes; history and suggestions are opt-in", () => {
  const google = queryScope()
  assert.ok(Scopes.isQuery(google))
  assert.equal(google.keyword, "g")
  assert.equal(Scopes.merge(Scopes.BUILTINS, []).scopes.find((s) => s.id === "duckduckgo").keyword, "ddg")
  assert.equal(google.history, false)
  assert.equal(google.suggest, false)
  const on = queryScope({ history: true, suggest: true })
  assert.ok(on.history && on.suggest, "a user file turns both on")
  assert.match(Scopes.normalize({ id: "x", title: "X", source: { type: "query" }, open: ["a", "{query}"], suggest: true }).errors.join(), /suggestUrl/)
  assert.match(Scopes.normalize({ id: "x", title: "X", source: { type: "query" }, open: ["a"], history: "yes" }).errors.join(), /history must be/)
  assert.equal(Scopes.normalize({ id: "x", title: "X", source: { type: "list", items: [] }, open: ["a"], history: true }).scope.history, false, "only query scopes keep history")
  assert.equal(Scopes.matchKeyword(Scopes.merge(Scopes.BUILTINS, []).scopes, "g rust async").rest, "rust async")
})

test("inside a query scope: the typed text leads; nothing else unless turned on", () => {
  const google = queryScope()
  const visits = { [Scopes.itemId("google", "rust async trait")]: Frecency.recordVisit(null, NOW, "") }
  const plain = RS.querySections(google, "rust async", Scopes.historyCandidates(google, visits), ["rust async await"], qctx({ frecency: visits }), deps)
  assert.deepEqual(plain.map((s) => s.id), ["query"])
  assert.equal(plain[0].rows[0].candidate.title, "Search Google for “rust async”")
  assert.equal(RS.querySections(google, "", [], [], qctx(), deps)[0].rows[0].candidate.title, "Open Google", "Enter on an empty search opens the home page")
})

test("saved searches and suggestions, when on: ranked, without repeating the typed text", () => {
  const google = queryScope({ history: true, suggest: true })
  const visits = {}
  for (const q of ["rust async trait", "rust async", "pasta"]) visits[Scopes.itemId("google", q)] = Frecency.recordVisit(null, NOW, "")
  const saved = Scopes.historyCandidates(google, visits)
  assert.ok(saved.every((c) => c.saved && c.kind === "scope-item"))
  const sections = RS.querySections(google, "rust async", saved, ["rust async", "rust async trait", "rust async await"], qctx({ frecency: visits }), deps)
  assert.deepEqual(sections.map((s) => [s.title, s.rows.map((r) => r.candidate.value)]), [
    ["", ["rust async"]],
    ["Recent Searches", ["rust async trait"]],
    ["Suggestions", ["rust async await"]]
  ])
  const empty = RS.querySections(google, "", saved, [], qctx({ frecency: visits }), deps)
  assert.equal(empty[1].rows.length, 3, "an empty search lists recent searches")
  assert.deepEqual(RS.actionsFor(sections[1].rows[0].candidate).map((a) => a.id), ["open", "scope-action:0", "delete-history", "clear-history"])
  assert.ok(RS.confirmationFor("scope-item:google:x", "clear-history").destructive)
})

test("saved searches are capped per scope, least recent first", () => {
  const visits = {}
  for (let i = 0; i < 5; i++) visits[Scopes.itemId("google", "q" + i)] = { anchor: 1, openedAt: 100 + i }
  visits[Scopes.itemId("ssh", "web")] = { anchor: 1, openedAt: 1 }
  assert.deepEqual(Scopes.historyOverflow("google", visits, 3), [Scopes.itemId("google", "q0"), Scopes.itemId("google", "q1")])
  assert.deepEqual(Scopes.historyOverflow("google", visits), [])
})

test("suggestion replies: OpenSearch lists and DuckDuckGo phrases, bounded", () => {
  assert.deepEqual(Scopes.parseSuggestions('["rust",["rust async","rust book","rust async"]]'), ["rust async", "rust book"])
  assert.deepEqual(Scopes.parseSuggestions('[{"phrase":"a\\nb"},{"phrase":""},{"x":1}]'), ["a b"])
  assert.deepEqual(Scopes.parseSuggestions("<html>"), [])
  assert.equal(Scopes.parseSuggestions(JSON.stringify(["q", Array.from({ length: 20 }, (_, i) => "s" + i)])).length, 8)
  assert.equal(Scopes.fillText(queryScope().suggestUrl, "a&b"), "https://suggestqueries.google.com/complete/search?client=firefox&q=a%26b")
})

test("rootSection: off by default; on, it implies rootSearch", () => {
  const base = { id: "notes", title: "Notes", source: { type: "list", items: ["a"] }, open: ["true"] }
  const plain = Scopes.normalize(base).scope
  assert.deepEqual([plain.rootSection, plain.rootSectionTitle, plain.rootSearch], [false, "", false])
  const on = Scopes.normalize(Object.assign({}, base, { rootSection: true })).scope
  assert.deepEqual([on.rootSection, on.rootSectionTitle, on.rootSearch], [true, "", true])
  const off = Scopes.normalize(Object.assign({}, base, { rootSection: true, rootSearch: false })).scope
  assert.equal(off.rootSearch, true, "rootSection wins over rootSearch: false")
  assert.equal(Scopes.loadsEarly(on), true, "its items load without entering the scope")
  assert.equal(Scopes.normalize(Object.assign({}, base, { rootSection: true, rootSectionTitle: "My Notes" })).scope.rootSectionTitle, "My Notes")
})

test("rootSection: wrong types, an over-long title and query scopes are rejected", () => {
  const base = { id: "notes", title: "Notes", source: { type: "list", items: ["a"] }, open: ["true"] }
  assert.deepEqual(Scopes.normalize(Object.assign({}, base, { rootSection: "yes" })).errors, ["rootSection must be true or false"])
  assert.deepEqual(Scopes.normalize(Object.assign({}, base, { rootSectionTitle: 5 })).errors, ["rootSectionTitle must be a string"])
  assert.deepEqual(Scopes.normalize(Object.assign({}, base, { rootSectionTitle: "x".repeat(513) })).errors, ["rootSectionTitle is longer than 512 characters"])
  const query = { id: "q", title: "Q", source: { type: "query" }, open: ["true"], rootSection: true }
  assert.deepEqual(Scopes.normalize(query).errors, ["a query scope has no items for rootSection"])
  const merged = Scopes.merge(Scopes.BUILTINS, [file("google.json", { id: "google", rootSection: true })])
  assert.ok(!merged.scopes.some((s) => s.id === "google"), "the invalid override drops the scope")
  assert.deepEqual(merged.errors.map((e) => [e.id, e.file]), [["google", "google.json"]])
})

test("rootSection: a scope file turns it on for a built-in, over the steamGames setting", () => {
  const Settings = require("../core/Settings.js")
  const builtins = Settings.applyToScopes(Scopes.BUILTINS, { sshScope: true, steamGames: false, webSearchHistory: false, webSearchSuggestions: false })
  const steam = (files) => Scopes.merge(builtins, files).scopes.find((s) => s.id === "steam")
  assert.deepEqual([steam([]).rootSection, steam([]).rootSearch], [false, false])
  const on = steam([file("steam.json", { id: "steam", rootSection: true, rootSectionTitle: "Steam" })])
  assert.deepEqual([on.rootSection, on.rootSearch, on.rootSectionTitle], [true, true, "Steam"])
  assert.equal(steam([file("steam.json", { id: "steam", rootSection: true })]).rootSectionTitle, "", "no heading unless set")
})

