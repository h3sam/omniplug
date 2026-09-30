"""Real QML runtime test of HostStage and HostMount against FakeBarPort.

Loads the shipped HostStage.qml, HostMount.qml and HostingModel.js unchanged
into a test-owned directory beside the fake port, and drives them the way the
drawer will: entries in, mounts in a view, the bar's popout moving about.
"""

from pathlib import Path
import tempfile
import unittest

try:
    from PySide6.QtCore import QUrl
    from PySide6.QtGui import QGuiApplication
    from PySide6.QtQml import QQmlComponent, QQmlEngine, QQmlExpression
    from PySide6.QtTest import QTest
except ImportError:
    QGuiApplication = None


REPO = Path(__file__).resolve().parents[1]
SELF = "io.github.h3sam.omniplug"

SCENE = """
import QtQuick

Item {
  id: scene
  width: 400
  height: 100
  property alias stage: hostStage
  property alias port: port
  property int dismissals: 0

  QtObject {
    id: facade
    property var requested: []
    function requestPopout(owner) { requested = requested.concat([owner]) }
  }

  Item {
    id: owner
    property var bar: facade
    property int raised: 0
    function raiseOwnClickTargets() { raised++ }
  }

  QtObject { id: stranger; objectName: "stranger" }

  function mountFor(key) {
    for (var i = 0; i < view.children.length; i++) {
      if (view.children[i].key === key) return view.children[i]
    }
    return null
  }

  Component {
    id: widget
    Item {
      property var bar: null
      property string moduleName: ""
      property var settings: ({})
      property bool opened: false
      property int closes: 0
      function close() { opened = false; closes++ }
      implicitWidth: 20
      implicitHeight: 10
    }
  }

  FakeBarPort {
    id: port
    property var log: []
    widgets: ({
      "omarchy.clock": { component: widget, metadata: { firstParty: true, displayName: "Clock" } },
      "acme.vpn": { component: widget, metadata: { firstParty: false, displayName: "VPN" } }
    })
    function attachProxy(slot) {
      log = log.concat(["attach:" + slot.moduleName])
      attached_slots = attached_slots.concat([slot])
      return true
    }
    function barFor(id) {
      log = log.concat(["bar:" + id])
      barForCalls = barForCalls.concat([String(id)])
      if (firstParty(id)) return barRoot
      var key = String(id) + "@" + facadeGeneration
      if (!facadeObjects[key]) {
        var next = {}
        for (var k in facadeObjects) next[k] = facadeObjects[k]
        next[key] = facadeObject.createObject(port, { pluginId: String(id), generation: facadeGeneration })
        facadeObjects = next
      }
      return facadeObjects[key]
    }
  }

  Component {
    id: facadeObject
    QtObject { property string pluginId: ""; property int generation: 0 }
  }

  HostStage {
    id: hostStage
    owner: owner
    port: port
    selfId: "%s"
    graceInterval: 50
    onDismissRequested: scene.dismissals++
  }

  Row {
    id: view
    Repeater {
      model: hostStage.tiles
      HostMount {
        required property var modelData
        stage: hostStage
        key: modelData.key
      }
    }
  }
}
""" % SELF


@unittest.skipIf(QGuiApplication is None, "PySide6 unavailable: no real QML runtime evidence")
class HostStageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication([])

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="host-stage-")
        fixture = Path(self.directory.name)
        for name in ("HostStage.qml", "HostMount.qml", "HostingModel.js"):
            (fixture / name).write_bytes((REPO / name).read_bytes())
        (fixture / "FakeBarPort.qml").write_bytes((REPO / "test/qml/FakeBarPort.qml").read_bytes())
        (fixture / "Scene.qml").write_text(SCENE)
        self.engine = QQmlEngine()
        self.warnings = []
        self.engine.warnings.connect(lambda errors: self.warnings.extend(e.toString() for e in errors))
        self.component = QQmlComponent(self.engine, QUrl.fromLocalFile(str(fixture / "Scene.qml")))
        self.assertEqual(self.component.status(), QQmlComponent.Ready,
                         "\n".join(error.toString() for error in self.component.errors()))
        self.scene = self.component.create()
        self.assertIsNotNone(self.scene)
        QQmlEngine.setObjectOwnership(self.scene, QQmlEngine.ObjectOwnership.CppOwnership)

    def tearDown(self):
        self.scene.deleteLater()
        self.app.sendPostedEvents(None, 0)
        self.app.processEvents()
        del self.scene, self.component, self.engine
        self.directory.cleanup()

    def js(self, expression):
        context = self.engine.contextForObject(self.scene)
        qml = QQmlExpression(context, self.scene, expression)
        result, _undefined = qml.evaluate()
        self.assertFalse(qml.hasError(), expression + ": " + qml.error().toString())
        return result

    def settle(self, ms=20):
        for _ in range(5):
            self.app.processEvents()
            QTest.qWait(ms // 5 or 1)

    def entries(self, js_array):
        self.js("stage.entries = " + js_array)
        self.settle()

    def test_widgets_are_injected_like_the_bar_does_it(self):
        self.entries('[{id:"omarchy.clock", name:"Clock", settings:{format:"24h"}, state:"live"},'
                     ' {id:"acme.vpn", settings:{color:"red"}, state:"live"}]')
        self.assertEqual(self.js("stage.tiles.map(t => t.key + '=' + t.state).join()"),
                         "omarchy.clock#0=live,acme.vpn#0=live")
        self.assertEqual(self.js("stage.instanceFor('omarchy.clock#0').item.bar.objectName"), "barRoot")
        self.assertEqual(self.js("stage.instanceFor('acme.vpn#0').item.bar.pluginId"), "acme.vpn")
        self.assertEqual(self.js("stage.instanceFor('acme.vpn#0').item.moduleName"), "acme.vpn")
        self.assertEqual(self.js("JSON.stringify(stage.instanceFor('omarchy.clock#0').item.settings)"),
                         '{"format":"24h"}')
        self.assertEqual(self.js("stage.tiles[1].name"), "VPN", "the registry names a nameless entry")
        log = self.js("port.log.join()").split(",")
        self.assertLess(log.index("attach:acme.vpn"), log.index("bar:acme.vpn"),
                        "the proxy slot is registered before the facade is asked for")
        self.assertGreaterEqual(self.js("owner.raised"), 1, "our own icon is raised above hosted targets")
        self.assertEqual(self.warnings, [])

    def test_reorders_and_settings_edits_never_restart_a_widget(self):
        self.entries('[{id:"omarchy.clock", settings:{format:"24h"}}, {id:"acme.vpn"}]')
        self.js("stage.instanceFor('omarchy.clock#0').item.objectName = 'original-clock'")
        self.js("stage.instanceFor('acme.vpn#0').item.objectName = 'original-vpn'")
        self.entries('[{id:"acme.vpn"}, {id:"omarchy.clock", settings:{format:"12h"}}]')
        self.assertEqual(self.js("stage.instanceFor('omarchy.clock#0').item.objectName"), "original-clock")
        self.assertEqual(self.js("stage.instanceFor('acme.vpn#0').item.objectName"), "original-vpn")
        self.assertEqual(self.js("stage.instanceFor('omarchy.clock#0').item.settings.format"), "12h")
        self.assertEqual(self.js("stage.tiles.map(t => t.id).join()"), "acme.vpn,omarchy.clock")
        self.assertEqual(self.warnings, [])

    def test_mounts_borrow_the_instance_and_only_show_it_while_shown(self):
        self.entries('[{id:"acme.vpn"}]')
        self.assertEqual(self.js("stage.instanceFor('acme.vpn#0').parent === scene.mountFor('acme.vpn#0')"), True)
        self.assertEqual(self.js("stage.instanceFor('acme.vpn#0').visible"), False)
        self.js("stage.shown = true")
        self.settle()
        self.assertEqual(self.js("stage.instanceFor('acme.vpn#0').visible"), True)
        self.assertEqual(self.js("scene.mountFor('acme.vpn#0').implicitWidth"), 20)
        # A second mount for the same key stays empty.
        self.assertEqual(self.js("stage.mount('acme.vpn#0', stage)"), False)

    def test_placeholders_say_why_and_only_after_the_grace_period(self):
        self.entries('[{id:"ghost.widget", state:"live"}, {id:"acme.vpn", state:"off"},'
                     ' {id:"gone.widget", state:"missing"}, {id:"%s"}]' % SELF)
        self.assertEqual(self.js("stage.tiles[1].state + ':' + stage.tiles[1].reason"), "missing:disabled")
        self.assertEqual(self.js("stage.tiles[2].reason"), "not-installed")
        self.assertEqual(self.js("stage.tiles[3].state + ':' + stage.tiles[3].reason"), "refused:self")
        QTest.qWait(80)
        self.settle()
        self.assertEqual(self.js("stage.tiles[0].state + ':' + stage.tiles[0].reason"), "missing:not-registered")
        self.assertEqual(self.js("scene.mountFor('ghost.widget#0').placeholder"), True)
        self.assertEqual(self.js("stage.instanceFor('acme.vpn#0').item"), None, "an off widget is not loaded")

    def test_popouts_keep_the_drawer_for_its_own_widgets_and_dismiss_it_otherwise(self):
        self.entries('[{id:"acme.vpn"}]')
        self.js("stage.shown = true")
        self.js("stage.instanceFor('acme.vpn#0').item.opened = true")
        self.assertEqual(self.js("stage.deferPopoutSwitch()"), True)
        self.js("port.activePopout = stage.instanceFor('acme.vpn#0').item")
        self.settle()
        self.assertEqual(self.js("scene.dismissals"), 0)
        self.assertEqual(self.js("stage.childPanelOpen"), True)

        self.js("port.activePopout = null")
        self.settle()
        self.assertEqual(self.js("facade.requested.length > 0 && facade.requested[facade.requested.length - 1] === owner"),
                         True, "an empty popout is reclaimed for the drawer")

        self.js("port.activePopout = stage.instanceFor('acme.vpn#0').item")
        self.settle()
        self.js("stage.shown = false")
        self.settle()
        self.assertEqual(self.js("stage.instanceFor('acme.vpn#0').item.closes"), 1,
                         "hiding the drawer closes its widget's panel")

        self.js("stage.shown = true")
        self.js("port.activePopout = stranger")
        self.settle()
        self.assertEqual(self.js("scene.dismissals"), 1)
        self.js("stage.shown = false")
        self.assertEqual(self.js("stage.deferPopoutSwitch()"), False, "a hidden drawer defers nothing")

    def test_pruned_facades_are_replaced_and_removed_entries_let_go(self):
        self.entries('[{id:"acme.vpn"}, {id:"omarchy.clock"}]')
        self.assertEqual(self.js("stage.instanceFor('acme.vpn#0').item.bar.generation"), 0)
        self.js("port.pruneFacades()")
        self.settle()
        self.assertEqual(self.js("stage.instanceFor('acme.vpn#0').item.bar.generation"), 1)
        self.assertEqual(self.js("port.attached_slots.length"), 2)
        self.entries('[{id:"omarchy.clock"}]')
        self.assertEqual(self.js("stage.instanceFor('acme.vpn#0')"), None)
        self.assertEqual(self.js("port.attached_slots.length"), 1)
        self.assertEqual(self.js("stage.tiles.length"), 1)


if __name__ == "__main__":
    unittest.main()
