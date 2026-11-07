import QtQuick
import Quickshell
import qs.Commons
import "../core/Scopes.js" as Scopes

Item {
  id: row

  required property int index
  required property string rowKind
  required property string itemId
  required property string title
  required property string subtitle
  required property string glyph
  required property string glyphFont
  required property string iconName
  // A scope item's own icon (a file or an icon name) shows instead of the glyph.
  required property string image
  required property string typeLabel
  // A setting's value sits where other rows show their type, and reads as one.
  required property bool isSetting
  required property string alias
  required property bool checked
  required property bool disabled
  required property bool favorite
  required property string calcResult
  required property string calcContext

  property bool selected: false
  property bool imageFailed: false
  onImageChanged: row.imageFailed = false
  property var look: null
  property var appLibrary: null
  property real zoom: 1

  signal hovered(int index, var item, var mouse)
  signal clicked(int index)

  readonly property bool isSection: row.rowKind === "section"
  readonly property bool isCalculator: row.rowKind === "calculator"
  function px(v) { return Math.round(Style.space(v) * row.zoom) }

  width: ListView.view ? ListView.view.width : 0
  height: row.isSection ? (row.title ? px(30) : px(6)) : (row.isCalculator ? px(64) : px(42))

  // The inline calculator, one line: the expression (or rate, zone, "in 3
  // days") on the left, aligned to the top of the line; the answer large on
  // the right, aligned to its bottom.
  Loader {
    active: row.isCalculator
    anchors.fill: parent
    sourceComponent: Rectangle {
      anchors.fill: parent
      radius: Math.max(Style.cornerRadius, row.px(6))
      color: row.selected ? row.look.selectedBackground : Util.alpha(row.look.foreground, 0.04)
      border.width: 1
      border.color: Util.alpha(row.look.foreground, row.selected ? 0 : 0.08)

      Text {
        id: calcAnswer
        anchors.right: parent.right
        anchors.rightMargin: row.px(16)
        anchors.bottom: parent.bottom
        anchors.bottomMargin: row.px(10)
        // At most two thirds of the card; a long answer shrinks to fit.
        width: Math.min(implicitWidth, (parent.width - row.px(32)) * 2 / 3)
        horizontalAlignment: Text.AlignRight
        textFormat: Text.PlainText
        text: row.calcResult
        color: row.selected ? row.look.accent : row.look.foreground
        font.family: row.look.fontFamily
        font.pixelSize: Math.round(Style.font.heading * 1.8 * row.zoom)
        font.weight: Font.DemiBold
        fontSizeMode: Text.HorizontalFit
        minimumPixelSize: Math.round(Style.font.body * row.zoom)
        elide: Text.ElideLeft
      }
      Text {
        visible: row.calcContext.length > 0
        anchors.left: parent.left
        anchors.right: calcAnswer.left
        anchors.leftMargin: row.px(16)
        anchors.rightMargin: row.px(16)
        anchors.top: parent.top
        anchors.topMargin: row.px(12)
        textFormat: Text.PlainText
        text: row.calcContext
        color: row.look.foreground
        opacity: 0.6
        font.family: row.look.fontFamily
        font.pixelSize: Math.round(Style.font.heading * row.zoom)
        elide: Text.ElideRight
      }
    }
  }

  Text {
    visible: row.isSection && row.title.length > 0
    textFormat: Text.PlainText
    anchors.left: parent.left
    anchors.leftMargin: row.px(12)
    anchors.bottom: parent.bottom
    anchors.bottomMargin: row.px(6)
    text: row.title
    color: row.look.foreground
    opacity: 0.5
    font.family: row.look.fontFamily
    font.pixelSize: Math.round(Style.font.caption * row.zoom)
    font.weight: Font.DemiBold
  }

  Rectangle {
    visible: !row.isSection && !row.isCalculator
    anchors.fill: parent
    radius: Math.max(Style.cornerRadius, row.px(6))
    color: row.selected ? row.look.selectedBackground : "transparent"
    opacity: row.disabled ? 0.45 : 1

    Item {
      id: iconBox
      width: row.px(22)
      height: row.px(22)
      anchors.left: parent.left
      anchors.leftMargin: row.px(12)
      anchors.verticalCenter: parent.verticalCenter

      Image {
        id: rowIcon
        readonly property bool ownImage: row.image.length > 0 && !row.imageFailed
        readonly property string name: ownImage ? row.image : row.iconName
        anchors.fill: parent
        visible: name.length > 0 && (row.glyph.length === 0 || ownImage)
        fillMode: Image.PreserveAspectFit
        asynchronous: true
        sourceSize.width: width * Screen.devicePixelRatio
        sourceSize.height: height * Screen.devicePixelRatio
        source: !visible ? "" : (Scopes.imageUrl(name) || (row.appLibrary ? row.appLibrary.iconSource(name) : Quickshell.iconPath(name, "application-x-executable")))
        onStatusChanged: if (status === Image.Error && ownImage) row.imageFailed = true
      }

      Text {
        anchors.centerIn: parent
        visible: row.glyph.length > 0 && !rowIcon.visible
        textFormat: Text.PlainText
        text: row.glyph
        color: row.selected ? row.look.accent : row.look.foreground
        font.family: row.glyphFont || row.look.fontFamily
        font.pixelSize: row.glyphFont === "omarchy" ? row.px(14) : row.px(17)
      }
    }

    Row {
      id: accessories
      anchors.right: parent.right
      anchors.rightMargin: row.px(12)
      anchors.verticalCenter: parent.verticalCenter
      spacing: row.px(10)

      Rectangle {
        visible: row.alias.length > 0
        anchors.verticalCenter: parent.verticalCenter
        height: aliasText.implicitHeight + row.px(4)
        width: aliasText.implicitWidth + row.px(12)
        radius: row.px(4)
        color: "transparent"
        border.width: 1
        border.color: Util.alpha(row.look.foreground, 0.3)
        Text {
          id: aliasText
          anchors.centerIn: parent
          textFormat: Text.PlainText
          text: row.alias
          color: row.look.foreground
          opacity: 0.7
          font.family: row.look.fontFamily
          font.pixelSize: Math.round(Style.font.caption * row.zoom)
        }
      }

      Text {
        visible: row.favorite
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: "\uf005"
        color: row.look.accent
        opacity: 0.8
        font.family: row.look.fontFamily
        font.pixelSize: Math.round(Style.font.caption * row.zoom)
      }

      Text {
        visible: row.checked
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: "✓"
        color: row.look.accent
        font.family: row.look.fontFamily
        font.pixelSize: Math.round(Style.font.body * row.zoom)
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: row.typeLabel
        color: row.isSetting && row.selected ? row.look.accent : row.look.foreground
        opacity: row.isSetting ? 0.85 : 0.45
        font.family: row.look.fontFamily
        font.pixelSize: Math.round((row.isSetting ? Style.font.body : Style.font.bodySmall) * row.zoom)
      }
    }

    Row {
      anchors.left: iconBox.right
      anchors.leftMargin: row.px(10)
      anchors.right: accessories.left
      anchors.rightMargin: row.px(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: row.px(8)
      clip: true

      Text {
        id: titleText
        textFormat: Text.PlainText
        text: row.title
        color: row.look.foreground
        font.family: row.look.fontFamily
        font.pixelSize: Math.round(Style.font.title * row.zoom)
        elide: Text.ElideRight
        width: Math.min(implicitWidth, parent.width)
      }

      Text {
        textFormat: Text.PlainText
        text: row.subtitle
        visible: text.length > 0
        color: row.look.foreground
        opacity: 0.5
        font.family: row.look.fontFamily
        font.pixelSize: Math.round(Style.font.body * row.zoom)
        anchors.baseline: titleText.baseline
        elide: Text.ElideRight
        width: Math.max(0, Math.min(implicitWidth, parent.width - titleText.width - parent.spacing))
      }
    }
  }

  MouseArea {
    anchors.fill: parent
    enabled: !row.isSection
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onPositionChanged: function(mouse) { row.hovered(row.index, row, mouse) }
    onClicked: row.clicked(row.index)
  }
}
