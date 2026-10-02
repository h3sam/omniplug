// Test stand-in for the host type of the same name: only the members Omniplug uses.
import QtQuick
QtObject {
  default property list<QtObject> data
  property var screen: null; property color color: "transparent"; property var mask: null
  property bool visible: false; property real width: 0; property real height: 0
  property real implicitWidth: 0; property real implicitHeight: 0
  property WindowAnchors anchors: WindowAnchors {}
  property Item contentItem: null
}
