import QtQuick
import Quickshell
import Quickshell.Hyprland
import qs.Commons
import "ui"
import "kit"

Item {
  id: root

  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property var shell: null
  property var manifest: null
  property var appLibrary: null
  property string brandIcon: "\u{f08c7}"
  property string brandFont: Style.font.family
  property int minimumWidth: 0
  property var settingsEntry: ({})
  property var hostShell: null
  readonly property alias backendApi: backend
  readonly property alias window: launcher

  readonly property string pluginId: (root.manifest && root.manifest.id) || "foamy.menu"

  property bool opened: false
  property double openedAt: 0

  function open(payloadJson) {
    var payload = ({})
    try {
      payload = JSON.parse(payloadJson || "{}")
    } catch (e) {
      payload = ({})
    }
    var wasOpen = root.opened
    root.opened = true
    root.openedAt = Date.now()
    launcher.prepare(payload)
    if (!wasOpen)
      backend.emit("window.visibilityChanged", {
        visible: true
      })
  }

  function close() {
    if (!root.opened)
      return
    root.opened = false
    backend.emit("window.visibilityChanged", {
      visible: false
    })
  }

  function show() {
    if (root.opened)
      return
    if (root.shell && root.shell.summon(root.pluginId, "{}"))
      return
    root.open("{}")
  }

  function hide() {
    if (!root.opened)
      return
    if (root.shell && root.shell.hide(root.pluginId)) {
      root.close()
      return
    }
    root.close()
  }

  function toggle() {
    if (root.opened)
      root.hide()
    else
      root.show()
  }

  function run(commandId) {
    // `foamy-menu run` is explicit, so it skips the confirmation alert.
    var r = backend.callSync("rootSearch.performAction", {
      id: commandId,
      action: "open",
      query: "",
      confirmed: true
    })
    if (!r.ok)
      return r
    var outcome = r.data || {}
    if (outcome.push) {
      root.show()
      launcher.popToRoot()
      launcher.push(outcome.push)
    } else if (outcome.close) {
      root.hide()
      if (outcome.hud)
        launcher.hud(outcome.hud)
    }
    return r
  }

  Backend {
    id: backend
    version: (root.manifest && root.manifest.version) || ""
    appLibrary: root.appLibrary
    settingsEntry: root.settingsEntry
    hostShell: root.hostShell
    summon: function (id, payload) {
      return root.shell ? root.shell.summon(id, payload) : false
    }
  }

  LauncherWindow {
    id: launcher
    brandIcon: root.brandIcon
    brandFont: root.brandFont
    minimumWidth: root.minimumWidth
    shown: root.opened
    backend: backend
    appLibrary: backend.appLibrary
    onDismissRequested: root.hide()
  }

  GlobalShortcut {
    appid: "foamy-menu"
    name: "toggle"
    description: "Toggle foamy-menu"
    onPressed: root.toggle()
  }

  // An IpcHandler that also answers `omarchy-shell foamy-menu …` over the
  // 4.5 shell socket.
  FoamyIpc {
    target: "foamy-menu"

    function toggle(): string {
      root.toggle()
      return root.opened ? "shown" : "hidden"
    }

    function show(): string {
      root.show()
      return "shown"
    }

    function hide(): string {
      root.hide()
      return "hidden"
    }

    function isOpen(): string {
      return root.opened ? "true" : "false"
    }

    function ping(): string {
      return "ok"
    }

    function run(commandId: string): string {
      return JSON.stringify(root.run(commandId))
    }

    function call(method: string, dataJson: string): string {
      var data = null
      if (dataJson && dataJson.length > 0) {
        try {
          data = JSON.parse(dataJson)
        } catch (e) {
          return JSON.stringify({
            ok: false,
            error: "data is not JSON: " + e
          })
        }
      }
      return JSON.stringify(backend.callSync(method, data))
    }
  }
}
