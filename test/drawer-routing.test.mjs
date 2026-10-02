// The Drawer's open/close routing in BarWidget.qml, evaluated from the shipped
// function bodies (the same approach as popup-arrange.test.mjs): the icon,
// Manage and Back, and the bar's popout switch.
import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8")
const widget = read("BarWidget.qml"), bridge = read("PopupBridge.js"), panelSource = read("Panel.qml")

function call(source, name, state, ...args) {
  const match = source.match(new RegExp(`function ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\}`))
  assert.ok(match, `${name} exists`)
  return Function("state", "args", `with (state) { return (function(${match[1]}) {${match[2]}})(...args) }`)(state, args)
}

// A BarWidget whose functions call each other through the shipped bodies.
function widgetState() {
  const log = []
  const panel = {
    opened: false, fromDrawer: false,
    open() { this.opened = true; log.push("panel.open") },
    close() { this.opened = false; log.push("panel.close") },
    closeForPopoutSwitch() { this.opened = false; log.push("panel.switchClose") }
  }
  const state = {
    log, drawerOpen: false,
    panelLoader: { item: panel },
    bar: {
      requestPopout(owner) { log.push("request:" + (owner === state ? "widget" : "other")) },
      releasePopout(owner) { log.push("release:" + (owner === state ? "widget" : "other")) }
    },
    drawerTicket: null, isIcon: true, noteAfter: -1, placementOwner: null,
    cancelPopupArrange() { log.push("cancel") }
  }
  state.root = state
  for (const name of ["openDrawer", "closeDrawer", "openManager", "togglePanel", "open", "close", "closeForPopoutSwitch"])
    state[name] = (...args) => call(widget, name, state, ...args)
  return { state, panel, log }
}

test("the icon opens the drawer, closes it, and closes the manager instead of stacking", () => {
  const { state, panel, log } = widgetState()
  state.togglePanel()
  assert.equal(state.drawerOpen, true)
  assert.deepEqual(log, ["cancel", "request:widget"], "the drawer holds the bar's popout as the widget")
  log.length = 0
  state.togglePanel()
  assert.equal(state.drawerOpen, false)
  assert.deepEqual(log, ["cancel", "release:widget"])

  panel.opened = true
  log.length = 0
  state.togglePanel()
  assert.equal(panel.opened, false)
  assert.equal(state.drawerOpen, false, "closing the manager does not open the drawer")
})

test("Manage swaps the drawer for the manager, marked as coming from the drawer; Back swaps again", () => {
  const { state, panel, log } = widgetState()
  state.openDrawer()
  log.length = 0
  state.openManager(true)
  assert.equal(state.drawerOpen, false)
  assert.equal(panel.opened, true)
  assert.equal(panel.fromDrawer, true)
  assert.deepEqual(log, ["release:widget", "panel.open"], "release before the manager's panel requests")

  log.length = 0
  state.openDrawer()
  assert.equal(panel.opened, false)
  assert.equal(state.drawerOpen, true)
  assert.deepEqual(log, ["panel.close", "request:widget"])
  assert.match(panelSource, /onClicked: if \(root\.hostWidget && typeof root\.hostWidget\.openDrawer === "function"\) root\.hostWidget\.openDrawer\(\)/)
})

test("a popout switch closes the drawer and the manager: the drawer hosts no widgets any more", () => {
  const plain = widgetState()
  plain.state.openDrawer()
  plain.panel.opened = true
  plain.log.length = 0
  plain.state.closeForPopoutSwitch()
  assert.equal(plain.state.drawerOpen, false)
  assert.equal(plain.panel.opened, false)
  assert.deepEqual(plain.log, ["cancel", "release:widget", "panel.switchClose"])
})

test("summon opens the drawer; close closes whichever is open", () => {
  const { state, panel } = widgetState()
  state.open()
  assert.equal(state.drawerOpen, true)
  panel.opened = true
  state.close()
  assert.equal(state.drawerOpen, false)
  assert.equal(panel.opened, false)
})

test("collapsing the expanded window lands on the manager, not the drawer", () => {
  const Bridge = Function(bridge.replace(/^\.pragma library$/m, "") + "; return { register, openPopup }")()
  const calls = []
  const w = { screenName: "DP-1", open() { calls.push("open") }, openManager(fromDrawer) { calls.push("manager:" + fromDrawer) } }
  Bridge.register(w)
  assert.equal(Bridge.openPopup("DP-1"), true)
  assert.deepEqual(calls, ["manager:false"])
})

const storeSource = read("PluginStore.qml")
const Model = Function(read("Model.js") + "; return { canEnable, canDisable, needsPlacement, findRow, withStowed }")()

function storeState(requests, ok = true) {
  const state = {
    busy: false, statusText: "", statusError: false, pendingKind: "", pendingId: "", pendingLabel: "",
    pendingPlacementNeeded: false, pendingSection: "", rows: [], started: [], Model,
    placement: { request(intent) { requests.push(intent); return { ok, note: ok ? "done" : "refused" } } },
    setStatus(text, isError) { state.statusText = text; state.statusError = isError },
    startEnable(row, section) { state.started.push([row.id, section]) },
    startDisable(row) { state.started.push([row.id, "disable"]) },
    cancelPending() { state.pendingKind = ""; state.pendingId = ""; state.pendingLabel = "" }
  }
  for (const name of ["placeStowed", "askEnable", "askDisable", "confirmPlacement"])
    state[name] = (...args) => call(storeSource, name, state, ...args)
  return state
}

const stackBoard = state => ({ stacks: [{ sid: "s1", cards: [[{ id: "acme.vpn", state }]] }], orphans: [] })

test("the manager's switch turns a stacked widget off and back on in its card", () => {
  const requests = []
  const s = storeState(requests)
  const rows = Model.withStowed([{ id: "acme.vpn", enabled: false, canDisable: false, kinds: ["bar-widget"] }],
    stackBoard("live"))
  assert.equal(rows[0].barSection, "stack")
  assert.equal(s.askDisable(rows[0]), true)
  assert.deepEqual(requests, [{ id: "acme.vpn", to: "off" }])
  const off = Model.withStowed([{ id: "acme.vpn", enabled: false, kinds: ["bar-widget"] }], stackBoard("off"))
  assert.equal(s.askEnable(off[0]), true)
  assert.deepEqual(requests[1], { id: "acme.vpn", to: "on" }, "no placement question: it has a spot")
  assert.deepEqual(s.started, [], "the host's enable, which would put it in the bar, is never used")
  assert.equal(s.statusText, "done")
})

test("the placement question offers bar sections only, through the host's enable", () => {
  const requests = []
  const s = storeState(requests)
  s.rows = [{ id: "acme.vpn", name: "VPN", enabled: false, kinds: ["bar-widget"] }]
  s.pendingKind = "place"; s.pendingId = "acme.vpn"; s.pendingLabel = "VPN"
  s.confirmPlacement("left")
  assert.deepEqual(s.started, [["acme.vpn", "left"]])
  assert.deepEqual(requests, [])
  assert.match(storeSource, /Model\.placementOptions\(\)/)
})

test("a refused Placement request is reported as an error", () => {
  const s = storeState([], false)
  const rows = Model.withStowed([{ id: "acme.vpn", enabled: false, kinds: ["bar-widget"] }], stackBoard("live"))
  assert.equal(s.askDisable(rows[0]), false)
  assert.equal(s.statusError, true)
})

test("rows are untouched when nothing is stacked", () => {
  const rows = [{ id: "acme.vpn", enabled: true }]
  assert.equal(Model.withStowed(rows, { stacks: [], orphans: [] }), rows)
  assert.equal(Model.withStowed(rows, null), rows)
})
