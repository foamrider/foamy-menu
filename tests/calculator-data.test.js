// CalculatorData as written in the QML, evaluated in a vm context: the
// time-zone run (the command and storeZones(), against real processes) and
// the rate download policy (refresh() and validRates(), with a fake clock).
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
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 10000, env: { ...process.env, PATH: dir + ":" + process.env.PATH } })
  assert.equal(result.error, undefined, "ended by itself, not by the test's 10 s limit")
  assert.equal(result.status, 124)
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

// The rate download policy as README states it: a download only when the
// cache is over 12 hours old, at most one try per 30 minutes, none while
// currencyRates is off, none before the cache was read, one at a time.
function policy({ busy = false, ...state }) {
  const fetches = []
  const clock = { now: 0 }
  const zoneProcess = { running: false }
  const ratesFetch = { busy }
  const service = {
    ratesEnabled: true, cacheRead: true, ratesFetchedAt: 0, ratesTriedAt: 0, zonesAt: 0, ...state,
    fetchRates: () => fetches.push(clock.now)
  }
  for (const name of ["ratesMaxAgeMs", "retryAfterMs", "zonesMaxAgeMs"]) {
    const m = new RegExp("readonly property double " + name + ": ([^\\n/]+)").exec(text)
    assert.ok(m, name + " is declared")
    service[name] = vm.runInNewContext(m[1])
  }
  const context = vm.createContext({ service, zoneProcess, ratesFetch, Date: { now: () => clock.now } })
  for (const name of ["refresh", "validRates"]) {
    const start = text.indexOf("  function " + name + "(")
    assert.ok(start >= 0, name)
    vm.runInContext(text.slice(start, text.indexOf("\n  }", start) + 4), context)
  }
  return { service, fetches, zoneProcess, clock, refresh: context.refresh, validRates: context.validRates }
}

test("rates download only when the cache is over 12 hours old, the last try over 30 minutes ago, and the setting on", () => {
  const NOW = Date.UTC(2026, 9, 19, 12)
  const H = 3600 * 1000
  const M = 60 * 1000
  const cases = [
    ["fetched 13 hours ago", { ratesFetchedAt: NOW - 13 * H }, 1],
    ["fetched 11 hours ago", { ratesFetchedAt: NOW - 11 * H }, 0],
    ["currencyRates off", { ratesFetchedAt: NOW - 13 * H, ratesEnabled: false }, 0],
    ["cache not read yet", { ratesFetchedAt: NOW - 13 * H, cacheRead: false }, 0],
    ["tried 10 minutes ago", { ratesFetchedAt: NOW - 13 * H, ratesTriedAt: NOW - 10 * M }, 0],
    ["tried 31 minutes ago", { ratesFetchedAt: NOW - 13 * H, ratesTriedAt: NOW - 31 * M }, 1],
    ["a download already busy", { ratesFetchedAt: NOW - 13 * H, busy: true }, 0]
  ]
  for (const [name, state, expected] of cases) {
    const p = policy(state)
    p.clock.now = NOW
    p.refresh()
    assert.equal(p.fetches.length, expected, name)
  }
})

test("a rates reply keeps only three-letter codes with positive numbers", () => {
  const { validRates } = policy({})
  const reply = { base: "EUR", date: "2026-10-19", rates: { USD: 1.1225, usd: 1.1, EURO: 1, GBP: "0.8", JPY: 0, NOK: -1, SEK: 11.4 } }
  // The copy gives the vm's object this realm's prototypes for deepEqual.
  assert.deepEqual(JSON.parse(JSON.stringify(validRates(reply))), { base: "EUR", date: "2026-10-19", rates: { USD: 1.1225, SEK: 11.4 } })
  for (const bad of [null, "rates", {}, { base: 1, rates: { USD: 1 } }, { base: "EUR" }, { base: "EUR", rates: "USD" }])
    assert.equal(validRates(bad), null, JSON.stringify(bad))
})
