import QtQuick
import QtQuick.Effects
import Quickshell
import qs.Commons
import "../core/Scopes.js" as Scopes

// One cell of a grid: the Apps grid, or a scope laid out as one (Steam
// Games). A large icon over its name, as in Omarchy's own app grid, or with
// `covers` a portrait cover over the name. The selection marks the name (and
// rings the cover), not the whole cell.
Item {
  id: cell

  required property int index
  required property string title
  required property string iconName
  required property bool favorite
  // A scope item's own pictures (file paths or an icon name), and the icon
  // shown when it has none.
  required property string image
  required property string cover
  required property string fallbackIcon

  property bool selected: false
  property var look: null
  property var appLibrary: null
  property real zoom: 1
  property bool covers: false

  signal hovered(int index, var item, var mouse)
  signal clicked(int index)

  function px(v) {
    return Math.round(Style.space(v) * cell.zoom)
  }
  readonly property int iconSize: cell.px(52)
  readonly property int radius: Math.max(Style.cornerRadius, cell.px(6))

  function iconUrl(name) {
    return cell.appLibrary ? cell.appLibrary.iconSource(name) : Quickshell.iconPath(name, "application-x-executable")
  }
  // The item's own icon, unless it fails to load; then the scope's icon.
  property bool imageFailed: false
  onImageChanged: cell.imageFailed = false
  readonly property string iconSource: cell.image && !cell.imageFailed ? (Scopes.imageUrl(cell.image) || cell.iconUrl(cell.image)) : cell.iconUrl(cell.iconName || cell.fallbackIcon)
  // Cover art is cropped to the cell; without one (or when it fails to
  // load), the icon sits on the tile.
  readonly property bool hasCover: cell.cover.length > 0 && coverImage.status !== Image.Error
  readonly property int coverStatus: coverImage.status

  Image {
    id: icon
    visible: !cell.covers
    anchors.horizontalCenter: parent.horizontalCenter
    y: cell.px(12)
    width: cell.iconSize
    height: cell.iconSize
    sourceSize: Qt.size(cell.iconSize * 2, cell.iconSize * 2)
    source: cell.covers ? "" : cell.iconSource
    fillMode: Image.PreserveAspectFit
    asynchronous: true
    smooth: true
    mipmap: true
    onStatusChanged: if (status === Image.Error && cell.image)
      cell.imageFailed = true
  }

  Item {
    id: coverBox
    visible: cell.covers
    anchors.horizontalCenter: parent.horizontalCenter
    y: cell.px(8)
    width: Math.max(0, cell.width - cell.px(16))
    height: Math.round(width * 1.5)

    // Rounded through a shader mask; the software renderer has no shaders,
    // so there the cover keeps square corners rather than disappearing.
    readonly property bool rounded: cell.covers && coverBox.GraphicsInfo.api !== GraphicsInfo.Software

    Rectangle {
      id: coverMask
      anchors.fill: parent
      radius: cell.radius
      visible: false
      layer.enabled: coverBox.rounded
    }

    Item {
      anchors.fill: parent
      clip: true
      layer.enabled: coverBox.rounded
      layer.smooth: true
      layer.effect: MultiEffect {
        maskEnabled: true
        maskSource: coverMask
        maskThresholdMin: 0.5
        maskSpreadAtMin: 1.0
      }

      Rectangle {
        anchors.fill: parent
        color: Util.alpha(cell.look.foreground, 0.06)
      }

      Image {
        anchors.centerIn: parent
        visible: !cell.hasCover
        width: cell.iconSize
        height: cell.iconSize
        sourceSize: Qt.size(cell.iconSize * 2, cell.iconSize * 2)
        source: cell.covers && !cell.hasCover ? cell.iconSource : ""
        fillMode: Image.PreserveAspectFit
        asynchronous: true
        smooth: true
        mipmap: true
        onStatusChanged: if (status === Image.Error && cell.image)
          cell.imageFailed = true
      }

      Image {
        id: coverImage
        anchors.fill: parent
        source: cell.covers ? Scopes.imageUrl(cell.cover) : ""
        sourceSize.width: Math.ceil(coverBox.width * 2)
        fillMode: Image.PreserveAspectCrop
        asynchronous: true
        smooth: true
        mipmap: true
      }
    }

    Rectangle {
      anchors.fill: parent
      anchors.margins: -cell.px(3)
      radius: cell.radius + cell.px(3)
      color: "transparent"
      border.width: cell.px(2)
      border.color: cell.selected ? cell.look.accent : "transparent"
    }
  }

  Text {
    visible: cell.favorite
    anchors.right: cell.covers ? coverBox.right : icon.right
    anchors.top: cell.covers ? coverBox.top : icon.top
    anchors.rightMargin: -cell.px(6)
    anchors.topMargin: -cell.px(4)
    textFormat: Text.PlainText
    text: "★"
    color: cell.look.accent
    font.pixelSize: Math.round(Style.font.bodySmall * cell.zoom)
  }

  Rectangle {
    anchors.centerIn: label
    width: Math.min(cell.width - cell.px(8), label.contentWidth + cell.px(16))
    height: label.contentHeight + cell.px(6)
    radius: cell.radius
    color: cell.selected ? cell.look.selectedBackground : "transparent"
  }

  Text {
    id: label
    anchors.top: cell.covers ? coverBox.bottom : icon.bottom
    anchors.topMargin: cell.px(cell.covers ? 8 : 10)
    anchors.horizontalCenter: parent.horizontalCenter
    width: parent.width - cell.px(20)
    textFormat: Text.PlainText
    text: cell.title
    color: cell.selected ? cell.look.accent : cell.look.foreground
    font.family: cell.look.fontFamily
    font.pixelSize: Math.round(Style.font.body * cell.zoom)
    horizontalAlignment: Text.AlignHCenter
    wrapMode: Text.Wrap
    maximumLineCount: 2
    elide: Text.ElideRight
  }

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onPositionChanged: function (mouse) {
      cell.hovered(cell.index, cell, mouse)
    }
    onClicked: cell.clicked(cell.index)
  }
}
