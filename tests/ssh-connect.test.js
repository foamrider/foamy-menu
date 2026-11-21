// bin/foamy-ssh-connect, the last step before ssh runs when Enter connects to
// a host in the SSH scope. It runs here against a stand-in `ssh` that records
// its arguments, first on PATH, so the real ssh never starts.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const Scopes = require("../core/Scopes.js")

const script = path.join(__dirname, "../bin/foamy-ssh-connect")
const ssh = Scopes.merge(Scopes.BUILTINS, []).scopes.find((s) => s.id === "ssh")

// Runs the script; argv is what the stand-in ssh received, or null when ssh
// did not run. Empty stdin makes the "Press any key" read return at once.
function connect(t, args, sshExit = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foamy-ssh-connect-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const log = path.join(dir, "ssh-argv")
  fs.writeFileSync(path.join(dir, "ssh"), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$SSH_LOG"\nexit "$SSH_EXIT"\n', { mode: 0o755 })
  const result = spawnSync(script, args, {
    input: "",
    encoding: "utf8",
    timeout: 10000,
    env: { HOME: dir, PATH: dir + ":" + process.env.PATH, SSH_LOG: log, SSH_EXIT: String(sshExit) }
  })
  assert.equal(result.error, undefined)
  const argv = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").slice(0, -1) : null
  return { status: result.status, output: result.stdout + result.stderr, argv }
}

test("a host the SSH scope accepts reaches ssh as one argument after --", (t) => {
  for (const host of ["web", "deploy@web.example", "user@10.0.0.4:2222", "a_b%c+d", "fe80::1%eth0"]) {
    assert.ok(Scopes.valueAllowed(ssh, host), "the scope accepts " + host)
    const run = connect(t, [host])
    assert.deepEqual(run.argv, ["--", host], host)
    assert.equal(run.status, 0, host)
  }
})

test("an option, shell text or an empty host never reaches ssh", (t) => {
  for (const host of ["-oProxyCommand=touch pwned", "-v", "-p", "web; id", "web id", "$(id)", "`id`", "web\nid", "", "a/b"]) {
    assert.ok(!Scopes.valueAllowed(ssh, host), "the scope refuses " + JSON.stringify(host))
    const run = connect(t, [host])
    assert.equal(run.argv, null, "ssh ran for " + JSON.stringify(host))
    assert.equal(run.status, 2, JSON.stringify(host))
    assert.match(run.output, /Invalid SSH host/)
  }
  const none = connect(t, [])
  assert.deepEqual([none.argv, none.status], [null, 2], "no argument at all")
})

test("ssh's exit status is the script's; an error is shown, Ctrl+C is not", (t) => {
  const failed = connect(t, ["web"], 255)
  assert.equal(failed.status, 255)
  assert.match(failed.output, /SSH exited with error code 255/)
  const interrupted = connect(t, ["web"], 130)
  assert.equal(interrupted.status, 130)
  assert.doesNotMatch(interrupted.output, /SSH exited with error code/)
})
