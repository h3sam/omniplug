pragma Singleton
import QtQuick
QtObject {
  readonly property QtObject bar: QtObject { readonly property int sizeHorizontal: 30 }
  readonly property QtObject font: QtObject { readonly property string family: "monospace"; readonly property int body: 13; readonly property int caption: 11; readonly property int icon: 14 }
  readonly property QtObject spacing: QtObject { readonly property int sm: 6; readonly property int lg: 12 }
  readonly property int gapsOut: 8
  readonly property int cornerRadius: 8
  function space(v) { return v }
}
