import QtQuick
import qs.Commons
import qs.Ui

// The stock menu's bar button with a configurable icon. A single glyph uses
// the stock BarIconButton (the same slot, optical centring and press feedback
// as omarchy.menu); longer text needs room to grow, so it uses a WidgetButton.
BarWidget {
  id: root
  moduleName: "foamy.menu"

  readonly property string icon: String(setting("icon", "\u{f08c7}"))
  readonly property string iconFont: String(setting("iconFont", "")) || (bar ? bar.fontFamily : Style.font.family)
  // One code point (a Nerd Font glyph is a UTF-16 surrogate pair).
  readonly property bool glyphIcon: icon.length === 1
    || (icon.length === 2 && icon.charCodeAt(0) >= 0xd800 && icon.charCodeAt(0) <= 0xdbff)
  readonly property string rootPayload: '{"menu":"root"}'
  readonly property Item buttonItem: button.item

  implicitWidth: button.item ? button.item.implicitWidth : 0
  implicitHeight: button.item ? button.item.implicitHeight : 0

  // Left-click toggles the menu in-process through the plugin's shell facade:
  // foamy.menu owns omarchy.menu while it is the enabled menu clone, and both
  // 4.0.6 and 4.5 expose toggle(). An older host, a revoked facade or a
  // refusal falls back to the command the stock button runs.
  function toggleMenu() {
    var shell = bar ? bar.shell : null
    if (shell && typeof shell.toggle === "function" && shell.toggle("omarchy.menu", rootPayload) === true) return true
    if (bar) bar.run("omarchy-shell shell toggle omarchy.menu '" + rootPayload + "'")
    return false
  }

  function activate(mouseButton) {
    if (!bar) return
    if (mouseButton === Qt.RightButton) bar.run("xdg-terminal-exec")
    else toggleMenu()
  }

  Loader {
    id: button
    anchors.fill: parent
    sourceComponent: root.glyphIcon ? glyphButton : textButton
  }

  Component {
    id: glyphButton
    BarIconButton {
      bar: root.bar
      text: root.icon
      fontFamily: root.iconFont
      onPressed: function(mouseButton) { root.activate(mouseButton) }
    }
  }

  Component {
    id: textButton
    WidgetButton {
      bar: root.bar
      text: root.icon
      fontFamily: root.iconFont
      onPressed: function(mouseButton) { root.activate(mouseButton) }
    }
  }
}
