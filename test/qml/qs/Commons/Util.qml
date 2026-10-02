pragma Singleton
import QtQuick

// Test stand-in for the host's qs.Commons Util.
QtObject {
  function alpha(color, value) { return Qt.rgba(color.r, color.g, color.b, value) }
}
