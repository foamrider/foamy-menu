import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

Item {
  id: root

  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  // The host always reads this path; it does not follow XDG_CONFIG_HOME.
  property string settingsPath: Quickshell.env("HOME") + "/.config/omarchy/shell.json"
  property var barConfig: ({})
  property var manifest: null
  property var shell: null
  readonly property var sharedAppLibrary: shell ? shell.appLibrary : null
  readonly property var appLibrary: sharedAppLibrary || localAppLibrary.item
  readonly property bool usingSharedAppLibrary: !!sharedAppLibrary
  readonly property bool opened: menu.item ? menu.item.opened : false
  property var menuWindow: null
  property var menuSurface: null

  // The first `width` set on a foamy.menu bar entry, unchecked (undefined if none).
  readonly property var configuredWidthSetting: {
    var layout = root.barConfig.layout
    var sections = ["left", "centerBegin", "center", "centerEnd", "tray", "right"]
    for (var s = 0; layout && s < sections.length; s++) {
      var entries = Array.isArray(layout[sections[s]]) ? layout[sections[s]] : []
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i]
        if (entry && entry.id === "foamy.menu" && entry.width !== undefined)
          return entry.width
      }
    }
    return undefined
  }
  readonly property int configuredWidth: validWidth(configuredWidthSetting) ? configuredWidthSetting : 360
  readonly property var configuredEntry: {
    var layout = root.barConfig.layout
    var sections = ["left", "centerBegin", "center", "centerEnd", "tray", "right"]
    for (var s = 0; layout && s < sections.length; s++) {
      var entries = Array.isArray(layout[sections[s]]) ? layout[sections[s]] : []
      for (var i = 0; i < entries.length; i++)
        if (entries[i] && entries[i].id === "foamy.menu")
          return entries[i]
    }
    return ({})
  }
  readonly property string brandIcon: String(configuredEntry.icon === undefined ? "\u{f08c7}" : configuredEntry.icon)
  readonly property string brandFont: String(configuredEntry.iconFont || "") || Style.font.family
  // The manifest's integer schema: a finite whole number from 0 to 4096.
  function validWidth(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4096
  }

  // Every config read re-evaluates the width; warn once per invalid value.
  property string reportedWidthSetting: ""
  onConfiguredWidthSettingChanged: reportWidthSetting()
  Component.onCompleted: reportWidthSetting()
  function reportWidthSetting() {
    var value = configuredWidthSetting
    var invalid = value !== undefined && !validWidth(value) ? typeof value + " " + String(value) : ""
    if (invalid && invalid !== reportedWidthSetting)
      console.warn("foamy.menu: width must be an integer from 0 to 4096; using 360")
    reportedWidthSetting = invalid
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

  function isWindow(object) {
    return !!object && typeof object === "object" && "contentItem" in object && "screen" in object && !!object.contentItem && "children" in object.contentItem
  }

  function open(payloadJson) {
    if (!menu.item)
      throw new Error("foamy.menu: stock menu failed to load; check the shell log")
    menu.item.open(payloadJson)
  }
  function close() {
    if (menu.item)
      menu.item.close()
  }
  function refresh() {
    return menu.item ? menu.item.refresh() : "stock menu unavailable"
  }
  function ping() {
    return menu.item ? menu.item.ping() : "stock menu unavailable"
  }

  // Reuse the host library. A revoked facade needs a packaged fallback until reinjection.
  Loader {
    id: localAppLibrary
    active: !root.usingSharedAppLibrary
    source: root.omarchyPath + "/shell/services/AppLibrary.qml"
  }
  QtObject {
    id: menuServices
    readonly property var appLibrary: root.sharedAppLibrary || localAppLibrary.item

    function summon(id, payloadJson) {
      // A missing or revoked facade must leave the stock command fallback available.
      if (!root.shell || typeof root.shell.summon !== "function")
        return false
      return root.shell.summon(id, payloadJson)
    }
  }

  Loader {
    id: menu
    active: menuServices.appLibrary !== null
    source: root.omarchyPath + "/shell/plugins/menu/Menu.qml"
    onLoaded: {
      item.shell = menuServices
      item.manifest = Qt.binding(function () {
        return root.manifest
      })

      // Change only the painted card width, retaining the stock width binding
      // as the minimum for special menus added by future Omarchy releases.
      // The card is a BorderSurface directly inside the menu's window, an
      // OverlayWindow (a PanelWindow). Any window type is accepted, so a new
      // overlay base doesn't break it.
      for (var i = 0; i < item.data.length; i++) {
        var window = item.data[i]
        if (!root.isWindow(window))
          continue
        for (var j = 0; j < window.contentItem.children.length; j++) {
          var surface = window.contentItem.children[j]
          if (!(surface instanceof BorderSurface))
            continue
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
      if (!menu.item || !root.menuWindow)
        return 0
      if (menu.item.dmenuActive || root.configuredWidth === 0)
        return menu.item.cardWidth
      return Math.min(Math.max(menu.item.cardWidth, Style.space(root.configuredWidth)), Math.max(0, root.menuWindow.width - Style.gapsOut * 2))
    }
  }
}
