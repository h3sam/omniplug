// Which card each stack is showing, for as long as the shell runs. A write
// that changes the bar layout rebuilds every bar widget, stacks included, and
// a stack should come back on the card it was showing; a shell restart starts
// over on the first (docs/design/m2-stacks.md, decision 10). A `.pragma
// library` script is one shared instance per QML engine, which is exactly
// "while the shell runs".
.pragma library

var shown = {}

function key(screenName, sid) {
  return String(screenName || "") + "|" + String(sid || "")
}

function get(screenName, sid) {
  var value = shown[key(screenName, sid)]
  return typeof value === "number" && isFinite(value) ? value : 0
}

function set(screenName, sid, index) {
  shown[key(screenName, sid)] = index
}
