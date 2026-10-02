// Test stand-in for the host type of the same name: only the members Omniplug uses.
import QtQuick
QtObject { property bool active: false; property Component component: null; property var item: null
  onActiveChanged: if (active && component && !item) item = component.createObject(null) }
