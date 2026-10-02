// Test stand-in for the host type of the same name: only the members Omniplug uses.
import QtQuick
Item { property var bar; property string text; property string tooltipText; signal pressed(int b)
  implicitWidth: 30; implicitHeight: 30; function syncClickRegistration() {} }
