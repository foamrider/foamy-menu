const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const Settings = require("../core/Settings.js")
const Scopes = require("../core/Scopes.js")
const Prefs = require("../kit/node-loader.cjs").load("FoamyPrefs")
const manifest = require("../manifest.json")

const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8")

test("manifest barWidget.schema and defaults mirror core/Settings.js", () => {
  const schema = manifest.barWidget.schema
  assert.deepEqual(schema.map((f) => f.key), Settings.fields.map((f) => f.key))
  for (const f of Settings.fields) {
    const s = schema.find((x) => x.key === f.key)
    for (const k of ["type", "label", "options", "defaultValue", "min", "max", "step"]) assert.deepEqual(s[k], f[k], f.key + "." + k)
    assert.deepEqual(manifest.barWidget.defaults[f.key], f.defaultValue, "default " + f.key)
  }
  assert.deepEqual(Object.keys(manifest.barWidget.defaults), Settings.fields.map((f) => f.key))
})

test("settings come from the shell.json entry; missing or invalid values use the default", () => {
  const defaults = Settings.resolve(Prefs, null)
  assert.equal(defaults.webSearchHistory, false)
  assert.equal(defaults.webSearchSuggestions, false)
  assert.equal(defaults.sshScope, true)
  assert.equal(defaults.currencyRates, true)
  const s = Settings.resolve(Prefs, { id: "foamy.menu", webSearchHistory: true, windowMode: "tiny", remToPxRate: 10, workHoursPerDay: 0, clockFormat: "24h", popToRootTimeout: 1.5 })
  assert.equal(s.webSearchHistory, true)
  assert.equal(s.windowMode, "expanded", "an unknown choice falls back")
  assert.equal(s.remToPxRate, 10)
  assert.equal(s.workHoursPerDay, 8, "out of range falls back")
  assert.equal(s.clockFormat, "24h")
  assert.equal(s.popToRootTimeout, 90, "a fraction is not an integer")
})

test("the SSH and web-search settings reach the built-in scopes; scope files still override", () => {
  const off = Settings.applyToScopes(Scopes.BUILTINS, Settings.resolve(Prefs, { sshScope: false, webSearchHistory: true, webSearchSuggestions: true }))
  const merged = Scopes.merge(off, []).scopes
  assert.deepEqual(merged.map((s) => s.id), ["google", "duckduckgo"])
  assert.ok(merged.every((s) => s.history && s.suggest))
  const fileWins = Scopes.merge(off, [{ name: "google.json", definition: { id: "google", suggest: false } }]).scopes
  assert.equal(fileWins.find((s) => s.id === "google").suggest, false)
  assert.notEqual(Scopes.BUILTINS[0].enabled, false, "the built-in definitions are not changed")
  const disabled = Scopes.merge(Scopes.BUILTINS, [{ name: "google.json", definition: { id: "google", enabled: false } }])
  assert.deepEqual(disabled.queryIds, ["google", "duckduckgo"], "Clear Saved Web Searches finds disabled engines too")
  assert.ok(!disabled.scopes.some((s) => s.id === "google"))
})

test("every setting is read by the launcher", () => {
  const source = ["Backend.qml", "StockMenu.qml", "ui/LauncherWindow.qml", "core/Settings.js"].map(read).join("\n")
  for (const f of Settings.fields) {
    const used = new RegExp("settings\\." + f.key + "\\b|configuredEntry\\." + f.key + "\\b|entry\\." + f.key + "\\b|general\\." + f.key + "\\b").test(source)
    assert.ok(used, "unused setting " + f.key)
  }
  assert.ok(!fs.existsSync(path.join(__dirname, "../core/Config.js")))
  assert.doesNotMatch(read("Backend.qml"), /config\.json/, "no separate config file")
})

const RS = require("../core/RootSearch.js")
const deps = { Ranker: require("../core/Ranker.js"), Frecency: require("../core/Frecency.js"), OmarchyMenu: require("../core/OmarchyMenu.js"), Scopes, Settings }
const ctx = { commands: {}, frecency: {}, nowMs: 0, sensitivity: "medium" }

test("the settings view: sections in order, values where types go, log level left to shell.json", () => {
  const values = Settings.resolve(Prefs, { popToRootTimeout: 30, webSearchHistory: true })
  const sections = RS.settingsSections(values, "", ctx, deps)
  assert.deepEqual(sections.map((s) => s.title), ["Window", "Scopes", "Calculator", "Bar Button", "More"])
  const rows = sections.flatMap((s) => s.rows.map((r) => r.candidate))
  assert.ok(!rows.some((c) => c.settingKey === "logLevel"))
  const keep = rows.find((c) => c.settingKey === "popToRootTimeout")
  assert.deepEqual([keep.typeLabel, keep.typeLabelValues, keep.isDefault], ["%1 s", [30], false])
  assert.equal(rows.find((c) => c.settingKey === "webSearchHistory").typeLabel, "On")
  assert.equal(rows.find((c) => c.settingKey === "escapeKeyBehavior").typeLabel, "Go back")
  assert.deepEqual(sections.at(-1).rows.map((r) => r.candidate.id), ["settings-action:open-scopes", "settings-action:clear-searches"])
  assert.equal(RS.settingsSections(values, "suggest", ctx, deps)[0].rows[0].candidate.settingKey, "webSearchSuggestions")
  assert.ok(RS.BUILTINS.some((b) => b.id === "builtin:settings" && b.run.push.kind === "settings"))
})

test("setting actions: Enter toggles, cycles or edits; ←/→ step; reset only when changed", () => {
  const row = (key, value) => RS.settingCandidate(Settings.field(key), value, null, deps)
  assert.deepEqual(RS.actionsFor(row("sshScope", true)).map((a) => a.id), ["open", "setting-next", "copy-setting-command"])
  assert.deepEqual(RS.actionsFor(row("clockFormat", "24h")).map((a) => [a.id, a.title]),
    [["open", "Next Option"], ["setting-previous", "Previous Option"], ["setting-next", "Next Option"], ["copy-setting-command", "Copy Setting Command"], ["reset-setting", "Reset to Default"]])
  assert.equal(RS.actionsFor(row("width", 360))[0].title, "Edit")
  assert.ok(RS.confirmationFor("settings-action:clear-searches", "open").destructive)
})

test("stepping, parsing and showing values", () => {
  const f = Settings.field
  assert.equal(Settings.stepped(f("clockFormat"), "24h", 1), "auto", "choices wrap")
  assert.equal(Settings.stepped(f("clockFormat"), "auto", -1), "24h")
  assert.equal(Settings.stepped(f("popToRootTimeout"), 5, -1), 0, "numbers stop at min")
  assert.equal(Settings.stepped(f("width"), 4090, 1), 4096, "and at max")
  assert.equal(Settings.stepped(f("sshScope"), true, 1), false)
  assert.equal(Settings.stepped(f("icon"), "x", 1), null, "text has no steps")
  assert.equal(Settings.parse(f("remToPxRate"), " 12,5 "), 12.5, "a decimal comma works")
  assert.equal(Settings.parse(f("width"), ""), 360, "empty is the default")
  assert.equal(Settings.parse(f("width"), "wide"), undefined)
  assert.ok(!Prefs.valid(Settings.fields, "width", Settings.parse(f("width"), "12.5")), "integers reject fractions")
  assert.deepEqual(Settings.display(f("width"), 0), ["Default", []])
  assert.deepEqual(Settings.display(f("popToRootTimeout"), 0), ["Never", []])
  assert.deepEqual(Settings.display(f("iconFont"), ""), ["Bar font", []])
  assert.deepEqual(Settings.hint(f("workHoursPerDay")), ["A number from %1 to %2. Empty uses the default.", [1, 24]])
})
