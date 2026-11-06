const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const root = path.join(__dirname, "..")
const en = require("../i18n/en.json")
const no = require("../i18n/no.json")
const read = (name) => fs.readFileSync(path.join(root, name), "utf8")
const tokens = (s) => [...String(s).matchAll(/%[1-9][0-9]*|\{\w+\}/g)].map((m) => m[0]).sort()

// The kit's own substitution, run on catalog text.
const kit = read("kit/FoamyI18n.qml")
const scope = vm.createContext({})
vm.runInContext(kit.slice(kit.indexOf("  function substitute("), kit.indexOf("\n  function t(", kit.indexOf("  function substitute("))), scope)
scope.root = { number: (value) => String(value) }
const t = (catalog, key, values) => scope.substitute(Object.hasOwn(catalog, key) ? catalog[key] : key, values)

test("English is keyed by itself; Norwegian has every key with the same holes", () => {
  for (const [key, value] of Object.entries(en)) assert.equal(value, key)
  assert.deepEqual(Object.keys(no).sort(), Object.keys(en).sort())
  for (const key of Object.keys(en)) assert.deepEqual(tokens(no[key]), tokens(key), key)
  assert.equal(t(no, "Use “%1” with…", ["ssh"]), "Bruk «ssh» med…")
  assert.equal(t(no, "Search %1…", ["$& %2"]), "Søk i $& %2…", "values stay literal")
})

// Strings the code translates: t()/tr() calls, and English data the UI
// translates when it shows it (section, action, type and About labels).
function usedKeys() {
  const keys = new Set()
  const qml = ["Backend.qml", "ui/LauncherWindow.qml", "ui/ActionPanel.qml", "ui/Alert.qml"].map(read).join("\n")
  for (const [, key] of qml.matchAll(/(?:FoamyI18n\.t|window\.t|backend\.tr)\("((?:[^"\\]|\\.)*)"/g)) keys.add(key)
  for (const [, key] of qml.matchAll(/showToast\("\w+", (?:saved \? )?"([^"]+)"(?: : "([^"]+)")?/g)) keys.add(key)
  for (const [, a, b] of qml.matchAll(/saved \? "([^"]+)" : "([^"]+)"/g)) { keys.add(a); keys.add(b) }
  for (const [, key] of qml.matchAll(/title: "(Copy Error Message|Save Alias)"/g)) keys.add(key)
  const titles = qml.match(/var titles = (\{[^}]*\})/)
  for (const [, key] of titles[1].matchAll(/: "([^"]+)"/g)) keys.add(key)
  const js = read("core/RootSearch.js")
  for (const pattern of [/title: "([^"]+)"/g, /subtitle: "([^"]+)"/g, /typeLabel: "([^"]+)"/g, /message: "([^"]+)"/g, /primary: "([^"]+)"/g, /add\("([^"]+)"/g, /return \["([^"]+)"/g, /\? \["([^"]+)"/g, /: \["([^"]+)"/g, /"(Change Alias|Set Alias|Command|Menu)"/g])
    for (const [, key] of js.matchAll(pattern)) keys.add(key)
  const scopes = read("core/Scopes.js")
  const builtins = scopes.slice(scopes.indexOf("var BUILTINS"), scopes.indexOf("function isPlainObject"))
  for (const [, key] of builtins.matchAll(/(?:title|subtitle|itemsTitle|placeholder|emptyText|openTitle): "([^"]+)"/g)) keys.add(key)
  for (const [, key] of scopes.matchAll(/\|\| "([A-Z][a-z]+)"/g)) keys.add(key)
  const calc = read("core/Calculator.js")
  // Calculator: context templates ([ "…", [values] ]), base names, and the
  // long unit names it passes through ENV.translate.
  for (const [, key] of calc.matchAll(/\["([^"]+)", \[/g)) keys.add(key)
  for (const [, key] of calc.match(/16: "Hexadecimal"[^}]*\}/)[0].matchAll(/: "([^"]+)"/g)) keys.add(key)
  for (const [, names] of calc.matchAll(/def\(\[[^\]]*\], \[("[^\]]+)\], [^\n]*long: true/g))
    for (const [, name] of names.matchAll(/"([^"]+)"/g)) keys.add(name)
  for (const key of ["Today", "Tomorrow", "Yesterday", "Query", "Scope", "Recent", "Items", "Open"]) keys.add(key)
  // The settings view: titles, sections, choices and how values read.
  const Settings = require("../core/Settings.js")
  for (const s of Settings.SECTIONS) keys.add(s)
  for (const f of Settings.fields.filter((x) => !x.hidden)) {
    keys.add(f.title)
    if (f.emptyTitle) keys.add(f.emptyTitle)
    for (const title of Object.values(f.optionTitles || {})) keys.add(title)
    for (const value of [f.defaultValue, f.min, f.max, f.type === "boolean" ? !f.defaultValue : undefined, 0]) {
      if (value === undefined || (value === 0 && f.type === "string")) continue
      keys.add(Settings.display(f, value)[0])
    }
    keys.add(Settings.hint(f)[0])
  }
  keys.add("That value isn't allowed.")
  keys.add("Couldn't save the setting.")
  return keys
}

test("every string the launcher translates has a catalog entry", () => {
  // Identifiers (lowercase) are not UI text.
  const units = new Set(["second", "seconds", "minute", "minutes", "hour", "hours", "day", "days", "week", "weeks", "month", "months",
    "year", "years", "decade", "decades", "century", "centuries", "work day", "work days", "work week", "work weeks", "ton", "tons", "pint", "pints", "cup", "cups"])
  const missing = [...usedKeys()].filter((key) => (/^[A-Z%“]/.test(key) || units.has(key)) && !Object.hasOwn(en, key) && key !== "Foamy Menu")
  assert.deepEqual(missing, [])
})
