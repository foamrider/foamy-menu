import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "plugin" as Foamy
import "services" as Services
import "harness" as Harness

// Offscreen integration test, run by tests/runtime.py against the host's
// real stock menu (4.0.6 or 4.5): width adapter, app library sharing and
// fallback, live settings, summon routing and the bar button.

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
    if (!condition) { console.log("FOAMY FAIL " + message); Qt.exit(1); return }
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
  readonly property string shots: Quickshell.env("FOAMY_MENU_SHOTS") || ""
  function capture(item, name) {
    if (!shots || !item) return
    item.grabToImage(function(result) {
      var path = shots + "/" + name + ".png"
      if (result.saveToFile(path)) console.log("FOAMY SHOT " + path + " " + Math.round(item.width) + "x" + Math.round(item.height))
    })
  }
  function captureMenu(name) {
    if (!shots || !wrapper.menuWindow) return
    // 4.5's OverlayWindow maps only once Hyprland reports the monitor's
    // scale; offscreen there is no Hyprland, so show it for the capture.
    if ("shown" in wrapper.menuWindow && !wrapper.menuWindow.visible) {
      wrapper.menuWindow.visible = true
      wrapper.menuWindow.contentItem.opacity = 1
    }
    Qt.callLater(function() { test.capture(wrapper.menuSurface, name) })
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
        // The font picker is one of the stock menus wider than 440 (4.5 renamed it).
        wrapper.open(JSON.stringify({ menu: stock.item("appearance.font") ? "appearance.font" : "style.font" }))
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
        test.checkBarWidget()
        break
      case 23:
        test.capture(buttonStrip, "buttons")
        break
      case 24:
        test.setConfig({layout: {left: [{id: "foamy.menu", width: 360}]}})
        wrapper.open('{"menu":"root"}')
        break
      case 25:
        test.captureMenu("menu-root")
        break
      case 26:
        console.log("FOAMY RESULT " + test.checks + " checks")
        console.log("FOAMY DONE")
        Qt.quit()
      }
    }
  }
  // --- bar button ---------------------------------------------------------------------------------
  // A facade-like shell whose toggle() answers `toggleAnswer` (undefined = no toggle at all).
  QtObject {
    id: barShell
    property var toggles: []
    property var toggleAnswer: true
    function toggle(id, payload) {
      toggles = toggles.concat([{ id: id, payload: payload }])
      return toggleAnswer
    }
  }
  Harness.MockBar {
    id: mockBar
    property var runs: []
    function run(command) { runs = runs.concat([command]) }
  }
  FloatingWindow {
    implicitWidth: 200
    implicitHeight: mockBar.barSize
    color: mockBar.background
    Item {
      id: buttonStrip
      width: 200
      height: mockBar.barSize
      Foamy.BarWidget { id: glyphWidget; height: parent.height; bar: mockBar; settings: ({}) }
      Foamy.BarWidget { id: textWidget; x: 60; height: parent.height; bar: mockBar; settings: ({ icon: "Menu" }) }
    }
  }
  function checkBarWidget() {
    var button = glyphWidget.buttonItem
    test.check(glyphWidget.glyphIcon && button && "slotSize" in button, "a glyph icon uses the stock BarIconButton")
    test.check(glyphWidget.implicitWidth === button.slotSize, "the glyph button takes the stock icon slot")
    test.check(!textWidget.glyphIcon && !("slotSize" in textWidget.buttonItem) && textWidget.implicitWidth > glyphWidget.implicitWidth,
               "text icons use a WidgetButton that fits the text")
    mockBar.shell = barShell
    glyphWidget.activate(Qt.LeftButton)
    test.check(JSON.stringify(barShell.toggles) === JSON.stringify([{ id: "omarchy.menu", payload: '{"menu":"root"}' }])
               && mockBar.runs.length === 0, "left-click toggles the menu in-process through the facade")
    barShell.toggleAnswer = false
    glyphWidget.activate(Qt.LeftButton)
    test.check(JSON.stringify(mockBar.runs) === JSON.stringify(["omarchy-shell shell toggle omarchy.menu '{\"menu\":\"root\"}'"]),
               "a refused toggle falls back to the stock command")
    mockBar.runs = []
    mockBar.shell = null
    textWidget.activate(Qt.LeftButton)
    test.check(mockBar.runs.length === 1 && mockBar.runs[0].indexOf("omarchy-shell shell toggle omarchy.menu") === 0,
               "no facade falls back to the stock command")
    mockBar.runs = []
    glyphWidget.activate(Qt.RightButton)
    test.check(JSON.stringify(mockBar.runs) === JSON.stringify(["xdg-terminal-exec"]), "right-click opens the terminal")
  }

  Timer { interval: 60000; running: true; onTriggered: { console.log("FOAMY FAIL timeout at stage " + test.stage); Qt.exit(1) } }
}
