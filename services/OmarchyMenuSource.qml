import QtQuick
import Quickshell
import Quickshell.Io
import "../core/OmarchyMenu.js" as OmarchyMenu
import "../kit"

Item {
  id: source

  property string omarchyPath: Quickshell.env("OMARCHY_PATH") || "/usr/share/omarchy"
  readonly property string defaultPath: source.omarchyPath + "/default/omarchy/omarchy-menu.jsonc"
  readonly property string userPath: Quickshell.env("HOME") + "/.config/omarchy/extensions/omarchy-menu.jsonc"

  property var defaultItems: []
  property var userItems: []
  // Omarchy's own menu translations for the picked language (4.5).
  property var catalog: ({})
  readonly property string catalogPath: FoamyI18n.language !== "en" ? source.omarchyPath + "/default/i18n/" + FoamyI18n.language + "/menu.json" : ""
  property var tree: OmarchyMenu.buildTree([], [])
  property var guards: ({ when: {}, checked: {}, disabled: {} })
  property var providerItems: ({})
  property bool loading: guardProc.running || providerProc.running
  property int revision: 0
  property var guardCompiler: null
  // Each guard batch and provider list runs under coreutils timeout: at this
  // deadline its whole process group (the batch's background groups too)
  // gets SIGTERM, then SIGKILL a second later. A batch that ends that way
  // fails and keeps the previous results; so does a provider list.
  property string commandTimeout: "10s"

  signal message(string level, string text, var metadata)

  function createGuardCompiler() {
    try {
      var path = source.omarchyPath + "/shell/plugins/menu/MenuModel.js"
      var url = "file://" + path.split("/").map(encodeURIComponent).join("/")
      source.guardCompiler = Qt.createQmlObject(
        "import QtQml\nimport " + JSON.stringify(url) + " as Stock\n"
          + "QtObject { function compile(items) { return Stock.guardScript(items) } }",
        source, "OmarchyGuardCompiler")
    } catch (error) {
      source.guardCompiler = null
    }
  }

  Component.onCompleted: { source.createGuardCompiler(); source.refresh() }
  Component.onDestruction: if (source.guardCompiler) source.guardCompiler.destroy()

  function guardItems(tree) {
    var items = Object.create(null)
    for (var i = 0; i < tree.order.length; i++) {
      var id = tree.order[i]
      if (!Object.prototype.hasOwnProperty.call(tree.items, id)) continue
      var item = tree.items[id]
      if (item && /^[A-Za-z0-9._-]+$/.test(item.id)) items[item.id] = item
    }
    return items
  }

  function compileGuards(tree, items) {
    if (source.guardCompiler) {
      try {
        var script = source.guardCompiler.compile(items)
        if (typeof script === "string") return script
      } catch (error) {}
      source.guardCompiler.destroy()
      source.guardCompiler = null
    }
    return OmarchyMenu.guardScript(tree)
  }

  function guardKeys(items) {
    var keys = []
    for (var id in items) {
      if (items[id].when) keys.push(id + ":w")
      if (items[id].checked) keys.push(id + ":c")
      if (items[id].disabled) keys.push(id + ":d")
    }
    return keys
  }

  function finishGuards(exitCode, exitStatus) {
    var tree = guardProc.requestTree
    var expected = guardProc.expectedGuards
    guardProc.requestTree = null
    guardProc.expectedGuards = []
    if (!tree) return
    if (tree !== source.tree) { source.refresh(); return }
    if (exitCode !== 0 || exitStatus !== 0) {
      source.message("warning", "Menu guard refresh failed; keeping previous results.", null)
      return
    }
    var received = Object.create(null)
    var lines = guardProc.collected.split("\n")
    for (var i = 0; i < lines.length; i++) {
      // Guard rows look like system.lock:w:1, with one row per requested condition.
      var match = /^([A-Za-z0-9._-]+:[wcd]):[01]$/.exec(lines[i].trim())
      if (match) received[match[1]] = true
    }
    for (var j = 0; j < expected.length; j++) {
      if (!received[expected[j]]) {
        source.message("warning", "Menu guard refresh was incomplete; keeping previous results.", null)
        return
      }
    }
    source.guards = OmarchyMenu.parseGuardOutput(guardProc.collected)
    source.revision++
  }

  function rebuild() {
    source.tree = OmarchyMenu.buildTree(OmarchyMenu.applyCatalog(source.defaultItems, source.catalog), source.userItems)
    source.revision++
    source.refresh()
  }

  function refresh() {
    if (!guardProc.running) {
      var items = source.guardItems(source.tree)
      var script = source.compileGuards(source.tree, items)
      if (script) {
        guardProc.collected = ""
        guardProc.requestTree = source.tree
        guardProc.expectedGuards = source.guardKeys(items)
        guardProc.command = source.bounded(["bash", "-lc", script])
        guardProc.running = true
      }
    }
    if (!providerProc.running) {
      source.providerQueue = source.providerMenus()
      source.startNextProvider()
    }
  }

  function bounded(argv) {
    return ["timeout", "--kill-after=1s", source.commandTimeout].concat(argv)
  }

  function providerMenus() {
    var out = []
    for (var i = 0; i < source.tree.order.length; i++) {
      var item = source.tree.items[source.tree.order[i]]
      if (item.provider && OmarchyMenu.PROVIDERS[item.provider]) out.push(item.id)
    }
    return out
  }

  property var providerQueue: []
  property var pendingProviderItems: ({})

  function startNextProvider() {
    if (source.providerQueue.length === 0) {
      source.providerItems = source.pendingProviderItems
      source.pendingProviderItems = ({})
      source.revision++
      return
    }
    var menuId = source.providerQueue[0]
    source.providerQueue = source.providerQueue.slice(1)
    var spec = OmarchyMenu.PROVIDERS[source.tree.items[menuId].provider]
    providerProc.menuId = menuId
    providerProc.collected = ""
    providerProc.command = source.bounded(["bash", "-lc", spec.script])
    providerProc.running = true
  }

  // The one way a provider list ends: exited or couldn't start. A second call
  // for the same run (running -> false after exited()) finds no menuId. A
  // list that timed out, was killed or never started keeps the previous one.
  function finishProvider(ok) {
    var menuId = providerProc.menuId
    if (menuId === "") return
    providerProc.menuId = ""
    var item = source.tree.items[menuId]
    if (item) {
      var next = ({})
      for (var k in source.pendingProviderItems) next[k] = source.pendingProviderItems[k]
      next[menuId] = ok ? OmarchyMenu.providerItems(menuId, item.provider, providerProc.collected) : (source.providerItems[menuId] || [])
      source.pendingProviderItems = next
    }
    source.startNextProvider()
  }

  function load(which, text) {
    var parsed = OmarchyMenu.parse(text)
    if (parsed.error) source.message("warning", "ignoring unreadable " + (which === "user" ? source.userPath : source.defaultPath) + ": " + parsed.error, null)
    if (which === "user") source.userItems = parsed.items
    else source.defaultItems = parsed.items
    source.rebuild()
  }

  Process {
    id: guardProc
    property string collected: ""
    property var requestTree: null
    property var expectedGuards: []
    stdout: SplitParser { onRead: function(line) { guardProc.collected += line + "\n" } }
    onExited: function(exitCode, exitStatus) {
      source.finishGuards(exitCode, exitStatus)
    }
    // After exited() (or a restart from it) this finds no request. Without
    // exited() before it the batch never started: keep the previous results.
    onRunningChanged: if (!running) source.finishGuards(-1, 1)
  }

  Process {
    id: providerProc
    property string menuId: ""
    property string collected: ""
    stdout: SplitParser { onRead: function(line) { providerProc.collected += line + "\n" } }
    // timeout exits 124 at the deadline (or is SIGKILLed with what's left).
    onExited: function(exitCode, exitStatus) { source.finishProvider(exitStatus === 0 && exitCode !== 124) }
    onRunningChanged: if (!running) source.finishProvider(false)
  }

  FileView {
    path: source.defaultPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: source.load("default", text())
    onLoadFailed: { source.message("error", "Omarchy menu not found at " + source.defaultPath, null); source.load("default", "") }
  }

  FileView {
    path: source.catalogPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: { source.catalog = OmarchyMenu.parseCatalog(text()); source.rebuild() }
    onLoadFailed: { source.catalog = ({}); source.rebuild() }
  }
  onCatalogPathChanged: if (!source.catalogPath) { source.catalog = ({}); source.rebuild() }

  FileView {
    path: source.userPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: source.load("user", text())
    onLoadFailed: source.load("user", "")
  }
}
