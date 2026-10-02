import QtQuick

// Test stand-in for the host's qs.Ui BarWidget: the three injected
// properties and what Omniplug reads off the base.
Item {
  property QtObject bar: null
  property string moduleName: ""
  property var settings: ({})
  readonly property bool vertical: bar ? bar.vertical === true : false
  function broadcast(method) {}
}
