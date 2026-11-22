const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const QueryEdit = require("../core/QueryEdit.js")

const source = fs.readFileSync(path.join(__dirname, "../ui/LauncherWindow.qml"), "utf8")

// A function body as JavaScript: QML's type assertion "(…) as ActionPanel"
// is not, so it goes (the window's Loaders only ever hold ActionPanels).
function body(signature) {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, signature)
  const open = source.indexOf("{", start) + 1
  const end = source.indexOf("\n  }", open)
  return "(function() {\n" + source.slice(open, end).replace(/\) as [A-Z]\w*/g, ")") + "\n})()"
}

// The launcher's paste functions, run from LauncherWindow.qml, with a fake
// kit/FoamyClipboard.qml: start() begins a read, and the test answers
// it later with read(text) or fail(message), as the real reader's signals do.
function harness() {
  let next = 16
  const Qt = new Proxy({ NoModifier: 0, ControlModifier: 1, ShiftModifier: 2, AltModifier: 4, MetaModifier: 8 }, {
    get(target, key) { if (!(key in target)) target[key] = next++; return target[key] }
  })
  const changes = []
  const toasts = []
  const window = {
    query: "prefix ", cursorPos: 7, keepCursor: false, view: { kind: "root" }, historyIndex: 0,
    actionPanelOpen: false, dropdownOpen: false, toastPanelOpen: false, aboutOpen: false,
    gridView: false, editing: false, vim: false, shown: true, editRevision: 0, pasteRevision: -1,
    rebuild: reset => changes.push(reset), isTyping: () => false,
    isActionPanelKey: () => false, direction: () => 0,
    showToast: (style, title) => toasts.push([style, title])
  }
  // The window's change handlers that count an edit: onQueryChanged and the
  // one-line `onXChanged: window.editRevision++` handlers, read from
  // LauncherWindow.qml. A real change counts one edit; a popup filter edit
  // counts in handlePopupKey itself.
  const counted = (target, name) => {
    let value = target[name]
    Object.defineProperty(target, name, {
      get: () => value,
      set: next => { if (next !== value) { value = next; window.editRevision++ } }
    })
  }
  const handlers = [...source.matchAll(/^ {2}on([A-Z]\w*)Changed: window\.editRevision\+\+$/gm)].map(m => m[1].charAt(0).toLowerCase() + m[1].slice(1))
  for (const name of ["query", ...handlers]) counted(window, name)
  // A popup list's Loader (the action panel, the filter list, the toast
  // actions): no item while closed, a new one each time it opens.
  const loader = (open) => {
    let panel = null
    return {
      get item() {
        if (!window[open]) panel = null
        else if (!panel) panel = { filter: "" }
        return panel
      }
    }
  }
  const actionPanel = loader("actionPanelOpen")
  const dropdown = loader("dropdownOpen")
  const toastPanel = loader("toastPanelOpen")
  const clipboardReader = {
    busy: false, reads: 0,
    start() { if (this.busy) return false; this.busy = true; this.reads++; return true },
    cancel() { this.busy = false }
  }
  const context = vm.createContext({ Qt, window, actionPanel, dropdown, toastPanel, clipboardReader, QueryEdit, Util: { editsFilter: () => false } })
  // Runs a one-argument function body with its argument bound, restoring
  // the caller's binding of that name afterwards (setQuery and applyEdit
  // both take `next`).
  const withArg = (signature, name) => value => {
    const outer = context[name]
    context[name] = value
    const result = vm.runInContext(body(signature), context)
    context[name] = outer
    return result
  }
  window.setQuery = withArg("function setQuery(next)", "next")
  window.applyEdit = withArg("function applyEdit(next)", "next")
  window.insertPaste = withArg("function insertPaste(text)", "text")
  window.pasteFailed = withArg("function pasteFailed(message)", "message")
  for (const name of ["pasteClipboard", "cancelPaste", "takePaste"])
    window[name] = () => vm.runInContext(body(`function ${name}()`), context)
  // queryState is a one-line function in the window; the same expression here.
  window.queryState = () => QueryEdit.state(window.query, window.cursorPos)
  window.handlePopupKey = (event, panel, ctrl, alt) => {
    Object.assign(context, { event, panel, ctrl, alt })
    return vm.runInContext(body("function handlePopupKey(event, panel, ctrl, alt)"), context)
  }
  window.handleQueryKey = (event, ctrl, alt, shift, key) => {
    Object.assign(context, { event, ctrl, alt, shift, key })
    return vm.runInContext(body("function handleQueryKey(event, ctrl, alt, shift, key)"), context)
  }
  return {
    Qt, window, actionPanel, dropdown, toastPanel, clipboardReader, changes, toasts,
    press(key, modifiers) {
      context.event = { key: Qt["Key_" + key], modifiers }
      return vm.runInContext(body("function handleKey(event)"), context)
    },
    // A printable key, as the launcher's key catcher delivers it.
    type(text) {
      context.event = { key: 0, modifiers: Qt.NoModifier, text }
      return vm.runInContext(body("function handleKey(event)"), context)
    },
    // The reader's answer to the read in flight.
    read(text) {
      assert.equal(clipboardReader.busy, true, "a read is running")
      clipboardReader.busy = false
      window.insertPaste(text)
    },
    fail(message) {
      assert.equal(clipboardReader.busy, true, "a read is running")
      clipboardReader.busy = false
      window.pasteFailed(message)
    }
  }
}

test("both Omarchy paste shortcuts start one bounded read and insert its text once", () => {
  for (const [key, modifier] of [["V", "ControlModifier"], ["Insert", "ShiftModifier"]]) {
    const h = harness()
    assert.equal(h.press(key, h.Qt[modifier]), true)
    assert.equal(h.clipboardReader.reads, 1)
    assert.equal(h.window.query, "prefix ", "nothing is inserted before the read answers")
    h.read("12+34")
    assert.equal(h.window.query, "prefix 12+34")
    assert.equal(h.window.historyIndex, -1)
    assert.deepEqual(h.changes, [true])
    assert.equal(h.window.pasteRevision, -1)
  }
})

test("Ctrl+Shift+V pastes like Ctrl+V", () => {
  const h = harness()
  assert.equal(h.press("V", h.Qt.ControlModifier | h.Qt.ShiftModifier), true)
  h.read("12+34")
  assert.equal(h.window.query, "prefix 12+34")
})

test("an empty clipboard leaves the query and history unchanged, without a toast", () => {
  const h = harness()
  assert.equal(h.press("Insert", h.Qt.ShiftModifier), true)
  h.read("")
  assert.equal(h.window.query, "prefix ")
  assert.equal(h.window.historyIndex, 0)
  assert.deepEqual(h.changes, [])
  assert.deepEqual(h.toasts, [])
})

test("clipboard paste also works in submenu queries and alias editing", () => {
  const h = harness()
  h.window.view = { kind: "menu" }
  h.press("V", h.Qt.ControlModifier)
  h.read("some text with\tspaces")
  assert.equal(h.window.query, "prefix some text with\tspaces")
  h.window.view = { kind: "alias" }
  h.window.query = ""
  h.press("Insert", h.Qt.ShiftModifier)
  h.read("some text with\tspaces")
  assert.equal(h.window.query, "sometextwithspaces")
})

test("action-panel paste edits its filter without changing the query", () => {
  const h = harness()
  h.window.actionPanelOpen = true
  h.actionPanel.item.filter = "Find "
  h.press("V", h.Qt.ControlModifier)
  h.read("Copy Result")
  assert.equal(h.actionPanel.item.filter, "Find Copy Result")
  assert.equal(h.window.query, "prefix ")
  assert.deepEqual(h.changes, [])
})

// The root filter list (Ctrl+P) and the toast actions (Ctrl+T) take typed
// text into their filter; a paste goes there too.
test("a paste with the filter list or the toast actions open edits that list's filter, as typing does", () => {
  for (const [open, list] of [["dropdownOpen", "dropdown"], ["toastPanelOpen", "toastPanel"]]) {
    const h = harness()
    h.window[open] = true
    h.window.isTyping = event => !!event.text
    h.type("A")
    assert.equal(h[list].item.filter, "A", open + ": typing goes to the list's filter")
    h.press("V", h.Qt.ControlModifier)
    h.read("pps")
    assert.equal(h[list].item.filter, "Apps", open)
    assert.equal(h.window.query, "prefix ", open)
    assert.deepEqual(h.changes, [], open)
  }
})

test("with the About panel open, Ctrl+V reads nothing, as typing changes nothing", () => {
  const h = harness()
  h.window.aboutOpen = true
  h.window.isTyping = event => !!event.text
  assert.equal(h.type("x"), true)
  assert.equal(h.press("V", h.Qt.ControlModifier), true)
  assert.equal(h.clipboardReader.reads, 0)
  assert.equal(h.window.query, "prefix ")
})

test("unrelated V and Insert shortcuts never read the clipboard", () => {
  for (const [key, modifier] of [["V", "NoModifier"], ["V", "AltModifier"], ["V", "MetaModifier"], ["Insert", "ControlModifier"]]) {
    const h = harness()
    h.press(key, h.Qt[modifier])
    assert.equal(h.clipboardReader.reads, 0, key + " " + modifier)
    assert.equal(h.window.query, "prefix ")
  }
})

test("paste inserts at the search field's cursor", () => {
  const h = harness()
  h.window.query = "deep galactic"
  h.window.cursorPos = 5
  assert.equal(h.press("V", h.Qt.ControlModifier), true)
  h.read("rock ")
  assert.equal(h.window.query, "deep rock galactic")
  assert.equal(h.window.cursorPos, 10)
})

test("a second paste while one is reading starts no second read", () => {
  const h = harness()
  h.press("V", h.Qt.ControlModifier)
  h.press("V", h.Qt.ControlModifier)
  assert.equal(h.clipboardReader.reads, 1)
  h.read("once")
  assert.equal(h.window.query, "prefix once")
})

// A slow clipboard must never overwrite what the user did meanwhile.
test("a late result is dropped when the launcher moved on", () => {
  const cases = {
    "typing": h => { h.window.query = "prefix x"; h.window.cursorPos = 8 },
    "typing since undone": h => {
      h.window.applyEdit({ text: "prefix x", cursor: 8 })
      assert.equal(h.press("Backspace", h.Qt.NoModifier), true)
      assert.deepEqual([h.window.query, h.window.cursorPos], ["prefix ", 7], "back to the text and cursor the paste started at")
    },
    "a cursor move": h => { h.window.cursorPos = 0 },
    "another view": h => { h.window.view = { kind: "menu" } },
    "the same kind of view, pushed again": h => { h.window.view = { kind: "root" } },
    "the action panel opening": h => { h.window.actionPanelOpen = true },
    "the filter list opening": h => { h.window.dropdownOpen = true },
    "the toast actions opening": h => { h.window.toastPanelOpen = true },
    "the About panel opening": h => { h.window.aboutOpen = true },
    "the launcher closing": h => { h.window.shown = false },
    "a cancelled paste": h => { h.window.cancelPaste() }
  }
  for (const [name, change] of Object.entries(cases)) {
    const h = harness()
    const query = () => [h.window.query, h.window.cursorPos]
    h.press("V", h.Qt.ControlModifier)
    change(h)
    const before = query()
    h.clipboardReader.busy = true
    h.read("late")
    assert.deepEqual(query(), before, name)
    for (const list of [h.actionPanel, h.dropdown, h.toastPanel]) assert.ok(!list.item || list.item.filter === "", name)
    assert.equal(h.window.pasteRevision, -1, name)
  }
})

test("a result for a filter list or toast actions that closed is dropped", () => {
  for (const open of ["dropdownOpen", "toastPanelOpen"]) {
    const h = harness()
    h.window[open] = true
    h.press("V", h.Qt.ControlModifier)
    h.window[open] = false
    h.read("late")
    assert.equal(h.window.query, "prefix ", open)
    assert.deepEqual(h.changes, [], open)
  }
})

test("a filter edit in the action panel drops a late result", () => {
  const h = harness()
  h.window.actionPanelOpen = true
  h.press("V", h.Qt.ControlModifier)
  h.window.isTyping = event => !!event.text
  assert.equal(h.type("c"), true)
  assert.equal(h.actionPanel.item.filter, "c", "typing goes to the panel's filter")
  h.read("late")
  assert.equal(h.actionPanel.item.filter, "c")
})

test("a result for an action panel that closed and opened again is dropped", () => {
  const h = harness()
  h.window.actionPanelOpen = true
  h.press("V", h.Qt.ControlModifier)
  h.window.actionPanelOpen = false
  assert.equal(h.actionPanel.item, null)
  h.window.actionPanelOpen = true
  h.read("late")
  assert.equal(h.actionPanel.item.filter, "")
})

test("a failed read shows its message as a failure toast", () => {
  const h = harness()
  h.press("V", h.Qt.ControlModifier)
  h.fail("Clipboard text is too large or contains invalid characters.")
  assert.deepEqual(h.toasts, [["failure", "Clipboard text is too large or contains invalid characters."]])
  assert.equal(h.window.query, "prefix ")
  assert.equal(h.window.pasteRevision, -1)
})

test("a failure that arrives after the launcher closed shows nothing", () => {
  const h = harness()
  h.press("V", h.Qt.ControlModifier)
  h.window.shown = false
  h.fail("Clipboard paste timed out. Copy the text again.")
  assert.deepEqual(h.toasts, [])
})

test("no QML of the launcher holds a Qt text input or calls paste()", () => {
  // Qt's paste() reads the whole clipboard on the UI thread with no byte cap
  // or total deadline (marketplace review of 2.3.0). A Qt text input brings
  // that paste with its own shortcuts, so no QML file the plugin ships may
  // hold one: the root, ui/ and services/ (kit/ is foamy-kit's).
  const root = path.join(__dirname, "..")
  const files = ["", "ui", "services"].flatMap(dir =>
    fs.readdirSync(path.join(root, dir)).filter(name => name.endsWith(".qml")).map(name => path.join(dir, name)))
  assert.ok(files.includes(path.join("ui", "LauncherWindow.qml")), "the scan reads the launcher window")
  for (const file of files)
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), "utf8"),
      /\.paste\(\)|\bTextEdit\b|\bTextInput\b|\bTextField\b|\bTextArea\b/, file)
})
