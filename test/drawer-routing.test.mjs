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
function widgetState({ deferred = false } = {}) {
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
    stage: { deferPopoutSwitch() { log.push("defer?"); return deferred } },
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

test("a popout switch is deferred to the stage while the drawer shows, and closes everything otherwise", () => {
  const deferred = widgetState({ deferred: true })
  deferred.state.openDrawer()
  deferred.log.length = 0
  deferred.state.closeForPopoutSwitch()
  assert.equal(deferred.state.drawerOpen, true, "a stowed widget's panel may be the new popout")
  assert.deepEqual(deferred.log, ["defer?"])

  const plain = widgetState({ deferred: false })
  plain.state.openDrawer()
  plain.panel.opened = true
  plain.log.length = 0
  plain.state.closeForPopoutSwitch()
  assert.equal(plain.state.drawerOpen, false)
  assert.equal(plain.panel.opened, false)
  assert.deepEqual(plain.log, ["defer?", "cancel", "release:widget", "panel.switchClose"])
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

test("the manager's switch turns a stowed widget off and back on in its drawer spot", () => {
  const requests = []
  const s = storeState(requests)
  const rows = Model.withStowed([{ id: "acme.vpn", enabled: false, canDisable: false, kinds: ["bar-widget"] }],
    { zones: { drawer: [{ id: "acme.vpn", state: "live" }] } })
  assert.equal(s.askDisable(rows[0]), true)
  assert.deepEqual(requests, [{ id: "acme.vpn", to: "off" }])
  const off = Model.withStowed([{ id: "acme.vpn", enabled: false, kinds: ["bar-widget"] }],
    { zones: { drawer: [{ id: "acme.vpn", state: "off" }] } })
  assert.equal(s.askEnable(off[0]), true)
  assert.deepEqual(requests[1], { id: "acme.vpn", to: "drawer" }, "no placement question: it has a spot")
  assert.deepEqual(s.started, [], "the host's enable, which would put it in the bar, is never used")
  assert.equal(s.statusText, "done")
})

test("the placement question's Drawer answer goes to Placement; a section keeps the host's enable", () => {
  const requests = []
  const s = storeState(requests)
  s.rows = [{ id: "acme.vpn", name: "VPN", enabled: false, kinds: ["bar-widget"] }]
  s.pendingKind = "place"; s.pendingId = "acme.vpn"; s.pendingLabel = "VPN"
  s.confirmPlacement("drawer")
  assert.deepEqual(requests, [{ id: "acme.vpn", to: "drawer" }])
  assert.deepEqual(s.started, [])
  s.pendingKind = "place"; s.pendingId = "acme.vpn"; s.pendingLabel = "VPN"
  s.confirmPlacement("left")
  assert.deepEqual(s.started, [["acme.vpn", "left"]])
  assert.match(storeSource, /Model\.placementOptions\(canStowInDrawer && !pendingPlacementNeeded\)/,
    "installs never offer the Drawer: the install lands before Placement could stow it")
})

test("a refused Placement request is reported as an error", () => {
  const s = storeState([], false)
  const rows = Model.withStowed([{ id: "acme.vpn", enabled: false, kinds: ["bar-widget"] }],
    { zones: { drawer: [{ id: "acme.vpn", state: "live" }] } })
  assert.equal(s.askDisable(rows[0]), false)
  assert.equal(s.statusError, true)
})
