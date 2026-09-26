import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

Item {
  id: root

  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property string settingsPath: (Quickshell.env("XDG_CONFIG_HOME") || Quickshell.env("HOME") + "/.config") + "/omarchy/shell.json"
  property var barConfig: ({})
  property var manifest: null
  readonly property bool opened: menu.item ? menu.item.opened : false
  property var menuWindow: null
  property var menuSurface: null

  readonly property int configuredWidth: {
    var layout = root.barConfig.layout
    var sections = ["left", "center", "right"]
    for (var s = 0; layout && s < sections.length; s++) {
      var entries = layout[sections[s]] || []
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i]
        if (!entry || entry.id !== "foamy.menu" || entry.width === undefined) continue
        if (typeof entry.width === "number" && Number.isInteger(entry.width)
            && entry.width >= 0 && entry.width <= 4096) return entry.width
        console.warn("foamy.menu: width must be an integer from 0 to 4096; using 360")
        return 360
      }
    }
    return 360
  }

  // Read settings independently because a shell config reload can revoke the
  // plugin facade without reinjecting it into an already-loaded menu.
  FileView {
    path: root.settingsPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      try {
        var config = JSON.parse(text())
        root.barConfig = config && config.bar ? config.bar : ({})
      } catch (error) {
        console.warn("foamy.menu: cannot parse shell.json; keeping the last valid width: " + error)
      }
    }
    onLoadFailed: console.warn("foamy.menu: cannot read shell.json; keeping the last valid width")
  }

  function open(payloadJson) {
    if (!menu.item) throw new Error("foamy.menu: stock menu failed to load; check the shell log")
    menu.item.open(payloadJson)
  }
  function close() { if (menu.item) menu.item.close() }
  function refresh() { return menu.item ? menu.item.refresh() : "stock menu unavailable" }
  function ping() { return menu.item ? menu.item.ping() : "stock menu unavailable" }

  // Own the packaged engine: the shell's plugin facade can lose its library
  // during API reloads. No application-list or launch logic is copied here.
  Loader {
    id: localAppLibrary
    source: root.omarchyPath + "/shell/services/AppLibrary.qml"
  }
  QtObject {
    id: menuServices
    readonly property var appLibrary: localAppLibrary.item
  }

  Loader {
    id: menu
    active: localAppLibrary.status === Loader.Ready
    source: root.omarchyPath + "/shell/plugins/menu/Menu.qml"
    onLoaded: {
      item.shell = menuServices
      item.manifest = Qt.binding(function() { return root.manifest })

      // Change only the painted card width, retaining the stock width binding
      // as the minimum for special menus added by future Omarchy releases.
      for (var i = 0; i < item.data.length; i++) {
        var window = item.data[i]
        if (!(window instanceof PanelWindow)) continue
        for (var j = 0; j < window.contentItem.children.length; j++) {
          var surface = window.contentItem.children[j]
          if (!(surface instanceof BorderSurface)) continue
          root.menuWindow = window
          root.menuSurface = surface
          return
        }
      }
      console.error("foamy.menu: stock menu layout changed; using stock width. Update Foamy Menu.")
    }
    onStatusChanged: {
      if (status === Loader.Error)
        console.error("foamy.menu: cannot load " + source + "; check your Omarchy installation")
    }
  }

  Binding {
    target: root.menuSurface
    property: "width"
    when: root.menuSurface !== null && menu.item !== null
    value: {
      if (!menu.item || !root.menuWindow) return 0
      if (menu.item.dmenuActive || root.configuredWidth === 0) return menu.item.cardWidth
      return Math.min(Math.max(menu.item.cardWidth, Style.space(root.configuredWidth)),
                      Math.max(0, root.menuWindow.width - Style.gapsOut * 2))
    }
  }
}
