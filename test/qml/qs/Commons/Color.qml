pragma Singleton
import QtQuick
QtObject {
  readonly property color foreground: "#ccc"; readonly property color accent: "#ccc"; readonly property color urgent: "#a55"
  readonly property QtObject popups: QtObject { readonly property color text: "#ccc"; readonly property color background: "#111"; readonly property color border: "#333" }
  readonly property QtObject tooltip: QtObject { readonly property color text: "#ccc"; readonly property color background: "#111"; readonly property color border: "#333" }
}
