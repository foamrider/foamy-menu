const test = require("node:test")
const assert = require("node:assert/strict")
const Rpc = require("../core/Rpc.js")

function registryWithSystem() {
  const reg = Rpc.createRegistry()
  Rpc.register(reg, "system", {
    healthPing: () => null,
    echo: (data) => data,
    fail: () => { throw new Error("boom") },
    notAFunction: 42
  })
  return reg
}

test("registers dotted method names and lists them sorted", () => {
  const reg = registryWithSystem()
  assert.deepEqual(Rpc.methods(reg), ["system.echo", "system.fail", "system.healthPing"])
})

test("callSync returns data, nulls undefined, and reports errors", () => {
  const reg = registryWithSystem()
  assert.deepEqual(Rpc.callSync(reg, "system.healthPing", {}), { ok: true, data: null })
  assert.deepEqual(Rpc.callSync(reg, "system.echo", { a: 1 }), { ok: true, data: { a: 1 } })
  assert.deepEqual(Rpc.callSync(reg, "system.fail", null), { ok: false, error: "boom" })
  assert.deepEqual(Rpc.callSync(reg, "foo.bar", null), { ok: false, error: "Unknown method foo.bar" })
})
