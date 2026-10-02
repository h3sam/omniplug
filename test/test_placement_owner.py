"""Real QML runtime test of PlacementOwner against FakeShellConfig.

The shipped PlacementOwner.qml, Placement.js, PopupBridge.js and
LiveShellConfig.qml (constructed but swapped out) run unchanged; only the
config port is the in-memory fake.
"""

import json
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

CONFIG = {
    "version": 1,
    "bar": {"layout": {
        "left": ["omarchy.workspaces", {"id": "acme.vpn", "color": "red"}],
        "center": ["omarchy.clock"],
        "right": ["omarchy.tray", {"id": SELF, "allowUnverifiedUpdates": True}, {"id": SELF, "stack": "s1"}],
    }},
    "plugins": [{"id": SELF, "stacks": {"s1": {"width": 160, "dots": True, "cards": [["omarchy.battery"]]}}}],
    "disabledPlugins": [],
}

SCENE = """
import QtQuick

Item {
  id: scene
  property alias owner: placementOwner
  property alias port: fakePort

  QtObject {
    id: facade
    property var barConfig: null
    function updateEntryInline(id, settings) { return true }
  }

  FakeShellConfig { id: fakePort; facadeShell: facade }

  PlacementOwner {
    id: placementOwner
    selfId: "%s"
    facadeShell: facade
    port: fakePort
    confirmInterval: 100
    facts: ({
      "omarchy.workspaces": { name: "Workspaces", kinds: ["bar-widget"], firstParty: true },
      "omarchy.clock": { name: "Clock", kinds: ["bar-widget"], firstParty: true },
      "omarchy.tray": { name: "Tray", kinds: ["bar-widget"], firstParty: true },
      "omarchy.battery": { name: "Battery", kinds: ["bar-widget"], firstParty: true },
      "acme.vpn": { name: "VPN", kinds: ["bar-widget"], firstParty: false },
      "%s": { name: "Omniplug", kinds: ["bar-widget", "panel"], firstParty: false }
    })
  }
}
""" % (SELF, SELF)


@unittest.skipIf(QGuiApplication is None, "PySide6 unavailable: no real QML runtime evidence")
class PlacementOwnerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication([])

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="placement-owner-")
        fixture = Path(self.directory.name)
        for name in ("PlacementOwner.qml", "Placement.js", "PopupBridge.js", "LiveShellConfig.qml", "HostingModel.js"):
            (fixture / name).write_bytes((REPO / name).read_bytes())
        (fixture / "FakeShellConfig.qml").write_bytes((REPO / "test/qml/FakeShellConfig.qml").read_bytes())
        (fixture / "Scene.qml").write_text(SCENE)
        self.engine = QQmlEngine()
        self.warnings = []
        self.engine.warnings.connect(lambda errors: self.warnings.extend(e.toString() for e in errors))
        self.component = QQmlComponent(self.engine, QUrl.fromLocalFile(str(fixture / "Scene.qml")))
        self.assertEqual(self.component.status(), QQmlComponent.Ready,
                         "\n".join(error.toString() for error in self.component.errors()))
        self.scene = self.component.create()
        QQmlEngine.setObjectOwnership(self.scene, QQmlEngine.ObjectOwnership.CppOwnership)
        self.js("port.config = " + json.dumps(CONFIG))
        self.app.processEvents()

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

    def cards(self):
        return self.js('JSON.stringify(port.config.plugins.find(e => e.id === "%s").stacks.s1.cards)' % SELF)

    def into_stack(self, extra=""):
        return 'owner.request({id: "acme.vpn", to: "stack", stack: "s1", card: 0%s})' % extra

    def test_stacking_goes_through_the_writer_and_lands(self):
        key = self.js("owner.board.key")
        ticket = self.js("JSON.stringify(%s)" % self.into_stack(
            ', gap: 0, from: {zone: "left", index: 1}, key: %s' % json.dumps(key)))
        self.assertEqual(json.loads(ticket)["phase"], "landed", ticket)
        self.assertEqual(self.cards(), '[["acme.vpn","omarchy.battery"]]')
        self.assertIn('{"id":"acme.vpn","color":"red"}', self.js("JSON.stringify(port.config.plugins)"))
        self.assertEqual(self.js("port.writes.join()"), "config")
        self.assertEqual(self.js("owner.board.byId['acme.vpn'].zone"), "stack")
        self.assertIn("Put VPN in a stack", self.js("owner.ticket.note"))
        self.assertEqual(self.warnings, [])

    def test_stack_settings_and_card_moves_leave_the_layout_alone(self):
        self.js(self.into_stack())
        layout = self.js("JSON.stringify(port.config.bar.layout)")
        ticket = json.loads(self.js('JSON.stringify(owner.request({id: "acme.vpn", to: "stack", stack: "s1", card: 1}))'))
        self.assertEqual(ticket["phase"], "landed")
        self.assertEqual(ticket["touched"], ["plugins"])
        self.assertEqual(self.cards(), '[["omarchy.battery"],["acme.vpn"]]')
        ticket = json.loads(self.js('JSON.stringify(owner.request({op: "stackSettings", stack: "s1", width: 240}))'))
        self.assertEqual(ticket["phase"], "landed", ticket)
        self.assertEqual(self.js("owner.board.stacks[0].width"), 240)
        self.assertEqual(self.js("JSON.stringify(port.config.bar.layout)"), layout)

    def test_a_stale_board_or_a_changed_copy_refuses_and_writes_nothing(self):
        stale = json.loads(self.js("JSON.stringify(%s)" % self.into_stack(', key: "old"')))
        self.assertEqual((stale["phase"], stale["reason"]), ("refused", "stale"))
        self.assertEqual(self.js("port.writes.length"), 0)

        # The host's copy moved between planning and writing: the mutator
        # re-plans, sees it, and throws, so nothing is persisted.
        self.js("port.beforeMutate = function(copy) { copy.bar.layout.left.reverse() }")
        ticket = json.loads(self.js("JSON.stringify(%s)" % self.into_stack(
            ', from: {zone: "left", index: 1}, key: owner.board.key')))
        self.assertEqual((ticket["phase"], ticket["reason"]), ("refused", "stale"))
        self.assertEqual(self.cards(), '[["omarchy.battery"]]')

    def test_a_late_host_shows_sent_then_landed_and_a_silent_one_unconfirmed(self):
        self.js("port.delayed = true")
        ticket = json.loads(self.js("JSON.stringify(%s)" % self.into_stack()))
        self.assertEqual(ticket["phase"], "sent")
        self.assertEqual(self.js("owner.busy"), True)
        busy = json.loads(self.js('JSON.stringify(owner.request({id: "omarchy.clock", to: "stack", stack: "s1", card: 0}))'))
        self.assertEqual(busy["reason"], "busy")
        self.js("port.flush()")
        self.app.processEvents()
        self.assertEqual(self.js("owner.ticket.phase"), "landed")

        self.js('owner.request({id: "acme.vpn", to: "off"})')
        self.assertEqual(self.js("owner.ticket.phase"), "sent")
        QTest.qWait(150)
        self.app.processEvents()
        self.assertEqual(self.js("owner.ticket.phase"), "unconfirmed")
        self.assertEqual(self.js("owner.busy"), False, "the lock is released; nothing is retried")

    def test_without_the_writer_stacks_cannot_change(self):
        self.js("facade.barConfig = port.config.bar")
        self.js("port.config = null")
        self.app.processEvents()
        self.assertEqual(self.js("owner.partial"), True)
        self.assertEqual(self.js("owner.board.stacks.map(s => s.sid).join()"), "s1")
        cross = json.loads(self.js("JSON.stringify(%s)" % self.into_stack()))
        self.assertEqual(cross["reason"], "needsBarAccess")
        self.assertEqual(self.js("owner.board.reason"), "needsBarAccess")


if __name__ == "__main__":
    unittest.main()


class PlacementOwnerFactsTest(PlacementOwnerTest):
    """The popup offers its plugin list when this window has none yet."""

    def test_offered_facts_stand_in_until_this_window_has_its_own(self):
        facts = self.js("JSON.stringify(owner.facts)")
        self.js("owner.facts = null")
        self.assertEqual(self.js("owner.board.canStow"), False)
        refused = json.loads(self.js("JSON.stringify(%s)" % self.into_stack()))
        self.assertEqual(refused["reason"], "unreadable")
        self.js("owner.offerFacts(%s)" % facts)
        self.assertEqual(self.js("owner.board.canStow"), True)
        ticket = json.loads(self.js("JSON.stringify(%s)" % self.into_stack()))
        self.assertEqual(ticket["phase"], "landed")
