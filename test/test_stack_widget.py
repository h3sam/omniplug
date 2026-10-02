"""Real QML runtime test of a stack on the bar (StackWidget.qml).

Loads the shipped StackWidget.qml, HostStage.qml, HostMount.qml,
HostingModel.js, Placement.js and StackMemory.js unchanged into a
test-owned directory beside FakeBarPort, with test stand-ins for the host's
qs.Commons, and drives a stack the way the bar does: a config in, cards
flipped, a wide card fanned out.
"""

from pathlib import Path
import json
import tempfile
import unittest

try:
    from PySide6.QtCore import QPoint, QUrl
    from PySide6.QtGui import QGuiApplication
    from PySide6.QtQml import QQmlComponent, QQmlEngine, QQmlExpression
    from PySide6.QtQuick import QQuickWindow
    from PySide6.QtTest import QTest
except ImportError:
    QGuiApplication = None


REPO = Path(__file__).resolve().parents[1]
SELF = "io.github.h3sam.omniplug"


def config(cards, disabled=(), width=160, dots=True, defined=True):
    plugins = [{"id": "acme.vpn", "color": "red"}, {"id": "acme.wide"}]
    if defined:
        plugins.insert(0, {"id": SELF, "stacks": {"s1": {"width": width, "dots": dots, "cards": cards}}})
    return {
        "version": 1,
        "bar": {"layout": {
            "left": ["omarchy.workspaces"],
            "center": [],
            "right": [{"id": SELF}, {"id": SELF, "stack": "s1"}],
        }},
        "plugins": plugins,
        "disabledPlugins": list(disabled),
    }


SCENE = """
import QtQuick

Item {
  id: scene
  width: 600
  height: 30
  property alias port: fakePort
  property var config: null
  property string screenName: "DP-1"

  QtObject {
    id: facade
    property var requested: []
    function requestPopout(owner) { requested = requested.concat([owner]) }
  }

  Item {
    id: ownerItem
    property var bar: facade
    function raiseOwnClickTargets() {}
  }

  QtObject { id: stranger; objectName: "stranger" }
  function popoutToStranger() { fakePort.activePopout = stranger }

  Component {
    id: widget
    Item {
      property var bar: null
      property string moduleName: ""
      property var settings: ({})
      property real naturalWidth: 20
      implicitWidth: naturalWidth
      implicitHeight: 30
    }
  }
  Component {
    id: wideWidget
    Item {
      property var bar: null
      property string moduleName: ""
      property var settings: ({})
      implicitWidth: 300
      implicitHeight: 30
    }
  }

  FakeBarPort {
    id: fakePort
    widgets: ({
      "omarchy.clock": { component: widget, metadata: { firstParty: true, displayName: "Clock" } },
      "acme.vpn": { component: widget, metadata: { firstParty: false, displayName: "VPN" } },
      "acme.wide": { component: wideWidget, metadata: { firstParty: false, displayName: "Wide" } }
    })
  }

  property var stack: null
  Component {
    id: stackComponent
    StackWidget {
      // Not `owner: owner`: inside StackWidget that binds the property to itself.
      owner: ownerItem
      port: fakePort
      config: scene.config
      selfId: "%s"
      sid: "s1"
      screenName: scene.screenName
    }
  }
  function makeStack() {
    if (scene.stack) scene.stack.destroy()
    scene.stack = stackComponent.createObject(scene)
    return scene.stack
  }

  function mountedIds() {
    var out = []
    var instances = scene.stack ? scene.stack.children : []
    function walk(item) {
      if (!item) return
      if (item.key !== undefined && item.instance !== undefined && item.live) out.push(item.key)
      for (var i = 0; i < item.children.length; i++) walk(item.children[i])
    }
    walk(scene.stack)
    return out
  }
}
""" % SELF


@unittest.skipIf(QGuiApplication is None, "PySide6 unavailable: no real QML runtime evidence")
class StackWidgetTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication([])

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="stack-widget-")
        fixture = Path(self.directory.name)
        for name in ("StackWidget.qml", "HostStage.qml", "HostMount.qml", "HostingModel.js",
                     "Placement.js", "StackMemory.js"):
            (fixture / name).write_bytes((REPO / name).read_bytes())
        (fixture / "FakeBarPort.qml").write_bytes((REPO / "test/qml/FakeBarPort.qml").read_bytes())
        (fixture / "Scene.qml").write_text(SCENE)
        self.engine = QQmlEngine()
        self.engine.addImportPath(str(REPO / "test/qml"))
        self.warnings = []
        self.engine.warnings.connect(lambda errors: self.warnings.extend(e.toString() for e in errors))
        self.component = QQmlComponent(self.engine, QUrl.fromLocalFile(str(fixture / "Scene.qml")))
        self.assertEqual(self.component.status(), QQmlComponent.Ready,
                         "\n".join(error.toString() for error in self.component.errors()))
        self.scene = self.component.create()
        QQmlEngine.setObjectOwnership(self.scene, QQmlEngine.ObjectOwnership.CppOwnership)
        # Positioners only lay out inside a window, as the bar's always is.
        self.window = QQuickWindow()
        self.window.resize(600, 30)
        self.scene.setParentItem(self.window.contentItem())
        self.window.show()
        QTest.qWaitForWindowExposed(self.window)

    def tearDown(self):
        self.window.hide()
        self.scene.deleteLater()
        self.app.sendPostedEvents(None, 0)
        self.app.processEvents()
        del self.scene, self.component, self.engine, self.window
        self.directory.cleanup()

    def js(self, expression):
        context = self.engine.contextForObject(self.scene)
        qml = QQmlExpression(context, self.scene, expression)
        result, _undefined = qml.evaluate()
        self.assertFalse(qml.hasError(), expression + ": " + qml.error().toString())
        return result

    def settle(self, ms=30):
        QTest.qWait(ms)
        self.app.processEvents()

    def make(self, cfg, screen="DP-1"):
        self.js("screenName = %s" % json.dumps(screen))
        self.js("config = %s" % json.dumps(cfg))
        self.js("makeStack()")
        # Keep the pointer off the stack: hovering is what fans it out. Two
        # moves, so the new window sees one even if the pointer was already here.
        QTest.mouseMove(self.window, QPoint(598, 28))
        QTest.mouseMove(self.window, QPoint(599, 29))
        self.settle(400)

    def test_it_shows_the_first_card_at_its_fixed_width_and_parks_the_rest(self):
        self.make(config([["omarchy.clock", "acme.vpn"], ["acme.wide"]]))
        self.assertEqual(self.js("stack.current"), 0)
        self.assertEqual(self.js("JSON.stringify(stack.card.map(s => s.id))"), '["omarchy.clock","acme.vpn"]')
        self.assertEqual(self.js("JSON.stringify(mountedIds())"), '["omarchy.clock#0","acme.vpn#0"]')
        self.assertEqual(self.js("stack.implicitWidth"), 160, "the fixed width, not the card's 40")
        self.assertEqual(self.js("stack.implicitHeight"), 30)
        # Every widget in every card runs; the one on the hidden card is parked.
        self.assertEqual(self.js("JSON.stringify(stack.children.length > 0)"), "true")
        self.assertEqual(self.js("port.attached_slots.length"), 3)
        self.assertEqual(self.warnings, [])

    def test_flipping_wraps_and_is_remembered_while_the_shell_runs(self):
        self.make(config([["omarchy.clock"], ["acme.vpn"], ["acme.wide"]]), screen="HDMI-A-1")
        self.js("stack.flip(-1)")
        self.settle()
        self.assertEqual(self.js("stack.current"), 2, "back from the first card is the last")
        self.assertEqual(self.js("JSON.stringify(mountedIds())"), '["acme.wide#0"]')
        self.js("stack.flip(1)")
        self.settle()
        self.assertEqual(self.js("stack.current"), 0)
        self.js("stack.flip(1)")
        self.settle()
        self.assertEqual(self.js("stack.current"), 1)
        # A bar rebuild makes a new stack; it comes back on the same card.
        self.js("makeStack()")
        self.settle()
        self.assertEqual(self.js("stack.current"), 1)
        self.assertEqual(self.js("JSON.stringify(mountedIds())"), '["acme.vpn#0"]')

    def test_a_wide_card_is_clipped_at_rest_and_fans_out_to_its_natural_width(self):
        self.make(config([["omarchy.clock"], ["acme.wide"]], width=100), screen="eDP-1")
        self.js("stack.flip(1)")
        self.settle()
        self.assertEqual(self.js("stack.wide"), True)
        self.assertEqual(self.js("stack.targetExtent"), 100)
        QTest.mouseMove(self.window, QPoint(50, 15))
        self.settle(250)
        self.assertEqual(self.js("stack.fanned"), True, "hovering fans a wide card out")
        self.assertEqual(self.js("stack.targetExtent"), 312, "the card plus the flip strip")
        self.assertEqual(self.js("stack.implicitWidth"), 312, "the bar slot grows, pushing neighbours aside")
        self.js("stack.flip(1)")
        self.settle(250)
        self.assertEqual(self.js("stack.targetExtent"), 100, "a narrow card never fans wider than the stack")
        QTest.mouseMove(self.window, QPoint(599, 29))
        self.settle(400)
        self.assertEqual(self.js("stack.fanned"), False, "leaving folds it back after a moment")

    def test_switched_off_widgets_are_hidden_and_an_emptied_card_skipped(self):
        self.make(config([["omarchy.clock", "acme.vpn"], ["acme.wide"]], disabled=["acme.wide"]), screen="X")
        self.assertEqual(self.js("stack.cards.length"), 1)
        self.assertEqual(self.js("JSON.stringify(stack.card.map(s => s.id))"), '["omarchy.clock","acme.vpn"]')

    def test_an_empty_or_undefined_stack_shows_a_small_marker(self):
        self.make(config([], defined=False), screen="Y")
        self.assertEqual(self.js("stack.cards.length"), 0)
        self.assertGreater(self.js("stack.implicitWidth"), 0)
        self.assertLess(self.js("stack.implicitWidth"), 160)

    def test_a_stack_never_touches_the_bars_popout(self):
        self.make(config([["omarchy.clock"]]), screen="Z")
        self.js("popoutToStranger()")
        self.settle()
        self.js("port.activePopout = null")
        self.settle()
        self.assertEqual(self.js("facade.requested.length"), 0, "no reclaiming: a stack is not a popout owner")

    def test_the_flip_strip_keeps_its_room_dims_until_hovered_and_flipping_slides(self):
        self.make(config([["omarchy.clock"], ["acme.vpn"], ["acme.wide"]]), screen="strip")
        strip = 'stack.children.find(c => c.objectName === "flipStrip")'
        self.assertEqual(self.js(strip + ".visible"), True)
        self.assertEqual(self.js(strip + ".width"), 12)
        self.assertEqual(self.js(strip + ".x"), 148, "at the trailing end of the 160 px stack")
        self.assertLess(self.js(strip + ".opacity"), 0.5, "dim at rest")
        QTest.mouseMove(self.window, QPoint(154, 15))
        self.settle(200)
        self.assertEqual(self.js(strip + ".opacity"), 1, "bright while hovered")
        self.js("stack.flip(1)")
        self.assertNotEqual(self.js("stack.slide"), 0, "the new card starts off to the side")
        self.settle(250)
        self.assertEqual(self.js("stack.slide"), 0)
        self.make(config([["omarchy.clock"]]), screen="single")
        self.assertEqual(self.js(strip + ".visible"), False, "one card has nothing to flip to")


if __name__ == "__main__":
    unittest.main()
