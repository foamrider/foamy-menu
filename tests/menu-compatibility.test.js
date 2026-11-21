const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const vm = require("node:vm")
const { execFileSync } = require("node:child_process")
const OmarchyMenu = require("../core/OmarchyMenu.js")
const RootSearch = require("../core/RootSearch.js")
const Ranker = require("../core/Ranker.js")
const Frecency = require("../core/Frecency.js")

const deps = { OmarchyMenu, Ranker, Frecency }
const backendSource = fs.readFileSync(path.join(__dirname, "../Backend.qml"), "utf8")

function backendFunction(name, params, context) {
  const signature = "function " + name + "(" + params + ")"
  const start = backendSource.indexOf(signature)
  assert.ok(start >= 0, signature)
  const end = backendSource.indexOf("\n  }", start) + 4
  return vm.runInContext("(" + backendSource.slice(start, end) + ")", context)
}

function harness(tree) {
  const summons = []
  const visits = []
  const candidates = RootSearch.menuCandidates(tree, {}, {}, deps)
  const backend = {
    decorated: id => candidates.find(c => c.id === id),
    recordVisit: (id, query) => visits.push({ id, query }),
    summonPlugin: (id, payload) => summons.push({ id, payload: JSON.parse(payload) })
  }
  const context = vm.createContext({ backend, menuSource: { tree }, OmarchyMenu })
  backend.openMenu = backendFunction("openMenu", "item", context)
  const perform = backendFunction("performAction", "data", context)
  return { summons, visits, open: id => JSON.parse(JSON.stringify(perform({ id }))) }
}

// The selected rows of the supported Omarchy release.
{
  const version = "4.5.0"
  const appearance = "appearance"
  const parsed = OmarchyMenu.parse(fs.readFileSync(path.join(__dirname, "fixtures/omarchy-menu-v" + version + ".jsonc"), "utf8"))
  const tree = OmarchyMenu.buildTree(parsed.items, [])

  test("Omarchy v" + version + " menu keeps navigation and populates its supported providers", () => {
    assert.equal(parsed.error, "")
    for (const id of ["apps", "system", appearance, "setup", "install", "remove", "update"]) {
      assert.ok(tree.children.root.includes(id), id)
    }
    const providers = {}
    for (const item of parsed.items.filter(i => OmarchyMenu.PROVIDERS[i.provider])) {
      providers[item.id] = OmarchyMenu.providerItems(item.id, item.provider, "First\tfirst\tfirst\nSecond\tsecond\tfirst\n")
    }
    assert.ok(providers[appearance + ".font"])
    assert.ok(providers["update.kernel"])
    const candidates = RootSearch.menuCandidates(tree, {}, providers, deps)
    for (const [id, rows] of Object.entries(providers)) {
      const sections = RootSearch.submenuSections(candidates, id, "", { commands: {}, frecency: {}, nowMs: Date.now() }, deps)
      assert.deepEqual(sections.flatMap(s => s.rows.map(r => r.candidate.id)), rows.map(r => "omarchy:" + r.id))
      assert.equal(candidates.find(c => c.id === "omarchy:" + rows[0].id).checked, true)
      assert.equal(candidates.find(c => c.id === "omarchy:" + rows[1].id).checked, false)
    }
    assert.ok(candidates.some(c => c.title.startsWith("Nightlight")))
  })

  test("Omarchy v" + version + " unsupported submenus open in the stock menu, including links", () => {
    const unsupported = parsed.items.filter(i => i.kind === "menu" && i.provider && !OmarchyMenu.PROVIDERS[i.provider])
    assert.deepEqual(unsupported.map(i => i.id), ["setup.language"], "the fixture's provider the launcher does not list")
    for (const item of unsupported) {
      const linked = OmarchyMenu.buildTree(parsed.items, OmarchyMenu.parse(JSON.stringify({ shortcut: { label: "Shortcut", target: item.id } })).items)
      for (const id of ["omarchy:" + item.id, "omarchy:shortcut"]) {
        const h = harness(linked)
        assert.deepEqual(h.open(id), { close: true })
        assert.deepEqual(h.summons, [{ id: "omarchy.menu", payload: { menu: item.id } }])
        assert.equal(h.visits[0].id, id)
      }
    }
    const h = harness(tree)
    assert.deepEqual(h.open("omarchy:" + appearance), { push: { kind: "menu", menuId: appearance, title: tree.items[appearance].label } })
    assert.deepEqual(h.open("omarchy:" + appearance + ".font"), { push: { kind: "menu", menuId: appearance + ".font", title: tree.items[appearance + ".font"].label } })
    assert.deepEqual(h.summons, [])
  })
}

test("kernel rows obey the menu visibility guard and remain searchable when visible", () => {
  const parsed = OmarchyMenu.parse(fs.readFileSync(path.join(__dirname, "fixtures/omarchy-menu-v4.5.0.jsonc"), "utf8"))
  const tree = OmarchyMenu.buildTree(parsed.items, [])
  assert.ok(tree.items["update.kernel"].when)
  const providers = { "update.kernel": OmarchyMenu.providerItems("update.kernel", "kernels", "linux-lts\tlinux-lts\tlinux-lts\n") }
  const visible = RootSearch.menuCandidates(tree, { when: { "update.kernel": true } }, providers, deps)
  assert.ok(visible.some(c => c.id === "omarchy:update.kernel.linux-lts" && c.checked))
  const hidden = RootSearch.menuCandidates(tree, { when: { "update.kernel": false } }, providers, deps)
  assert.ok(!hidden.some(c => c.menuId.startsWith("update.kernel")))
})

// Each provider's script runs in bash against fake host commands: list
// prints two values (one with a space), current names one of them, and set
// prints all its arguments NUL-separated so the test sees each one exactly.
// A command's second word must be its first argument.
const providerCommands = {
  kernels: { current: ["omarchy-kernel", "get"], list: ["omarchy-kernel", "list"], set: ["omarchy-kernel", "set"] },
  fonts: { current: ["omarchy-font-current"], list: ["omarchy-font-list"], set: ["omarchy-font-set"] },
  "power-profiles": { current: ["powerprofilesctl", "get"], list: ["omarchy-powerprofiles-list"], set: ["omarchy-powerprofiles-set", "autodetect"] }
}

function fakeCommands(dir, commands) {
  const scripts = {}
  const add = (argv, body) => {
    const [name, sub] = argv
    scripts[name] = scripts[name] || []
    scripts[name].push(sub ? '[[ $1 == "' + sub + '" ]] && { ' + body + '; exit; }' : body + "; exit")
  }
  add(commands.current, "echo 'beta two'")
  add(commands.list, "printf 'alpha\\nbeta two\\n'")
  add(commands.set, "printf '%s\\0' \"$@\"")
  for (const [name, lines] of Object.entries(scripts))
    fs.writeFileSync(path.join(dir, name), "#!/bin/bash\n" + lines.join("\n") + "\nexit 1\n", { mode: 0o755 })
}

test("every provider lists its values with the current one, and set receives the selected value literally", t => {
  assert.deepEqual(Object.keys(OmarchyMenu.PROVIDERS).sort(), Object.keys(providerCommands).sort(), "a fake for each provider")
  for (const [provider, commands] of Object.entries(providerCommands)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foamy-menu-provider-"))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    fakeCommands(dir, commands)
    const env = { ...process.env, PATH: dir + ":" + process.env.PATH }
    const output = execFileSync("bash", ["-c", OmarchyMenu.PROVIDERS[provider].script], { env, encoding: "utf8" })
    const rows = OmarchyMenu.providerItems("menu", provider, output)
    const set = commands.set.join(" ")
    assert.deepEqual(rows.map(r => [r.label, r.isCurrent, r.action]),
      [["alpha", false, set + " 'alpha'"], ["beta two", true, set + " 'beta two'"]], provider)
    const value = "it's $(touch " + path.join(dir, "injected") + ") `id`"
    const action = OmarchyMenu.PROVIDERS[provider].actionFor(value)
    const received = [...commands.set.slice(1), value].join("\0") + "\0"
    assert.equal(execFileSync("bash", ["-c", action], { env, encoding: "utf8" }), received, provider + ": one literal argument")
    assert.equal(fs.existsSync(path.join(dir, "injected")), false, provider + ": the value ran as a command")
    assert.deepEqual(OmarchyMenu.providerItems("menu", provider, ""), [], provider + ": no output, no rows")
  }
})
