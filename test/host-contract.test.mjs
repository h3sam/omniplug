// Drift canary for the host internals Omniplug depends on.
//
// LiveBarPort.qml and LiveShellConfig.qml are the only files allowed to name
// members of the Omarchy shell's Bar root, ShellRoot and registries. This test
// (1) keeps that promise: every member those files reach through `barRoot`,
// `shell`, `shellRoot`, `registry` or `facadeShell` must be in the contract
// below, and (2) checks the contract against the host source, so an Omarchy
// update that renames one fails here instead of in someone's bar.
//
// The host source is read from $OMARCHY_PATH/shell, else /usr/share/omarchy/shell.
// Without it only (1) runs.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"

const CONTRACT = {
  "plugins/bar/Bar.qml": {
    via: ["barRoot", "root", "target"],
    properties: ["barWidgetRegistry", "shell", "activePopout", "tooltipTarget", "tooltipText",
      "tooltipShown", "position", "fontFamily", "barForeground", "pluginBarApis", "moduleSlots"],
    readonly: ["barSize"],
    functions: ["pluginBarApiFor", "registerModuleSlot", "unregisterModuleSlot", "requestPopout"]
  },
  "services/BarWidgetRegistry.qml": {
    via: ["registry"],
    properties: ["widgets"],
    functions: ["metadataFor"]
  },
  "shell.qml": {
    via: ["shellRoot"],
    properties: ["shellConfig", "pluginRegistry"],
    functions: ["mutateShellConfig", "updateEntryInline"]
  },
  "services/PluginRegistry.qml": {
    via: [],
    properties: ["scanning"],
    functions: []
  }
}

// Members our adapters use that are not declared in the files above: signal
// handlers derived from contract properties, and the generic QObject surface.
const DERIVED = new Set(["onPluginBarApisChanged", "onModuleSlotsChanged"])

const here = new URL("../", import.meta.url)
// Code only: comments are free to explain the host.
const code = text => text.split("\n").map(line => line.replace(/\/\/.*$/, "")).join("\n")
const adapters = ["LiveBarPort.qml", "LiveShellConfig.qml"]
  .map(name => [name, code(readFileSync(new URL(name, here), "utf8"))])

function contractMembers() {
  const all = new Set()
  for (const spec of Object.values(CONTRACT))
    for (const list of [spec.properties, spec.readonly || [], spec.functions]) for (const m of list) all.add(m)
  return all
}

test("only the live adapters name host internals, and only contract members", () => {
  const allowed = contractMembers()
  for (const [name, text] of adapters) {
    const used = new Set()
    for (const match of text.matchAll(/\b(?:barRoot|shellRoot|registry|facadeShell|root)\.([A-Za-z_]\w*)/g))
      used.add(match[1])
    for (const match of text.matchAll(/\bshell\.([A-Za-z_]\w*)/g)) used.add(match[1])
    for (const member of used) {
      assert.ok(allowed.has(member) || DERIVED.has(member),
        `${name} reaches host member "${member}" that is not in the contract`)
    }
  }
})

test("no other Omniplug file walks into the Bar root or ShellRoot", () => {
  const others = ["HostStage.qml", "HostMount.qml", "DrawerWindow.qml", "PlacementOwner.qml", "Panel.qml",
    "BarWidget.qml", "Expanded.qml", "PluginStore.qml"]
  for (const name of others) {
    const url = new URL(name, here)
    if (!existsSync(url)) continue
    const text = code(readFileSync(url, "utf8"))
    assert.doesNotMatch(text, /\bmutateShellConfig\b|\bpluginBarApiFor\b|\bregisterModuleSlot\b|\bbarWidgetRegistry\b/,
      `${name} must go through LiveBarPort/LiveShellConfig`)
  }
})

const hostRoot = [process.env.OMARCHY_PATH && join(process.env.OMARCHY_PATH, "shell"), "/usr/share/omarchy/shell"]
  .find(dir => dir && existsSync(join(dir, "plugins/bar/Bar.qml")))

test("every contract member still exists in the host source", { skip: !hostRoot && "host source not found" }, () => {
  for (const [file, spec] of Object.entries(CONTRACT)) {
    const text = readFileSync(join(hostRoot, file), "utf8")
    for (const property of spec.properties)
      assert.match(text, new RegExp(`^\\s*(?:readonly\\s+)?property\\s+\\S+\\s+${property}\\b`, "m"),
        `${file} no longer declares property ${property}`)
    for (const property of spec.readonly || [])
      assert.match(text, new RegExp(`^\\s*readonly\\s+property\\s+\\S+\\s+${property}\\b`, "m"),
        `${file} no longer declares ${property}`)
    for (const fn of spec.functions)
      assert.match(text, new RegExp(`^\\s*function\\s+${fn}\\s*\\(`, "m"), `${file} no longer defines ${fn}()`)
  }
})

test("the host still wires the pieces the adapters rely on", { skip: !hostRoot && "host source not found" }, () => {
  const shell = readFileSync(join(hostRoot, "shell.qml"), "utf8")
  // The built-in bar is handed the real ShellRoot, which is what makes
  // barRoot.shell a writer rather than a facade.
  assert.match(shell, /Bar\s*\{[^}]*\bshell:\s*shell\b/s)
  // mutateShellConfig persists after running the mutator; a throw aborts it.
  assert.match(shell, /function mutateShellConfig\(mutator\)\s*\{\s*var copy = [^\n]+\n\s*mutator\(copy\)\s*\n\s*persistShellConfig\(copy\)/)
  const registry = readFileSync(join(hostRoot, "services/PluginRegistry.qml"), "utf8")
  // Placement stores "off" in disabledPlugins and relies on it being checked
  // before the first-party shortcut, for every widget.
  assert.match(registry, /if \(isDisabled\(config, key\)\) return false\s*\n\s*if \(manifest\.__isFirstParty\) return true/)
  const bar = readFileSync(join(hostRoot, "plugins/bar/Bar.qml"), "utf8")
  // Facades die when no module slot claims them; the proxy slot relies on it.
  assert.match(bar, /function pluginBarApiUsed\(pluginId\)[\s\S]*?slot\.pluginApiId === pluginId/)
})
