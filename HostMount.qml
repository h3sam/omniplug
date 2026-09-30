import QtQuick
import "HostingModel.js" as HostingModel

// Where a view shows one hosted widget: it borrows the live instance from the
// HostStage (see HostStage.qml) and sizes itself to it, or draws the
// placeholder when the widget is missing, off, or failed to load.
Item {
  id: mount

  // Pass the stage by a name that is not `stage` in the caller's scope:
  // `stage: stage` binds this property to itself.
  required property var stage
  required property string key
  // Colours and font for the placeholder; the view passes its own.
  property color foreground: "white"
  property color secondaryForeground: "gray"
  property string fontFamily: ""
  property int fontSize: 13

  readonly property var instance: stage ? stage.instanceFor(key) : null
  readonly property var tile: {
    var tiles = stage ? stage.tiles : []
    for (var i = 0; i < tiles.length; i++) if (tiles[i].key === key) return tiles[i]
    return null
  }
  readonly property bool live: !!instance && instance.mountPoint === mount && instance.item !== null
  readonly property bool placeholder: !!tile && tile.state !== "live" && tile.state !== "waiting"
  readonly property string reasonText: tile ? HostingModel.hostingReasonText(tile.reason) : ""
  readonly property bool hovered: hover.hovered

  implicitWidth: live ? instance.implicitWidth : placeholder ? label.implicitWidth : 0
  implicitHeight: live ? instance.implicitHeight : placeholder ? label.implicitHeight : 0

  function claim() {
    if (stage && key !== "") stage.mount(key, mount)
  }

  onInstanceChanged: claim()
  onKeyChanged: claim()
  Component.onCompleted: claim()
  Component.onDestruction: if (stage) stage.unmount(key, mount)

  // A view that rebuilds its mounts can create the new one before the old one
  // lets go; claim again as soon as the instance is free.
  Connections {
    target: mount.instance
    ignoreUnknownSignals: true
    function onMountPointChanged() { if (mount.instance && !mount.instance.mountPoint) mount.claim() }
  }

  HoverHandler { id: hover }

  Text {
    id: label
    visible: mount.placeholder
    anchors.centerIn: parent
    textFormat: Text.PlainText
    text: "⚠ " + (mount.tile ? mount.tile.name : mount.key)
    color: mount.tile && mount.tile.reason === "disabled" ? mount.secondaryForeground : mount.foreground
    font.family: mount.fontFamily
    font.pixelSize: mount.fontSize
    leftPadding: 6
    rightPadding: 6
    topPadding: 4
    bottomPadding: 4
  }
}
