// CalculatorData's time-zone run: the command and storeZones() as written
// in the QML, evaluated in a vm context, against real processes.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const vm = require("node:vm")
const { spawnSync } = require("node:child_process")
const Calculator = require("../core/Calculator.js")

const text = fs.readFileSync(path.join(__dirname, "../services/CalculatorData.qml"), "utf8")

function harness(zoneTimeout) {
  const messages = []
  const service = { zoneTimeout, zones: {}, zonesAt: 0, message: (level, message, metadata) => messages.push({ message, metadata }) }
  const context = vm.createContext({ service, Calculator })
  const start = text.indexOf("  function storeZones(")
  vm.runInContext(text.slice(start, text.indexOf("\n  }", start) + 4), context)
  service.storeZones = context.storeZones
  const process = text.slice(text.indexOf("id: zoneProcess"))
  const command = process.slice(process.indexOf("command: ") + 9, process.indexOf("concat(Calculator.zoneList())") + 29)
  return { data: service, messages, command: vm.runInContext(command, context) }
}

test("the zone run answers every zone the calculator knows, and is stored", () => {
  const h = harness("5s")
  const [cmd, ...args] = h.command
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 15000 })
  assert.equal(result.status, 0)
  h.data.storeZones(result.stdout)
  assert.equal(Object.keys(h.data.zones).length, Calculator.zoneList().length)
  assert.ok(h.data.zonesAt > 0)
  assert.deepEqual(h.messages, [])
})

test("a zone run that hangs ends at its deadline", (t) => {
  // A bash that never answers, first on PATH.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foamy-menu-zones-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, "bash"), "#!/bin/sh\nexec sleep 300\n", { mode: 0o755 })
  const h = harness("1s")
  const [cmd, ...args] = h.command
  const started = Date.now()
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 10000, env: { ...process.env, PATH: dir + ":" + process.env.PATH } })
  assert.equal(result.error, undefined, "ended by itself, not by the test's 10 s limit")
  assert.equal(result.status, 124)
  assert.ok(Date.now() - started < 5000)
})

test("an incomplete zone run keeps the previous offsets and retries on the next open", () => {
  const h = harness("5s")
  h.data.zones = { "Asia/Tokyo": 540 }
  h.data.zonesAt = 0
  h.data.storeZones("Asia/Tokyo +0900\nEurope/Lon")
  assert.deepEqual(h.data.zones, { "Asia/Tokyo": 540 })
  assert.equal(h.data.zonesAt, 0, "zonesAt stays old, so refresh() runs it again")
  assert.match(h.messages[0].message, /incomplete/)
  assert.equal(h.messages[0].metadata.zones, 1)
})
