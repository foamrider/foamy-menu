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
  function setConfig(bar) { settingsFixture.setText(JSON.stringify({version: 1, bar: bar})) }
  FileView {
    id: fixture
    path: Qt.resolvedUrl("menu.jsonc").toString().replace("file://", "")
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
      switch (test.stage++) {
      case 0:
        test.check(stock && wrapper.menuSurface, "loads the installed stock menu")
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
        stock.userMenuPath = fixture.path
        fixture.setText('{"foamy-test":{"label":"Foamy test entry","action":"true"}}')
        break
      case 11:
        test.check(stock.item("foamy-test") !== null, "new entry appears through stock file watcher")
        fixture.setText('{}')
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
        console.log("RESULT: " + test.checks + " integration checks passed")
        Qt.quit()
      }
    }
  }
  Timer { interval: 15000; running: true; onTriggered: { console.error("FAIL: timeout"); Qt.exit(1) } }
}
