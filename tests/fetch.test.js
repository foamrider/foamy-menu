const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const https = require("node:https")
const os = require("node:os")
const path = require("node:path")
const { spawn, spawnSync } = require("node:child_process")
const Fetch = require("../core/Fetch.js")

// Marketplace review: a hostile or intercepted rates (or suggestion) server
// must not be able to fill the shell's memory. These run core/Fetch.js's exact
// curl command, the one services/BoundedFetch.qml starts, against a local
// HTTPS server with a throwaway certificate.

const MAX = Fetch.MAX_BYTES

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function certificate(dir) {
  const r = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", dir + "/key.pem", "-out", dir + "/cert.pem", "-days", "1", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1"], { encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  return { key: fs.readFileSync(dir + "/key.pem"), cert: fs.readFileSync(dir + "/cert.pem"), ca: dir + "/cert.pem" }
}

// Routes: /rates, /exact, /over-by-one, /length (declares 10 MiB), /endless
// (chunked, no length, never ends), /stall, /missing, /redirect-https, /redirect-http.
function startServer(t, tls) {
  const seen = { sent: {}, headers: {} }
  const chunk = Buffer.alloc(64 * 1024, "x")
  const stream = (req, res, limit) => {
    seen.sent[req.url] = 0
    const pump = () => {
      while (seen.sent[req.url] < limit) {
        seen.sent[req.url] += chunk.length
        if (!res.write(chunk)) return
      }
      res.end()
    }
    res.on("drain", pump)
    pump()
  }
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    seen.headers[req.url] = req.headers
    const port = server.address().port
    switch (req.url) {
      case "/rates": {
        const body = JSON.stringify({ amount: 1, base: "EUR", date: "2026-11-06", rates: { USD: 1.08, NOK: 11.7 } })
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) })
        return res.end(body)
      }
      case "/exact": res.writeHead(200); return res.end(Buffer.alloc(MAX, "y"))
      case "/over-by-one": res.writeHead(200); return res.end(Buffer.alloc(MAX + 1, "y"))
      case "/length":
        res.writeHead(200, { "Content-Length": 10 * 1024 * 1024 })
        return stream(req, res, 10 * 1024 * 1024)
      case "/endless": res.writeHead(200); return stream(req, res, 1024 * 1024 * 1024)
      case "/stall": res.writeHead(200); return res.write("{")
      case "/redirect-https": res.writeHead(302, { Location: `https://127.0.0.1:${port}/rates` }); return res.end()
      case "/redirect-http": res.writeHead(302, { Location: `http://127.0.0.1:${port}/rates` }); return res.end()
      default: res.writeHead(404); return res.end("not found")
    }
  })
  const sockets = new Set()
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)) })
  t.after(() => { for (const s of sockets) s.destroy(); server.close() })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ base: `https://127.0.0.1:${server.address().port}`, seen })))
}

// Runs the fetch as BoundedFetch does: argv from Fetch.argv, config on stdin.
function fetch(url, env, seconds) {
  const [cmd, ...args] = Fetch.argv(MAX, seconds || 15)
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] })
    let bytes = 0
    const out = []
    let err = ""
    child.stdout.on("data", (d) => { bytes += d.length; out.push(d) })
    child.stderr.on("data", (d) => { err += d })
    const started = Date.now()
    child.on("close", (code) => {
      const text = Buffer.concat(out).toString("utf8")
      resolve({ code, bytes, text, err, ms: Date.now() - started, failure: Fetch.failure(code, err, text, MAX) })
    })
    child.stdin.end(Fetch.config(url, ["nb-NO", "en"]))
  })
}

test("bounded fetch: a normal reply parses; oversized and endless replies stop at the cap", async (t) => {
  const dir = tempDir(t, "foamy-menu-fetch-")
  const tls = certificate(dir)
  // A ~/.curlrc that would drop the body must be ignored (--disable).
  fs.writeFileSync(dir + "/.curlrc", "output = /dev/null\nmax-filesize = 0\n")
  const env = { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir, CURL_CA_BUNDLE: tls.ca }
  const { base, seen } = await startServer(t, tls)

  const rates = await fetch(base + "/rates", env)
  assert.equal(rates.failure, "", rates.err)
  assert.deepEqual(JSON.parse(rates.text).rates, { USD: 1.08, NOK: 11.7 })
  assert.equal(seen.headers["/rates"]["user-agent"], "Mozilla/5.0")
  assert.equal(seen.headers["/rates"]["accept-language"], "nb-NO,en,*")
  assert.equal(seen.headers["/rates"]["accept-encoding"], undefined, "no compressed reply to expand past the cap")

  const exact = await fetch(base + "/exact", env)
  assert.equal(exact.failure, "", exact.err)
  assert.equal(exact.bytes, MAX, "a reply of exactly the cap is whole")

  for (const route of ["/over-by-one", "/length", "/endless"]) {
    const r = await fetch(base + route, env)
    assert.equal(r.code, 63, `${route}: ${r.err}`)
    assert.equal(r.failure, `reply is over ${MAX} bytes`, route)
    assert.ok(r.bytes <= MAX, `${route}: the shell would have read ${r.bytes} bytes`)
    assert.ok(r.ms < 10000, `${route}: took ${r.ms} ms`)
  }
  // The transfer stops, not just the output: what the server got rid of is
  // the cap plus what socket buffers hold, nowhere near 10 MiB or 1 GiB.
  for (const route of ["/length", "/endless"]) {
    assert.ok(seen.sent[route] < 8 * 1024 * 1024, `${route}: server sent ${seen.sent[route]} bytes`)
  }

  const stall = await fetch(base + "/stall", env, 1)
  assert.equal(stall.failure, Fetch.TIMED_OUT)
  assert.ok(stall.ms < 5000, `stall took ${stall.ms} ms`)

  const missing = await fetch(base + "/missing", env)
  assert.match(missing.failure, /404/)
  assert.equal(missing.text, "", "--fail keeps an error page out of the reply")

  const redirected = await fetch(base + "/redirect-https", env)
  assert.equal(redirected.failure, "", redirected.err)
  assert.equal(JSON.parse(redirected.text).base, "EUR", "an https redirect is followed")
  const downgraded = await fetch(base + "/redirect-http", env)
  assert.notEqual(downgraded.failure, "", "a redirect to http is refused")
  assert.equal(downgraded.text, "")
})

test("bounded fetch: the URL stays off the command line; unsafe URLs are refused", () => {
  const url = "https://duckduckgo.com/ac/?q=my%20private%20question&type=list"
  const argv = Fetch.argv(MAX, 3)
  assert.equal(argv[0], "curl")
  assert.equal(argv[1], "--disable", "--disable must be first for curl to skip ~/.curlrc")
  assert.ok(!argv.join(" ").includes("private"))
  assert.deepEqual(argv.slice(argv.indexOf("--max-filesize"), argv.indexOf("--max-filesize") + 2), ["--max-filesize", String(MAX)])
  assert.equal(Fetch.config(url, []), `url = "${url}"\nuser-agent = "Mozilla/5.0"\n`)
  for (const bad of ["http://example.com/", "file:///etc/passwd", "https://", "https://a/\"\nupload-file = x",
    "https://a/ b", "https://a/\\", "https://a/\u0000", ""]) {
    assert.equal(Fetch.config(bad, []), "", JSON.stringify(bad))
  }
  assert.equal(Fetch.languageHeader(["en-US", "en-US", "x\"y", "de"]), "en-US,de,*")
  assert.equal(Fetch.languageHeader(null), "")
})

test("bounded fetch: failures read as one short line", () => {
  assert.equal(Fetch.failure(0, "", "{}", MAX), "")
  assert.equal(Fetch.failure(0, "", "x".repeat(MAX + 1), MAX), `reply is over ${MAX} bytes`)
  assert.equal(Fetch.failure(28, "curl: (28) Operation timed out", "", MAX), Fetch.TIMED_OUT)
  assert.equal(Fetch.failure(6, "curl: (6) Could not resolve host: api.frankfurter.dev\n", "", MAX), "Could not resolve host: api.frankfurter.dev")
  assert.equal(Fetch.failure(7, "", "", MAX), "curl exited with code 7")
})
