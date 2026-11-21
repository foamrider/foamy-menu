// StockMenu.qml reads the launcher's settings from the first foamy.menu entry
// of the bar layout in shell.json. Its bindings, validWidth(),
// reportWidthSetting() and the FileView's onLoaded block run as written, in a
// vm context where unqualified names resolve to the component, as in QML.
// Each load stands in for a FileView read: onLoaded, then the width check
// that onConfiguredWidthSettingChanged runs (here after every read, the most
// a reload can trigger).
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const text = fs.readFileSync(path.join(__dirname, "../StockMenu.qml"), "utf8")
const SECTIONS = ["left", "centerBegin", "center", "centerEnd", "tray", "right"]

// The block that starts at `signature` and ends at the closing brace on its
// own line at `indentation`.
function block(signature, indentation) {
  const start = text.indexOf(signature)
  assert.ok(start >= 0, signature)
  const end = text.indexOf("\n" + " ".repeat(indentation) + "}", start) + indentation + 2
  assert.ok(end > start, signature)
  return text.slice(start, end)
}

const braces = (source) => source.slice(source.indexOf("{"))
// Objects made in the vm context have its prototypes; compare their JSON.
const plain = (value) => JSON.parse(JSON.stringify(value))

// A one-line binding's expression.
function expression(signature) {
  const line = text.split("\n").find((l) => l.startsWith(signature))
  assert.ok(line, signature)
  return line.slice(signature.length)
}

function stockMenu() {
  const warnings = []
  const context = vm.createContext({ console: { warn: (message) => warnings.push(String(message)) } })
  const root = { barConfig: {}, reportedWidthSetting: "", fileText: "" }
  const parts = vm.runInContext(`(function (root, text) { with (root) { return {
    configuredWidthSetting: function () ${braces(block("  readonly property var configuredWidthSetting: {", 2))},
    configuredEntry: function () ${braces(block("  readonly property var configuredEntry: {", 2))},
    configuredWidth: function () { return ${expression("  readonly property int configuredWidth: ")} },
    validWidth: ${block("  function validWidth(", 2).trim()},
    reportWidthSetting: ${block("  function reportWidthSetting(", 2).trim()},
    onLoaded: function () ${braces(block("    onLoaded: {", 4))}
  } } })`, context)(root, () => root.fileText)
  for (const name of ["configuredWidthSetting", "configuredEntry", "configuredWidth"])
    Object.defineProperty(root, name, { get: parts[name] })
  root.validWidth = parts.validWidth
  root.reportWidthSetting = parts.reportWidthSetting
  // Component.onCompleted
  root.reportWidthSetting()
  return {
    root, warnings,
    load(fileText) {
      root.fileText = fileText
      parts.onLoaded()
      root.reportWidthSetting()
    },
    layout(layout) {
      this.load(JSON.stringify({ version: 1, bar: { layout } }))
    }
  }
}

test("the foamy.menu entry is found in every bar section", () => {
  SECTIONS.forEach((section, i) => {
    const menu = stockMenu()
    const entry = { id: "foamy.menu", width: 610 + i, icon: "M" }
    menu.layout({ [section]: [{ id: "other.menu", width: 900 }, "foamy.menu", entry] })
    assert.equal(menu.root.configuredWidth, 610 + i, section)
    assert.deepEqual(plain(menu.root.configuredEntry), entry, section)
    assert.deepEqual(menu.warnings, [], section)
  })
})

test("a section that is not an array is skipped; a bare string entry has no settings; no bar means defaults", () => {
  const menu = stockMenu()
  menu.layout({
    left: null, centerBegin: "foamy.menu", center: { id: "foamy.menu", width: 800 }, centerEnd: 7,
    right: [{ id: "foamy.menu", width: 460 }]
  })
  assert.equal(menu.root.configuredWidth, 460)
  assert.deepEqual(plain(menu.root.configuredEntry), { id: "foamy.menu", width: 460 })

  menu.layout({ centerEnd: ["foamy.menu"] })
  assert.equal(menu.root.configuredWidthSetting, undefined)
  assert.equal(menu.root.configuredWidth, 360)
  assert.deepEqual(plain(menu.root.configuredEntry), {})

  for (const config of [{ version: 1 }, { version: 1, bar: {} }, { version: 1, bar: { layout: null } }, null]) {
    menu.load(JSON.stringify(config))
    assert.equal(menu.root.configuredWidth, 360, JSON.stringify(config))
    assert.deepEqual(plain(menu.root.configuredEntry), {}, JSON.stringify(config))
  }
  assert.deepEqual(menu.warnings, [])
})

test("width is an integer from 0 to 4096, else 360", () => {
  for (const [width, expected] of [
    [0, 0], [360, 360], [4096, 4096],
    [-20, 360], [4097, 360], [1.5, 360], ["440", 360], [null, 360], [true, 360]
  ]) {
    const menu = stockMenu()
    menu.layout({ left: [{ id: "foamy.menu", width }] })
    assert.equal(menu.root.configuredWidth, expected, JSON.stringify(width))
  }
})

test("an invalid width warns once per value, however often the file is read", () => {
  const menu = stockMenu()
  for (const width of [-20, -20, 4096, "440", "440", undefined, -20]) {
    menu.layout({ tray: [width === undefined ? { id: "foamy.menu" } : { id: "foamy.menu", width }] })
  }
  assert.equal(menu.warnings.length, 3, menu.warnings.join("\n"))
  for (const warning of menu.warnings) assert.match(warning, /width must be an integer from 0 to 4096; using 360/)
})

test("a shell.json that does not parse keeps the last valid entry", () => {
  const menu = stockMenu()
  menu.layout({ left: [{ id: "foamy.menu", width: 440, icon: "M" }] })
  for (const half of ['{"bar":', "", "{oops"]) {
    menu.load(half)
    assert.equal(menu.root.configuredWidth, 440, JSON.stringify(half))
    assert.equal(menu.root.configuredEntry.icon, "M", JSON.stringify(half))
  }
  assert.equal(menu.warnings.length, 3)
  for (const warning of menu.warnings) assert.match(warning, /cannot parse shell\.json; keeping the last valid width/)
})
