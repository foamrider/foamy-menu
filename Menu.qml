import QtQuick
import Quickshell

// Keep the stock route contract for Omarchy scripts; only root launch changes.
Item {
  id: root
  property var shell: null
  property var manifest: null
  property string settingsPath: Quickshell.env("HOME") + "/.config/omarchy/shell.json"
  readonly property bool opened: launcher.opened || stock.opened
  readonly property alias launcherItem: launcher
  readonly property alias stockMenu: stock

  function open(payloadJson) {
    var payload = JSON.parse(payloadJson || "{}")
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("foamy.menu: expected a menu payload object")
    if (payload.mode || payload.foamyStock === true || (payload.menu && payload.menu !== "root")) {
      launcher.close()
      stock.open(payloadJson)
      return
    }
    stock.close()
    launcher.open(payloadJson)
  }
  function close() {
    launcher.close()
    stock.close()
  }
  function refresh() {
    launcher.backendApi.rebuildCandidates()
    return stock.refresh()
  }
  function ping() {
    return "ok"
  }

  StockMenu {
    id: stock
    shell: root.shell
    manifest: root.manifest
    settingsPath: root.settingsPath
  }
  QtObject {
    id: launcherServices
    function summon(id, payloadJson) {
      if (id === "omarchy.menu") {
        // The action closes the launcher after dispatch. Open the stock menu
        // next turn so that close cannot dismiss the dialog we just opened.
        var payload = JSON.parse(payloadJson || "{}")
        payload.foamyStock = true
        Qt.callLater(function () {
          var encoded = JSON.stringify(payload)
          if (root.shell && typeof root.shell.summon === "function" && root.shell.summon("foamy.menu", encoded))
            return
          root.open(encoded)
        })
        return true
      }
      if (id === "foamy.menu") {
        if (root.shell && typeof root.shell.summon === "function" && root.shell.summon(id, payloadJson))
          return true
        root.open(payloadJson)
        return true
      }
      return root.shell && typeof root.shell.summon === "function" ? root.shell.summon(id, payloadJson) : false
    }
    function hide(id) {
      if (id !== "foamy.menu")
        return false
      if (root.shell && typeof root.shell.hide === "function" && root.shell.hide(id))
        return true
      launcher.close()
      return true
    }
  }
  Launcher {
    id: launcher
    shell: launcherServices
    manifest: root.manifest
    appLibrary: stock.appLibrary
    brandIcon: stock.brandIcon
    brandFont: stock.brandFont
    minimumWidth: stock.configuredWidth
    // The foamy.menu entry in shell.json: every launcher setting lives there.
    settingsEntry: stock.configuredEntry
    hostShell: root.shell
  }
}
