// Test stand-in for the host type of the same name: only the members Omniplug uses.
import QtQuick
Item { property string text; property string iconText; property string tooltipText; property bool selected
  property color foreground; property string fontFamily; signal clicked(); implicitWidth: 40; implicitHeight: 20 }
