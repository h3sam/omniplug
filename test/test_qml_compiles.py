"""The bar-facing QML compiles: BarWidget.qml, StackWidget.qml, DrawerWindow.qml.

A bar widget whose file does not compile is silently left off the bar, so a
QML mistake there makes Omniplug disappear (a duplicated signal handler did,
once). These files need Quickshell and the host's qs.Ui, which this runtime
lacks, so they compile against test stand-ins under test/qml. Attached
properties (WlrLayershell, QsWindow) cannot be stood in for from QML; the
copies here drop exactly those lines, counted, and nothing else.
"""

from pathlib import Path
import json
import re
import shutil
import tempfile
import unittest

try:
    from PySide6.QtCore import QUrl
    from PySide6.QtGui import QGuiApplication
    from PySide6.QtQml import QQmlComponent, QQmlEngine, QQmlExpression
except ImportError:
    QGuiApplication = None


REPO = Path(__file__).resolve().parents[1]
SELF = "io.github.h3sam.omniplug"

# (pattern, replacement, file, how many times it must apply)
ATTACHED = [
    (r"^\s*WlrLayershell\.\w+:.*\n", "", "DrawerWindow.qml", 3),
    (r"^\s*exclusionMode: ExclusionMode\.\w+\n", "", "DrawerWindow.qml", 1),
    (r"\b\w+\.QsWindow\.window\b", "null", "DrawerWindow.qml", 1),
    (r"\b\w+\.QsWindow\.window\b", "null", "BarWidget.qml", 3),
]

SCENE = """
import QtQuick
import "Placement.js" as Placement

Item {
  property var cfg: null
  property alias drawer: drawerWindow
  DrawerWindow {
    id: drawerWindow
    selfId: "%s"
    open: true
    board: cfg ? Placement.placementBoard(cfg, { selfId: "%s", canCross: true, plugins: {
      "omarchy.clock": { name: "Clock", kinds: ["bar-widget"], firstParty: true },
      "acme.vpn": { name: "VPN", kinds: ["bar-widget"], firstParty: false },
      "acme.proxies": { name: "Proxies", kinds: ["bar-widget"], firstParty: false } } }) : null
  }
}
""" % (SELF, SELF)


@unittest.skipIf(QGuiApplication is None, "PySide6 unavailable: no real QML runtime evidence")
class QmlCompilesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication([])

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="qml-compiles-")
        self.fixture = Path(self.directory.name)
        for path in list(REPO.glob("*.qml")) + list(REPO.glob("*.js")):
            shutil.copy(path, self.fixture / path.name)
        for pattern, replacement, name, count in ATTACHED:
            target = self.fixture / name
            text, applied = re.subn(pattern, replacement, target.read_text(), flags=re.M)
            self.assertEqual(applied, count, f"{name}: {pattern} applied {applied} times")
            target.write_text(text)
        self.engine = QQmlEngine()
        self.engine.addImportPath(str(REPO / "test/qml"))
        self.warnings = []
        self.engine.warnings.connect(lambda errors: self.warnings.extend(e.toString() for e in errors))

    def tearDown(self):
        del self.engine
        self.directory.cleanup()

    def compile(self, name):
        component = QQmlComponent(self.engine, QUrl.fromLocalFile(str(self.fixture / name)))
        self.assertEqual(component.status(), QQmlComponent.Ready,
                         "\n".join(error.toString() for error in component.errors()))
        return component

    def test_the_bar_widget_compiles(self):
        self.compile("BarWidget.qml")

    def test_the_stack_compiles(self):
        self.compile("StackWidget.qml")

    def test_the_drawer_builds_its_rows_from_a_board_without_warnings(self):
        (self.fixture / "Scene.qml").write_text(SCENE)
        # Held: the scene goes with its component.
        self.component = self.compile("Scene.qml")
        scene = self.component.create()
        QQmlEngine.setObjectOwnership(scene, QQmlEngine.ObjectOwnership.CppOwnership)
        config = {
            "version": 1,
            "bar": {"layout": {"left": ["omarchy.clock"], "center": [],
                               "right": [{"id": SELF}, {"id": SELF, "stack": "s1"}]}},
            "plugins": [{"id": SELF, "stacks": {"s1": {"width": 160, "dots": True,
                                                       "cards": [["acme.vpn"], ["gone.widget"]]}}},
                        {"id": "acme.vpn"}, {"id": "acme.proxies"}],
            "disabledPlugins": [],
        }
        context = self.engine.contextForObject(scene)
        QQmlExpression(context, scene, "cfg = " + json.dumps(config)).evaluate()
        self.app.processEvents()
        result, _ = QQmlExpression(context, scene, "drawer.dropTargets.length").evaluate()
        self.assertEqual(result, 7, "three bar sections, the widgets placed nowhere, two cards, and + New card")
        unplaced, _ = QQmlExpression(context, scene, "drawer.board.unplaced.map(s => s.id).join()").evaluate()
        self.assertEqual(unplaced, "acme.proxies", "a stranded widget is offered for dragging")
        self.assertEqual(self.warnings, [])
        scene.deleteLater()
        self.app.processEvents()


if __name__ == "__main__":
    unittest.main()
