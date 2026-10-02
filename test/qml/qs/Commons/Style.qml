pragma Singleton
import QtQuick

// Test stand-in for the host's qs.Commons Style: only what Omniplug's
// runtime-tested files read.
QtObject {
  readonly property QtObject bar: QtObject { readonly property int sizeHorizontal: 30 }
  readonly property QtObject font: QtObject {
    readonly property string family: "monospace"
    readonly property int body: 13
    readonly property int caption: 11
  }
  function space(value) { return value }
}
