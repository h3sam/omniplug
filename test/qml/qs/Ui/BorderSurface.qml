// Test stand-in for the host type of the same name: only the members Omniplug uses.
import QtQuick
Rectangle { property var borderSpec; property real padding: 4
  readonly property real contentLeftInset: padding; readonly property real contentRightInset: padding
  readonly property real contentTopInset: padding; readonly property real contentBottomInset: padding }
