import QtQuick
import Quickshell.Io
import "../core/Calculator.js" as Calculator
import "../core/Fetch.js" as Fetch

// Live inputs for core/Calculator.js: ECB exchange rates (SPEC §8: cached
// daily, frankfurter.dev, size-capped by BoundedFetch) and the current UTC
// offset of every time zone the calculator knows. QML's JS engine has no
// Intl, so one bash process asks strftime for all of them (~40 ms), under
// a deadline like every launcher process (zoneTimeout).
Item {
  id: data

  // $XDG_CACHE_HOME/foamy-menu; empty until the directory exists.
  property string cacheDir: ""
  property bool ratesEnabled: true

  property var rates: null          // {base, date, rates: {CODE: perBase}}
  property var zones: ({})          // IANA name -> minutes east of UTC

  property double ratesFetchedAt: 0
  property double ratesTriedAt: 0
  property double zonesAt: 0
  property bool cacheRead: false
  readonly property bool fetching: ratesFetch.busy

  property string ratesUrl: "https://api.frankfurter.dev/v1/latest"
  readonly property double ratesMaxAgeMs: 12 * 3600 * 1000     // ECB publishes once a working day
  readonly property double retryAfterMs: 30 * 60 * 1000
  readonly property double zonesMaxAgeMs: 10 * 60 * 1000       // catches DST switches
  // timeout's deadline for the zone run: SIGTERM to its group, SIGKILL a
  // second later. It only runs builtins, so this is a backstop.
  property string zoneTimeout: "5s"

  signal message(string level, string text, var metadata)

  // Cheap; called on every launcher open.
  function refresh() {
    var now = Date.now()
    if (now - data.zonesAt > data.zonesMaxAgeMs && !zoneProcess.running) zoneProcess.running = true
    if (data.ratesEnabled && data.cacheRead && !ratesFetch.busy
        && now - data.ratesFetchedAt > data.ratesMaxAgeMs && now - data.ratesTriedAt > data.retryAfterMs)
      data.fetchRates()
  }

  function validRates(doc) {
    if (!doc || typeof doc.base !== "string" || !doc.rates || typeof doc.rates !== "object") return null
    var out = {}
    for (var code in doc.rates) if (/^[A-Z]{3}$/.test(code) && typeof doc.rates[code] === "number" && doc.rates[code] > 0) out[code] = doc.rates[code]
    return { base: doc.base, date: String(doc.date || ""), rates: out }
  }

  function fetchRates() {
    data.ratesTriedAt = Date.now()
    ratesFetch.get(data.ratesUrl, null)
  }

  // Offsets are stored only when every zone answered. A run that ended early
  // (at its deadline, or killed) keeps the previous ones and leaves zonesAt
  // alone, so the next launcher open tries again.
  function storeZones(text) {
    var next = ({})
    var count = 0
    var lines = String(text).split("\n")
    for (var i = 0; i < lines.length; i++) {
      var m = /^(\S+) ([+-])(\d\d)(\d\d)$/.exec(lines[i])
      if (!m || Object.prototype.hasOwnProperty.call(next, m[1])) continue
      next[m[1]] = (m[2] === "-" ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4]))
      count++
    }
    var expected = Calculator.zoneList().length
    if (count < expected) {
      data.message("warning", "time zone offsets are incomplete; trying again on the next open", { zones: count, expected: expected })
      return
    }
    data.zones = next
    data.zonesAt = Date.now()
  }

  // A real reply is under 1 KB. One over Fetch.MAX_BYTES is stopped there and
  // fails like any other (retried after retryAfterMs).
  BoundedFetch {
    id: ratesFetch
    timeoutSeconds: 15
    onFinished: function(tag, text, failure) {
      var parsed = null
      if (!failure) try { parsed = data.validRates(JSON.parse(text)) } catch (e) { parsed = null }
      if (!parsed) {
        if (failure === Fetch.TIMED_OUT) data.message("warning", "exchange rates request timed out", null)
        else data.message("warning", "could not fetch exchange rates", { error: failure || "not exchange rates" })
        return
      }
      data.rates = parsed
      data.ratesFetchedAt = Date.now()
      cache.setText(JSON.stringify({ fetchedAt: data.ratesFetchedAt, base: parsed.base, date: parsed.date, rates: parsed.rates }))
      data.message("info", "exchange rates updated", { date: parsed.date, currencies: Object.keys(parsed.rates).length })
    }
  }

  FileView {
    id: cache
    path: data.cacheDir ? data.cacheDir + "/currencies.json" : ""
    atomicWrites: true
    printErrors: false
    onLoaded: {
      try {
        var doc = JSON.parse(text())
        var parsed = data.validRates(doc)
        if (parsed) {
          data.rates = parsed
          data.ratesFetchedAt = Number(doc.fetchedAt) || 0
        }
      } catch (e) {
        data.message("warning", "ignoring unreadable exchange-rate cache", null)
      }
      data.cacheRead = true
      data.refresh()
    }
    onLoadFailed: { data.cacheRead = true; data.refresh() }
  }

  Process {
    id: zoneProcess
    command: ["timeout", "--kill-after=1s", data.zoneTimeout,
      "bash", "-c", "for z in \"$@\"; do TZ=$z printf '%s %(%z)T\\n' \"$z\" -1; done", "foamy-menu-zones"].concat(Calculator.zoneList())
    stdout: StdioCollector {
      onStreamFinished: data.storeZones(text)
    }
  }

  Component.onCompleted: zoneProcess.running = true
}
