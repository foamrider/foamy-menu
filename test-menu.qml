import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "plugin" as Foamy
import "services" as Services

ShellRoot {
  id: test
  property int stage: 0
  property int checks: 0
  property int sectionIndex: 0
  readonly property var sections: ["left", "centerBegin", "center", "centerEnd", "tray", "right"]
  property var summonCalls: []
  property var expectedCommands: []
  property var actionModes: ["accepted", "denied", "revoked", "older", "restored"]
  property int actionMode: 0
  readonly property var summonTargets: [
    {id: "omarchy.clipboard", payload: "{}"},
    {id: "omarchy.speedtest", payload: "{}"},
    {id: "omarchy.disk-speedtest", payload: "{}"},
    {id: "omarchy.image-picker", payload: '{"source":"themes"}'},
    {id: "omarchy.wifiqr", payload: "{}"}
  ]
  function check(condition, message) {
    if (!condition) { console.error("FAIL: " + message); Qt.exit(1); return }
    checks++
    console.log("PASS: " + message)
  }
  Services.AppLibrary { id: hostLibrary }
  Services.PluginAppLibraryApi {
    id: capability
    ownerPluginId: "foamy.menu"
    _entryName: function(entry) { return hostLibrary.entryName(entry) }
    _entrySubtext: function(entry) { return hostLibrary.entrySubtext(entry) }
    _sortedEntries: function(query) { return hostLibrary.sortedEntries(query) }
    _iconSource: function(icon) { return hostLibrary.iconSource(icon) }
    _refreshIcons: function() { hostLibrary.refreshIcons() }
  }
  Connections {
    target: hostLibrary
    function onAppsChanged() { capability.appsChanged() }
  }
  Component {
    id: facade
    Services.PluginShellApi { pluginId: "foamy.menu"; appLibrary: capability }
  }
  Foamy.Menu { id: wrapper; settingsPath: settingsFixture.path }
  Component.onCompleted: wrapper.shell = facade.createObject(null)
  function fallbackActive() {
    for (var i = 0; i < wrapper.data.length; i++) {
      var child = wrapper.data[i]
      if (child instanceof Loader && String(child.source).endsWith("/AppLibrary.qml"))
        return child.active
    }
    return true
  }
  FileView {
    id: settingsFixture
    path: Qt.resolvedUrl("shell.json").toString().replace("file://", "")
  }
  function captureMenu(name) {
    var path = Quickshell.env("FOAMY_MENU_CAPTURE_DIR")
    if (path && wrapper.menuSurface) wrapper.menuSurface.grabToImage(function(result) {
      test.check(result.saveToFile(path + "/" + name + ".png"), "menu capture saved")
    })
  }
  function setConfig(bar) { settingsFixture.setText(JSON.stringify({version: 1, bar: bar})) }
  FileView {
    id: fixture
    path: Qt.resolvedUrl("menu.jsonc").toString().replace("file://", "")
  }
  function setMenuTestEntry(enabled) {
    var entries = {apps: {label: "Apps", provider: "apps"}}
    if (enabled) entries["foamy-test"] = {label: "Foamy test entry", action: "true"}
    fixture.setText(JSON.stringify(entries))
  }
  FileView {
    id: actionLog
    path: Quickshell.env("FOAMY_MENU_TEST_ACTION_LOG")
    blockLoading: true
  }
  function startActionBatch() {
    var mode = actionModes[actionMode]
    if (mode === "revoked") wrapper.shell.destroy()
    if (mode === "older") wrapper.shell = {appLibrary: capability}
    if (mode === "restored") wrapper.shell = facade.createObject(null)
    if (mode === "accepted" || mode === "denied" || mode === "restored") {
      wrapper.shell._summon = function(id, payload) {
        test.summonCalls.push({id: id, payload: payload})
        return mode !== "denied"
      }
    }
    // Older hosts and destroyed QObjects must both leave the fallback reachable.
    // Destruction is deferred, so the revoked batch starts on the next timer tick.
  }
  function runActionBatch(stock) {
    var mode = actionModes[actionMode]
    var accepted = mode === "accepted" || mode === "restored"
    summonCalls = []
    test.check(stock.shell.summon("omarchy.image-picker", '{"source":"themes"}') === accepted,
               mode + " facade preserves the summon result")
    if (accepted || mode === "denied")
      test.check(JSON.stringify(summonCalls) === JSON.stringify([summonTargets[3]]),
                 mode + " facade forwards target and payload unchanged")
    summonCalls = []
    for (var i = 0; i < summonTargets.length; i++) {
      var target = summonTargets[i]
      var command = "omarchy-shell shell summon " + target.id
      if (target.payload !== "{}") command += " '" + target.payload + "'"
      stock.runAction(command)
    }
    // 4.0.6 dispatches every action through a command; 4.5 first tries the facade.
    var direct = summonCalls.length > 0
    test.check(!direct || JSON.stringify(summonCalls) === JSON.stringify(summonTargets),
               mode + " direct dispatch is either unused or forwards all five targets once")
    if (!direct || !accepted) {
      for (var j = 0; j < summonTargets.length; j++) {
        var entry = summonTargets[j]
        expectedCommands.push("shell summon " + entry.id + (entry.payload === "{}" ? "" : " " + entry.payload))
      }
    }
    console.log("DISPATCH: " + mode + ", " + summonCalls.length + " direct host calls")
  }
  function actionBatchFinished() {
    actionLog.reload()
    var content = actionLog.text().trim()
    var commands = content ? content.split("\n") : []
    if (commands.length < expectedCommands.length) return false
    test.check(JSON.stringify(commands.sort()) === JSON.stringify(expectedCommands.slice().sort()),
               actionModes[actionMode] + " stock fallback dispatches exact commands without duplicates")
    return true
  }
  Timer {
    interval: 500
    running: true
    repeat: true
    onTriggered: {
      var stock = null
      for (var i = 0; i < wrapper.data.length; i++) {
        if (wrapper.data[i] instanceof Loader) stock = wrapper.data[i].item
      }
      // Switching application libraries can recreate the stock menu. Let each
      // new instance load the same fixture before exercising its routes.
      if (stock && stock.userMenuPath !== fixture.path) {
        stock.userMenuPath = fixture.path
        return
      }
      switch (test.stage++) {
      case 0:
        test.check(stock && wrapper.menuSurface, "loads the installed stock menu")
        test.check(typeof stock.shell.summon === "function", "stock menu receives a summon adapter")
        test.check(wrapper.usingSharedAppLibrary && !test.fallbackActive(), "host capability avoids a duplicate application library")
        wrapper.open('{"menu":"root"}')
        break
      case 1:
        test.check(wrapper.opened && stock.rowsLoaded, "root menu opens")
        test.check(wrapper.menuSurface.width === Style.space(360), "configured minimum width")
        wrapper.open('{"menu":"apps"}')
        break
      case 2:
        test.check(stock.childCount("apps") > 0, "real application library supplies entries")
        stock.setFilter("firefox")
        break
      case 3:
        test.check(stock.filterText === "firefox", "stock search remains available")
        wrapper.close()
        test.check(!wrapper.opened, "close state forwarded")
        test.setConfig({layout: {right: [{id: "foamy.menu", width: 440}]}})
        wrapper.open('{"menu":"root"}')
        break
      case 4:
        test.check(wrapper.menuSurface.width === Style.space(440), "configuration updates live in another bar section")
        wrapper.open('{"menu":"style.font"}')
        break
      case 5:
        test.check(wrapper.menuSurface.width === stock.cardWidth && stock.cardWidth === Style.space(520), "wider stock menu preserved")
        wrapper.open('{"mode":"select","prompt":"Test selection","options":["One","Two"],"width":280}')
        break
      case 6:
        test.check(wrapper.menuSurface.width === Style.space(280), "selection dialog keeps caller width")
        wrapper.open('{"mode":"input","prompt":"Test input","width":310}')
        break
      case 7:
        test.check(wrapper.menuSurface.width === Style.space(310), "input dialog keeps caller width")
        test.setConfig({layout: {left: [{id: "foamy.menu", width: 0}]}})
        wrapper.open('{"menu":"root"}')
        break
      case 8:
        test.check(wrapper.menuSurface.width === stock.cardWidth, "zero restores stock width")
        test.setConfig({layout: {left: [{id: "foamy.menu", width: -20}]}})
        break
      case 9:
        test.check(wrapper.configuredWidth === 360 && wrapper.menuSurface.width === Style.space(360), "invalid setting falls back with warning")
        test.setConfig({layout: {left: [{id: "foamy.menu", width: 4096}]}})
        break
      case 10:
        test.check(wrapper.menuSurface.width <= wrapper.menuWindow.width - Style.gapsOut * 2, "oversized width stays within the screen")
        test.setMenuTestEntry(true)
        break
      case 11:
        test.check(stock.item("foamy-test") !== null, "new entry appears through stock file watcher")
        test.setMenuTestEntry(false)
        break
      case 12:
        test.check(stock.item("foamy-test") === null, "removed entry disappears through stock file watcher")
        wrapper.close()
        // Revocation destroys the actual facade object, as the host does on reload.
        wrapper.shell.destroy()
        break
      case 13:
        test.check(!wrapper.usingSharedAppLibrary && test.fallbackActive(), "revoked facade activates the packaged fallback")
        wrapper.open('{"menu":"apps"}')
        break
      case 14:
        test.check(stock.childCount("apps") > 0, "applications remain available after capability loss")
        stock.setFilter("firefox")
        wrapper.shell = facade.createObject(null)
        break
      case 15:
        test.check(wrapper.usingSharedAppLibrary && !test.fallbackActive(), "restored capability releases the fallback library")
        test.check(wrapper.opened && stock.filterText === "firefox", "search and open state survive capability restoration")
        test.check(stock.childCount("apps") > 0, "restored host capability supplies applications")
        wrapper.close()
        test.startActionBatch()
        break
      case 16:
        test.runActionBatch(stock)
        break
      case 17:
        if (!test.actionBatchFinished()) { test.stage--; break }
        if (++test.actionMode < test.actionModes.length) {
          test.startActionBatch()
          test.stage = 16
          break
        }
        break
      case 18:
        if (test.sectionIndex === test.sections.length) {
          test.setConfig({layout: {left: {id: "foamy.menu", width: 800}, right: [{id: "foamy.menu", width: 460}]}})
          test.stage = 20
          break
        }
        var layout = {}
        layout[test.sections[test.sectionIndex]] = [{id: "other.menu", width: 900}, "foamy.menu", {id: "foamy.menu", width: 610 + test.sectionIndex}]
        test.setConfig({layout: layout})
        wrapper.open('{"menu":"root"}')
        break
      case 19:
        test.check(wrapper.configuredWidth === 610 + test.sectionIndex
                   && wrapper.menuSurface.width === Style.space(610 + test.sectionIndex),
                   test.sections[test.sectionIndex] + " retains width through the file watcher")
        if (test.sectionIndex === 0 || test.sectionIndex === 4) test.captureMenu(test.sections[test.sectionIndex])
        test.sectionIndex++
        test.stage = 18
        break
      case 20:
        test.check(wrapper.configuredWidth === 460, "malformed section is skipped")
        test.setConfig({layout: {tray: [{id: "foamy.menu", width: -1}]}})
        break
      case 21:
        test.check(wrapper.configuredWidth === 360, "invalid width in tray falls back")
        test.setConfig({layout: {centerEnd: ["foamy.menu"]}})
        break
      case 22:
        test.check(wrapper.configuredWidth === 360, "string entry keeps default width")
        wrapper.close()
        console.log("RESULT: " + test.checks + " integration checks passed")
        Qt.quit()
      }
    }
  }
  Timer { interval: 40000; running: true; onTriggered: { console.error("FAIL: timeout"); Qt.exit(1) } }
}
