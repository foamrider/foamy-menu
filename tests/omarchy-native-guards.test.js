const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const vm = require("node:vm")
const { spawnSync } = require("node:child_process")
const { fileURLToPath, pathToFileURL } = require("node:url")
const OmarchyMenu = require("../core/OmarchyMenu.js")
const { isolatedQs } = require("./qs-sandbox.js")

const sourcePath = path.join(__dirname, "../services/OmarchyMenuSource.qml")
const text = fs.readFileSync(sourcePath, "utf8")
// Guard maps have no prototype; compare their entries.
const guardValues = (g) => ({ when: { ...g.when }, checked: { ...g.checked }, disabled: { ...g.disabled } })
const methods = ["createGuardCompiler", "guardItems", "compileGuards", "guardKeys", "finishGuards", "bounded", "refresh"]

// QML block sample: "  function refresh() {\n  }". With `from`, the first
// block after that text.
function block(signature, indentation, from) {
  if (from) assert.ok(text.indexOf(from) >= 0, from)
  const start = text.indexOf(signature, from ? text.indexOf(from) : 0)
  assert.ok(start >= 0, signature)
  const open = text.indexOf("{", start)
  const end = text.indexOf("\n" + " ".repeat(indentation) + "}", open) + indentation + 2
  assert.ok(end > open, signature)
  return text.slice(start, end)
}

function method(name) {
  return block("function " + name + "(", 2)
}

// A one-statement handler's body (qmlformat puts an if's statement on the
// next line): from "name: " (after `from`) to the next line indented no
// deeper than the handler.
function handler(name, from) {
  if (from) assert.ok(text.indexOf(from) >= 0, from)
  const start = text.indexOf(name + ": ", from ? text.indexOf(from) : 0)
  assert.ok(start >= 0, name)
  const indent = start - (text.lastIndexOf("\n", start) + 1)
  const lines = text.slice(start + name.length + 2).split("\n")
  const body = [lines[0]]
  for (const line of lines.slice(1)) {
    if (line.length - line.trimStart().length <= indent) break
    body.push(line)
  }
  return body.join("\n")
}

function sampleTree() {
  return OmarchyMenu.buildTree(OmarchyMenu.parse(JSON.stringify({
    probe: { when: "true", checked: "false", disabled: "custom-check --literal '*'" },
    other: { when: "false" }
  })).items, [])
}

function harness(factory = () => ({ compile: () => "stock-script", destroy() {} })) {
  const imports = []
  const messages = []
  const source = {
    omarchyPath: '/opt/omarchy space "double" \'single\' #percent%', commandTimeout: "10s",
    guardCompiler: null, tree: sampleTree(), guards: { previous: true }, revision: 7,
    message: (...args) => messages.push(args), providerMenus: () => [], startNextProvider() {}
  }
  const guardProc = { running: false, collected: "", requestTree: null, expectedGuards: [] }
  const context = vm.createContext({
    source, guardProc, providerProc: { running: true }, OmarchyMenu,
    Qt: { createQmlObject: (...args) => { imports.push(args); return factory(...args) } }
  })
  for (const name of methods) {
    vm.runInContext(method(name), context)
    source[name] = context[name]
  }
  return {
    source, guardProc, imports, messages,
    start() {
      const onCompleted = block("Component.onCompleted: {", 2)
      vm.runInContext(onCompleted.slice(onCompleted.indexOf("{")), context)
    },
    exit(code, status = 0, output = "probe:w:1\nprobe:c:0\nprobe:d:1\nother:w:0\n") {
      guardProc.running = false
      guardProc.collected = output
      Object.assign(context, { exitCode: code, exitStatus: status })
      const handler = block("onExited: function (exitCode, exitStatus)", 4)
      vm.runInContext("(" + handler.slice(handler.indexOf("function")) + ")(exitCode, exitStatus)", context)
    },
    // Quickshell's running -> false: after exited(), or alone for a batch
    // that couldn't start.
    stopped() {
      guardProc.running = false
      vm.runInContext("(function(running) { " + handler("onRunningChanged", "id: guardProc") + " })(false)", context)
    },
    destroy() {
      vm.runInContext(handler("Component.onDestruction"), context)
    }
  }
}

test("startup can use the legacy fallback, then imports OEM once and compiles every refresh", () => {
  const calls = []
  const h = harness(() => ({ compile: items => { calls.push(items); return "stock-" + calls.length }, destroy() {} }))
  const { source, guardProc } = h
  assert.equal(source.compileGuards(source.tree, source.guardItems(source.tree)), OmarchyMenu.guardScript(source.tree))
  assert.equal(h.imports.length, 0)
  h.start()
  assert.equal(h.imports.length, 1)
  const [code, parent, name] = h.imports[0]
  const url = JSON.parse(code.match(/^import QtQml\nimport ("[^\n]+") as Stock\n/)[1])
  assert.equal(fileURLToPath(url), source.omarchyPath + "/shell/plugins/menu/MenuModel.js")
  assert.equal(parent, source)
  assert.equal(name, "OmarchyGuardCompiler")
  assert.deepEqual(Array.from(guardProc.command), ["timeout", "--signal=KILL", "10s", "bash", "-lc", "stock-1"])
  assert.equal(guardProc.requestTree, source.tree)
  assert.deepEqual(Array.from(guardProc.expectedGuards), ["probe:w", "probe:c", "probe:d", "other:w"])
  h.exit(0)
  source.tree = sampleTree()
  source.tree.items.probe.when = "fresh-custom-check"
  source.refresh()
  assert.equal(h.imports.length, 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].probe.when, "fresh-custom-check")
  assert.equal(guardProc.command[5], "stock-2")
})

test("OEM input preserves legacy ID filtering and uses own keys even for prototype names", () => {
  let received
  const h = harness(() => ({ compile: items => { received = items; return "stock" }, destroy() {} }))
  const items = Object.create({ inherited: { id: "inherited", when: "true" } })
  for (const [key, id] of [["probe", "probe"], ["alias", "actual.id"], ["constructor", "constructor"], ["__proto__", "__proto__"], ["hasOwnProperty", "hasOwnProperty"], ["bad", "bad'; echo injected"], ["newline", "bad\nline"], ["empty", ""]]) {
    Object.defineProperty(items, key, { value: { id, when: "true" }, enumerable: true })
  }
  h.source.tree = { items, order: [...Object.keys(items), "inherited", "toString"] }
  h.start()
  assert.equal(Object.getPrototypeOf(received), null)
  assert.deepEqual(Object.keys(received), ["probe", "actual.id", "constructor", "__proto__", "hasOwnProperty"])
  assert.equal(received.__proto__, items.__proto__)
  assert.equal(received.constructor, items.constructor)
  assert.equal(Object.getPrototypeOf(items).inherited.id, "inherited")
})

test("missing OEM import falls back without retrying each refresh", () => {
  const h = harness(() => { throw new Error("No MenuModel.js on this Omarchy") })
  h.start()
  assert.equal(h.source.guardCompiler, null)
  assert.equal(h.guardProc.command[5], OmarchyMenu.guardScript(h.source.tree))
  h.exit(0)
  h.source.refresh()
  assert.equal(h.imports.length, 1)
  assert.equal(h.guardProc.command[5], OmarchyMenu.guardScript(h.source.tree))
  h.destroy()
})

test("throwing or non-string OEM compilers are destroyed once and use unchanged fallback", () => {
  for (const result of [new Error("incompatible compiler"), undefined, null, 17, {}, new String("boxed")]) {
    let destroyed = 0
    let compiled = 0
    const h = harness(() => ({
      compile() { compiled++; if (result instanceof Error) throw result; return result },
      destroy() { destroyed++ }
    }))
    h.start()
    assert.equal(h.guardProc.command[5], OmarchyMenu.guardScript(h.source.tree))
    assert.equal(h.source.guardCompiler, null)
    h.exit(0)
    h.source.refresh()
    h.destroy()
    assert.equal(compiled, 1)
    assert.equal(destroyed, 1)
    assert.equal(h.imports.length, 1)
  }
})

test("only successful complete guard responses publish once", () => {
  const h = harness()
  h.start()
  h.exit(0)
  assert.deepEqual(guardValues(h.source.guards), { when: { probe: true, other: false }, checked: { probe: false }, disabled: { probe: true } })
  assert.equal(h.source.revision, 8)
  assert.deepEqual(h.messages, [])
  h.exit(0)
  assert.equal(h.source.revision, 8)
})

test("nonzero exit or abnormal termination retains previous guards and warns once", () => {
  for (const [code, status] of [[1, 0], [0, 1], [9, 1]]) {
    const h = harness()
    const previous = h.source.guards
    h.start()
    h.exit(code, status)
    assert.equal(h.source.guards, previous)
    assert.equal(h.source.revision, 7)
    assert.equal(h.messages.length, 1)
    assert.equal(h.messages[0][0], "warning")
    assert.match(h.messages[0][1], /refresh failed/)
  }
})

test("running -> false after exited() changes nothing; alone it fails the batch once", () => {
  const h = harness()
  h.start()
  h.exit(0)
  h.stopped()
  assert.equal(h.source.revision, 8)
  assert.deepEqual(h.messages, [])
  // A batch that can't start: no exited(), only running -> false.
  const previous = h.source.guards
  h.source.refresh()
  assert.equal(h.guardProc.running, true)
  h.stopped()
  assert.equal(h.source.guards, previous)
  assert.equal(h.guardProc.requestTree, null)
  assert.equal(h.messages.length, 1)
  assert.match(h.messages[0][1], /refresh failed/)
  h.stopped()
  assert.equal(h.messages.length, 1)
  // The next refresh runs a batch again.
  h.source.refresh()
  assert.equal(h.guardProc.running, true)
  assert.equal(h.guardProc.requestTree, h.source.tree)
})

test("a hung guard batch and its background groups end at the deadline", (t) => {
  // A killed orphan is a zombie until its new parent reaps it: that's gone.
  const running = pid => {
    try { return !/^\d+ \(.*\) Z /.test(fs.readFileSync("/proc/" + pid + "/stat", "utf8")) } catch (e) { return false }
  }
  // A group that ignores SIGTERM passes that on to its guard's sleep.
  for (const [name, prefix] of [["guards that end on SIGTERM", ""], ["guards that ignore SIGTERM", "trap '' TERM; "]]) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "foamy-menu-guard-hang-"))
    const pids = path.join(dir, "pids")
    const recorded = () => fs.existsSync(pids) ? fs.readFileSync(pids, "utf8").trim().split(/\s+/).filter(Boolean) : []
    // A failed run must not leave its 300 s sleeps behind: kill this run's
    // own bash and sleep processes that still run.
    t.after(() => {
      for (const pid of recorded().filter(running)) {
        try { if (/^\d+ \((bash|sleep)\) /.test(fs.readFileSync("/proc/" + pid + "/stat", "utf8"))) process.kill(Number(pid), "SIGKILL") } catch (e) {}
      }
      fs.rmSync(dir, { recursive: true, force: true })
    })
    const menu = {}
    // Twelve hung guards over the batch's eight background groups.
    for (let i = 0; i < 12; i++) menu["hung" + i] = { when: prefix + 'echo $BASHPID >> "$PIDS"; sleep 300 & echo $! >> "$PIDS"; wait' }
    const h = harness(() => { throw new Error("fallback script") })
    h.source.tree = OmarchyMenu.buildTree(OmarchyMenu.parse(JSON.stringify(menu)).items, [])
    // Long enough for bash -lc and all eight groups to start on a busy machine
    // (at 0.3 s some were killed before they recorded their pids).
    h.source.commandTimeout = "2s"
    h.start()
    const [cmd, ...args] = h.guardProc.command
    assert.deepEqual([cmd, ...args.slice(0, 4)], ["timeout", "--signal=KILL", "2s", "bash", "-lc"], name)
    // A group still running holds stdout open, so spawnSync would wait for
    // it until its own 15 s limit.
    const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 15000, env: { PATH: process.env.PATH, HOME: dir, PIDS: pids } })
    assert.ifError(result.error)
    // SIGKILL to the whole process group kills timeout itself too.
    assert.equal(result.signal, "SIGKILL", name)
    assert.equal(result.status, null, name)
    const listed = recorded()
    // Each group runs its guards in turn: its first one hangs (two pids each).
    assert.equal(listed.length, 16, name)
    let alive = listed.filter(running)
    for (let i = 0; i < 20 && alive.length; i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
      alive = alive.filter(running)
    }
    assert.deepEqual(alive, [], name)
    // Quickshell reports a process killed by a signal as a crash: the
    // previous results stay.
    const previous = h.source.guards
    h.exit(9, 1, result.stdout)
    assert.equal(h.source.guards, previous, name)
    assert.match(h.messages[0][1], /refresh failed/, name)
  }
})

test("exit zero with missing or malformed rows retains previous guards", () => {
  const rows = ["probe:w:1", "probe:c:0", "probe:d:1", "other:w:0"]
  for (let missing = 0; missing < rows.length; missing++) {
    const h = harness()
    const previous = h.source.guards
    h.start()
    h.exit(0, 0, [...rows.filter((row, i) => i !== missing), rows[(missing + 1) % rows.length], "probe:d:2", "bad id:w:1"].join("\n"))
    assert.equal(h.source.guards, previous)
    assert.equal(h.source.revision, 7)
    assert.equal(h.messages.length, 1)
    assert.match(h.messages[0][1], /incomplete/)
  }
  const empty = harness()
  const previous = empty.source.guards
  empty.start()
  empty.exit(0, 0, "")
  assert.equal(empty.source.guards, previous)
})

test("a response for an old tree is discarded and the current tree is refreshed", () => {
  const h = harness()
  const previous = h.source.guards
  h.start()
  const requested = h.guardProc.requestTree
  h.source.tree = OmarchyMenu.buildTree(OmarchyMenu.parse('{"latest":{"checked":"true"}}').items, [])
  h.source.refresh()
  assert.equal(h.guardProc.requestTree, requested)
  h.exit(0)
  assert.equal(h.source.guards, previous)
  assert.equal(h.source.revision, 7)
  assert.equal(h.guardProc.requestTree, h.source.tree)
  assert.deepEqual(Array.from(h.guardProc.expectedGuards), ["latest:c"])
  assert.equal(h.guardProc.running, true)
  h.exit(0, 0, "latest:c:1\n")
  assert.deepEqual(guardValues(h.source.guards), { when: {}, checked: { latest: true }, disabled: {} })
  assert.equal(h.source.revision, 8)
})

test("empty guard scripts do not launch a process", () => {
  const h = harness(() => ({ compile: () => "", destroy() {} }))
  h.source.tree = OmarchyMenu.buildTree([], [])
  h.start()
  assert.equal(h.guardProc.running, false)
  assert.equal(h.guardProc.requestTree, null)
})

// The provider lists (fonts, kernels) run one at a time in providerProc.
// Guards are left out: guardProc counts as busy, so refresh() starts none.
const providerMenu = {
  style: { label: "Style" },
  "style.font": { label: "Font", provider: "fonts" },
  update: { label: "Update" },
  "update.kernel": { label: "Kernel", provider: "kernels" },
  setup: { label: "Setup" },
  "setup.language": { label: "Language", provider: "languages" }
}
const providerTree = (menu, extension = {}) => OmarchyMenu.buildTree(OmarchyMenu.parse(JSON.stringify(menu)).items, OmarchyMenu.parse(JSON.stringify(extension)).items)

function providerHarness() {
  const source = {
    commandTimeout: "10s", revision: 3, providerQueue: [], pendingProviderItems: {},
    tree: providerTree(providerMenu),
    providerItems: { "style.font": [{ id: "style.font.old", label: "Old Font" }], "update.kernel": [{ id: "update.kernel.old", label: "old" }] }
  }
  const providerProc = { running: false, menuId: "", collected: "", command: [], starts: [] }
  const context = vm.createContext({ source, guardProc: { running: true }, providerProc, OmarchyMenu })
  for (const name of ["providerMenus", "requeueProviders", "startNextProvider", "finishProvider", "bounded", "refresh"]) {
    vm.runInContext(method(name), context)
    source[name] = context[name]
  }
  // Every start of a list, in order.
  Object.defineProperty(providerProc, "running", {
    get() { return this._running || false },
    set(value) { if (value && !this._running) this.starts.push(Array.from(this.command)); this._running = value }
  })
  const exited = block("onExited: function (exitCode, exitStatus)", 4, "id: providerProc")
  const runningChanged = handler("onRunningChanged", "id: providerProc")
  // The running change sees the value running has then: a list started from
  // exited() is running again.
  const changed = () => vm.runInContext("(function(running) { " + runningChanged + " })(providerProc.running)", context)
  return {
    source, providerProc, changed,
    // Quickshell: the list ends with exited(), then running -> false.
    end(code, status, output = "") {
      providerProc._running = false
      providerProc.collected = output
      vm.runInContext("(" + exited.slice(exited.indexOf("function")) + ")(" + code + ", " + status + ")", context)
      changed()
    },
    // A command that can't start gets only running -> false.
    lost() {
      providerProc._running = false
      changed()
    }
  }
}

const bash = (script) => ["timeout", "--signal=KILL", "10s", "bash", "-lc", script]

test("provider lists run one at a time under the deadline and publish together", () => {
  const h = providerHarness()
  const before = h.source.providerItems
  h.source.refresh()
  assert.deepEqual(h.providerProc.starts, [bash(OmarchyMenu.PROVIDERS.fonts.script)])
  // A refresh while a list runs starts no second one.
  h.source.refresh()
  assert.equal(h.providerProc.starts.length, 1)
  h.end(0, 0, "JetBrains Mono\tJetBrains Mono\tJetBrains Mono\nHack\tHack\tJetBrains Mono\n")
  assert.deepEqual(h.providerProc.starts.slice(1), [bash(OmarchyMenu.PROVIDERS.kernels.script)])
  assert.equal(h.source.providerItems, before, "nothing is published before the last list ends")
  assert.equal(h.source.revision, 3)
  h.source.refresh()
  h.end(0, 0, "linux\tlinux\tlinux-lts\nlinux-lts\tlinux-lts\tlinux-lts\n")
  assert.equal(h.providerProc.running, false, "a refresh during a list starts no list again")
  // The languages provider is not one the launcher runs.
  assert.equal(h.providerProc.starts.length, 2)
  assert.equal(h.source.revision, 4)
  const rows = h.source.providerItems
  assert.deepEqual(rows["style.font"].map((r) => [r.id, r.isCurrent]), [["style.font.jetbrains-mono", true], ["style.font.hack", false]])
  assert.deepEqual(rows["update.kernel"].map((r) => [r.label, r.action, r.isCurrent]), [
    ["linux", "omarchy-kernel set 'linux'", false], ["linux-lts", "omarchy-kernel set 'linux-lts'", true]
  ])
  assert.deepEqual(Object.keys(rows).sort(), ["style.font", "update.kernel"])
})

test("a list that fails, times out, crashes or cannot start keeps the previous list and the queue goes on", () => {
  for (const [name, fail] of [
    ["the deadline: timeout SIGKILLed with its group (crash, code 9)", (h) => h.end(9, 1, "Half Font\tHalf Font\t\n")],
    ["exit 124", (h) => h.end(124, 0, "Half Font\tHalf Font\t\n")],
    ["normal exit with code 1 and no output", (h) => h.end(1, 0, "")],
    // timeout reports a child that a signal ended as 128 + the signal.
    ["bash ended by SIGKILL (137)", (h) => h.end(137, 0, "Half Font\tHalf Font\t\n")],
    ["timeout could not run bash (127)", (h) => h.end(127, 0, "")],
    ["abnormal exit", (h) => h.end(0, 1, "Half Font\tHalf Font\t\n")],
    ["running -> false without exited()", (h) => h.lost()]
  ]) {
    const h = providerHarness()
    const previous = h.source.providerItems["style.font"]
    h.source.refresh()
    fail(h)
    assert.deepEqual(h.providerProc.starts.slice(1), [bash(OmarchyMenu.PROVIDERS.kernels.script)], name)
    h.end(0, 0, "linux\tlinux\tlinux\n")
    assert.equal(h.source.providerItems["style.font"], previous, name)
    assert.deepEqual(h.source.providerItems["update.kernel"].map((r) => r.label), ["linux"], name)
    assert.equal(h.source.revision, 4, name + ": one publish")
    assert.equal(h.providerProc.starts.length, 2, name)
  }
})

// Provider names come from the menu files, the user's extension file too.
// A name that only an object has as a member is no provider the launcher
// knows: no list runs for it.
test("a provider named like an object member runs no list", () => {
  const h = providerHarness()
  h.source.tree = providerTree(providerMenu, {
    "style.member": { label: "Member", provider: "constructor" },
    "style.text": { label: "Text", provider: "toString" },
    "style.proto": { label: "Proto", provider: "__proto__" }
  })
  h.source.refresh()
  h.end(0, 0, "Hack\tHack\tHack\n")
  h.end(0, 0, "linux\tlinux\tlinux\n")
  assert.deepEqual(h.providerProc.starts, [bash(OmarchyMenu.PROVIDERS.fonts.script), bash(OmarchyMenu.PROVIDERS.kernels.script)])
  assert.equal(h.providerProc.running, false, "the queue is done")
  assert.deepEqual(Object.keys(h.source.providerItems).sort(), ["style.font", "update.kernel"])
})

test("running -> false after the last exit changes nothing", () => {
  const h = providerHarness()
  h.source.refresh()
  h.end(0, 0, "Hack\tHack\tHack\n")
  h.end(0, 0, "linux\tlinux\tlinux\n")
  const published = h.source.providerItems
  h.changed()
  h.lost()
  assert.equal(h.source.providerItems, published)
  assert.equal(h.source.revision, 4)
  assert.equal(h.providerProc.starts.length, 2)
})

// A menu file or catalog read again while the font list runs: rebuild()
// sets a new tree and calls refresh(). Each row gives the new tree, the
// lists started after the font list, and the published menus.
test("a tree rebuilt while lists run lists the current tree's provider menus", () => {
  const { fonts, kernels } = OmarchyMenu.PROVIDERS
  const power = OmarchyMenu.PROVIDERS["power-profiles"]
  const withoutKernel = { ...providerMenu }
  delete withoutKernel["update.kernel"]
  const withoutFont = { ...providerMenu }
  delete withoutFont["style.font"]
  const outputs = { [fonts.script]: "Hack\tHack\tHack\n", [kernels.script]: "linux\tlinux\tlinux\n", [power.script]: "balanced\tbalanced\tbalanced\n" }
  for (const [name, tree, later, published] of [
    ["the same menus", providerTree(providerMenu), [kernels], { "style.font": "omarchy-font-set 'Hack'", "update.kernel": "omarchy-kernel set 'linux'" }],
    ["a queued menu removed", providerTree(withoutKernel), [], { "style.font": "omarchy-font-set 'Hack'" }],
    ["the running menu removed", providerTree(withoutFont), [kernels], { "update.kernel": "omarchy-kernel set 'linux'" }],
    ["a provider menu added", providerTree({ ...providerMenu, "setup.power": { label: "Power", provider: "power-profiles" } }), [kernels, power],
      { "style.font": "omarchy-font-set 'Hack'", "update.kernel": "omarchy-kernel set 'linux'", "setup.power": "omarchy-powerprofiles-set autodetect 'balanced'" }],
    // An extension can give an existing menu another provider.
    ["the running menu's provider changed", providerTree(providerMenu, { "style.font": { provider: "power-profiles" } }), [power, kernels],
      { "style.font": "omarchy-powerprofiles-set autodetect 'balanced'", "update.kernel": "omarchy-kernel set 'linux'" }]
  ]) {
    const h = providerHarness()
    h.source.refresh()
    h.source.tree = tree
    h.source.refresh()
    assert.equal(h.providerProc.starts.length, 1, name)
    for (const start of h.providerProc.starts) {
      if (!h.providerProc.running) break
      h.end(0, 0, outputs[start[5]])
    }
    assert.deepEqual(h.providerProc.starts.slice(1), later.map((spec) => bash(spec.script)), name)
    assert.equal(h.providerProc.running, false, name)
    assert.equal(h.source.revision, 4, name + ": one publish")
    const rows = h.source.providerItems
    assert.deepEqual(Object.fromEntries(Object.keys(rows).map((id) => [id, rows[id].map((r) => r.action).join()])), published, name)
  }
})

// The FileViews of the shipped menu and the user's extension, with load():
// read(which, text) is a FileView's loaded(), failed(which) its loadFailed().
function menuFileHarness() {
  const messages = []
  const source = {
    defaultPath: "/opt/omarchy/default/omarchy/omarchy-menu.jsonc", userPath: "/home/u/.config/omarchy/extensions/omarchy-menu.jsonc",
    defaultItems: [], userItems: [], message: (level, text) => messages.push([level, text]), rebuild() {}
  }
  const context = vm.createContext({ source, OmarchyMenu, text: () => "" })
  vm.runInContext(method("load"), context)
  source.load = context.load
  const from = { default: "path: source.defaultPath", user: "path: source.userPath" }
  // A handler is one statement or a { } block.
  const body = (name, which) => {
    const one = handler(name, from[which])
    return one.trimStart().startsWith("{") ? block(name + ": {", 4, from[which]).slice(name.length + 2) : one
  }
  const run = (name, which, value) => {
    context.text = () => value
    vm.runInContext("(function() { " + body(name, which) + " })()", context)
  }
  const ids = (which) => source[which + "Items"].map((item) => item.id)
  return { messages, ids, read: (which, value) => run("onLoaded", which, value), failed: (which) => run("onLoadFailed", which) }
}

test("a menu file read empty, unreadable or missing keeps its previous rows", () => {
  const good = (id) => JSON.stringify({ [id]: { label: id } })
  // Each read: the text (null for a failed load), the ids that stay, and
  // whether it warns.
  for (const [which, reads] of [
    ["default", [
      [good("first"), ["first"], false],
      ["", ["first"], true],
      ['{ "half": { "label": ', ["first"], true],
      ["[]", ["first"], true],
      [null, ["first"], true],
      [good("second"), ["second"], false]
    ]],
    // An empty or missing extension file is the user's choice.
    ["user", [
      [good("mine"), ["mine"], false],
      ['{ "half": ', ["mine"], true],
      ["", [], false],
      [good("again"), ["again"], false],
      [null, [], false]
    ]]
  ]) {
    const h = menuFileHarness()
    for (const [value, kept, warns] of reads) {
      const count = h.messages.length
      if (value === null) h.failed(which)
      else h.read(which, value)
      const name = which + " " + JSON.stringify(value)
      assert.deepEqual(h.ids(which), kept, name)
      assert.equal(h.messages.length - count, warns ? 1 : 0, name)
    }
  }
})

function sandbox(t) {
  const parent = fs.realpathSync("/tmp")
  const root = fs.mkdtempSync(path.join(parent, "foamy-menu-guard-probe-"))
  const marker = path.join(root, ".foamy-menu-guard-probe")
  fs.writeFileSync(marker, "guard import fixtures\n")
  t.after(() => {
    assert.ok(path.isAbsolute(root))
    assert.equal(path.dirname(root), parent)
    assert.ok(path.basename(root).startsWith("foamy-menu-guard-probe-"))
    assert.equal(fs.readFileSync(marker, "utf8"), "guard import fixtures\n")
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

// Opt in on Omarchy: OMACAST_QML_RUNNER=/usr/bin/qs node --test tests/omarchy-native-guards.test.js
test("real QML imports present, missing, broken, throwing and quoted-path OEM fixtures", { skip: !process.env.OMACAST_QML_RUNNER }, t => {
  const root = sandbox(t)
  const paths = {}
  const fixtures = {
    present: 'function guardScript(items) { return "stock:" + Object.keys(items).sort().join(",") }\n',
    missing: null,
    broken: 'function guardScript( {\n',
    throws: 'function guardScript(items) { throw new Error("compiler failed") }\n',
    invalid: 'function guardScript(items) { return 7 }\n',
    'space "double" \'single\' #percent%': 'function guardScript(items) { return "stock:" + Object.keys(items).sort().join(",") }\n'
  }
  for (const [name, script] of Object.entries(fixtures)) {
    paths[name] = path.join(root, name)
    const dir = path.join(paths[name], "shell/plugins/menu")
    fs.mkdirSync(dir, { recursive: true })
    if (script !== null) fs.writeFileSync(path.join(dir, "MenuModel.js"), script)
  }
  // No desktop session bus, display or Omarchy command (tests/qs-sandbox.js).
  const { env, hostCommands } = isolatedQs(root)
  const coreUrl = pathToFileURL(path.join(__dirname, "../core/OmarchyMenu.js")).href
  const config = path.join(root, "shell.qml")
  fs.writeFileSync(config, `import QtQml
import Quickshell
import ${JSON.stringify(coreUrl)} as OmarchyMenu
ShellRoot {
  id: source
  property string omarchyPath: ""
  property string commandTimeout: "10s"
  property var guardCompiler: null
  property var tree: ({ items: ({}), order: [] })
  property var guards: ({})
  property int revision: 0
  property var providerQueue: []
  signal message(string level, string text, var metadata)
  property QtObject guardProcess: QtObject {
    id: guardProc
    property bool running: false
    property string collected: ""
    property var requestTree: null
    property var expectedGuards: []
    property var command: []
  }
  property QtObject providerProcess: QtObject { id: providerProc; property bool running: true }
  function providerMenus() { return [] }
  function startNextProvider() {}
  ${methods.map(method).join("\n  ")}
  Component.onDestruction: ${handler("Component.onDestruction")}
  function check(ok, detail) { if (!ok) throw new Error(detail) }
  Component.onCompleted: Qt.callLater(function() {
    try {
      var paths = ${JSON.stringify(paths)}
      source.tree = { order: ["probe", "bad", "__proto__", "constructor", "toString"], items: JSON.parse(${JSON.stringify(JSON.stringify({
        probe: { id: "probe", when: "true" }, bad: { id: "bad'; echo injected", when: "true" },
        ["__proto__"]: { id: "__proto__", checked: "false" }, constructor: { id: "constructor", disabled: "true" }
      }))}) }
      var items = source.guardItems(source.tree)
      check(Object.getPrototypeOf(items) === null, "input map has a prototype")
      check(Object.keys(items).sort().join(",") === "__proto__,constructor,probe", "unsafe input IDs")
      var fallback = OmarchyMenu.guardScript(source.tree)
      check(source.compileGuards(source.tree, items) === fallback, "startup fallback")
      for (var name in paths) {
        source.omarchyPath = paths[name]
        source.createGuardCompiler()
        var available = name === "present" || name.indexOf("space ") === 0
        if (name !== "missing" && name !== "broken") check(source.guardCompiler !== null, "import failed: " + name)
        var script = source.compileGuards(source.tree, items)
        check(script === (available ? "stock:__proto__,constructor,probe" : fallback), "wrong compiler: " + name)
        if (source.guardCompiler) { source.guardCompiler.destroy(); source.guardCompiler = null }
      }
      console.log("OMACAST_GUARD_PROBE:OK")
    } catch (error) { console.error("OMACAST_GUARD_PROBE:FAIL " + error) }
    Qt.quit()
  })
}
`)
  const result = spawnSync(process.env.OMACAST_QML_RUNNER, ["-p", config], { cwd: root, env, encoding: "utf8", timeout: 15000, killSignal: "SIGKILL" })
  assert.ifError(result.error)
  const output = result.stdout + result.stderr
  assert.equal(result.status, 0, output)
  assert.match(output, /OMACAST_GUARD_PROBE:OK/)
  assert.doesNotMatch(output, /OMACAST_GUARD_PROBE:FAIL/)
  assert.deepEqual(hostCommands(), [])
})
