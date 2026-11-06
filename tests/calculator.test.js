const test = require("node:test")
const assert = require("node:assert/strict")
const C = require("../core/Calculator.js")
const RS = require("../core/RootSearch.js")

// Monday 19 Oct 2026, 16:06 in New York (UTC-4). Dates use the process
// zone, so pin it.
process.env.TZ = "America/New_York"
const NOW = Date.UTC(2026, 9, 19, 20, 6)
const env = {
  nowMs: NOW, localOffset: -240, hour12: true,
  rates: { base: "EUR", date: "2026-10-19", rates: { USD: 1.1225, GBP: 0.84205, JPY: 177.63 } },
  zones: { "Asia/Tokyo": 540, "Europe/London": 60, "America/New_York": -240 }
}
const result = (q, e) => { const r = C.evaluate(q, e || env); return r && r.result }

test("arithmetic, precedence, functions and constants", () => {
  assert.equal(result("2+2"), "4")
  assert.equal(result("2 + 3 * 4"), "14")
  assert.equal(result("3(4+5)"), "27")
  assert.equal(result("-2^2"), "-4")
  assert.equal(result("2^10"), "1,024")
  assert.equal(result("2^40"), "1,099,511,627,776", "integers stay exact")
  assert.equal(result("5!"), "120")
  assert.equal(result("10 mod 3"), "1")
  assert.equal(result("10 % 3"), "1", "% before an operand is modulo")
  assert.equal(result("sqrt 16"), "4")
  assert.equal(result("sin(30°)"), "0.5")
  assert.equal(result("0.1+0.2"), "0.3")
  assert.equal(result("1/3"), "0.333333333333")
  assert.equal(result("max(100,200)"), "200", "commas inside calls separate arguments")
  assert.equal(result("1,000,000 * 3"), "3,000,000")
  assert.equal(result("2 × 3 ÷ 4"), "1.5")
  assert.equal(result("pi"), "3.14159265359")
})

test("anything that is not a calculation yields no row", () => {
  for (const q of ["", "firefox", "42", "-5", "5 kg", "e", "1password", "7zip", "now", "time", "may", "20%", "to do", "kg", "x"]) {
    assert.equal(C.evaluate(q, env), null, q)
  }
})

test("Soulver-style percentages", () => {
  assert.equal(result("20% of 50"), "10")
  assert.equal(result("20% off 50"), "40")
  assert.equal(result("20% on 50"), "60")
  assert.equal(result("$30 + 20%"), "$36.00")
  assert.equal(result("100 - 15%"), "85")
  assert.equal(result("50 as a % of 200"), "25%")
  assert.equal(result("$5k + 10%"), "$5,500.00")
})

test("unit conversions", () => {
  assert.equal(result("5 ft to cm"), "152.4 cm")
  assert.equal(result("5 ft in cm"), "152.4 cm", "in after a unit is the conversion word")
  assert.equal(result("12 in to cm"), "30.48 cm", "in after a number is inches")
  assert.equal(result("100 °F to °C"), "37.7778 °C")
  assert.equal(result("100f to c"), "37.7778 °C")
  assert.equal(result("1 GiB to MB"), "1,073.7418 MB")
  assert.equal(result("16px to rem"), "1 rem")
  assert.equal(result("90 min to hours"), "1.5 hours")
  assert.equal(result("5 m^2 to ft^2"), "53.8196 ft²")
  assert.equal(result("1 sq mi to acres"), "640 ac")
  assert.equal(result("1 cubic millimeter to cm³"), "0.001 cm³", "a spelled-out powered unit keeps its scale")
  assert.equal(result("1 square micrometer to m²"), "1e-12 m²")
  assert.equal(result("1 square kilometer to m²"), "1,000,000 m²")
  assert.equal(result("kg to lb"), "2.2046 lb")
  assert.equal(C.evaluate("5 kg to cm", env), null, "incompatible units")
})

test("units combine through arithmetic", () => {
  assert.equal(result("3 m * 4 m"), "12 m²")
  assert.equal(result("10 km / 2 h"), "5 km/h")
  assert.equal(result("60 mph * 2 h"), "120 mi")
  assert.equal(result("5 kW * 3 h"), "15 kWh")
  assert.equal(result("5 ft + 6 in"), "5.5 ft")
  assert.equal(result("$30/h * 8 h"), "$240.00")
})

test("currencies use the rates and need them only to convert", () => {
  assert.equal(result("10 usd to eur"), "€8.91")
  assert.equal(result("€30 in £"), "£25.26")
  assert.equal(result("1000 yen to usd"), "$6.32")
  assert.equal(C.evaluate("10 usd to eur", Object.assign({}, env, { rates: null })), null)
  assert.equal(result("$30 + 20%", Object.assign({}, env, { rates: null })), "$36.00")
})

test("dates and durations", () => {
  assert.equal(result("3 days from now"), "Thursday, 22 October 2026 at 4:06 PM")
  assert.equal(result("2 weeks ago"), "Monday, 5 October 2026 at 4:06 PM")
  assert.equal(result("days until christmas"), "67 days", "whole days across the DST switch")
  assert.equal(result("christmas - today"), "67 days")
  assert.equal(result("2026-12-25 + 1 week"), "Friday, 1 January 2027")
  assert.equal(result("next friday + 1 day"), "Saturday, 24 October 2026")
  assert.equal(C.evaluate("christmas - today", env).kind, "date")
})

test("time zones", () => {
  assert.equal(result("time in tokyo"), "5:06 AM (+1 day)")
  assert.equal(result("tokyo time"), "5:06 AM (+1 day)")
  assert.equal(result("3pm london to new york"), "10:00 AM")
  assert.equal(result("3pm in tokyo"), "4:00 AM (+1 day)")
  assert.equal(result("15:00 utc in nyc", Object.assign({}, env, { hour12: false })), "11:00")
  assert.equal(C.evaluate("time in tokyo", Object.assign({}, env, { zones: {} })), null, "no offsets yet")
})

test("bases", () => {
  assert.equal(result("255 to hex"), "0xFF")
  assert.equal(result("10 in binary"), "0b1010")
  assert.equal(result("0xff + 1"), "256")
})

test("one line of context, the shown answer to copy, and a plain form", () => {
  const r = C.evaluate("5 ft to cm", env)
  assert.deepEqual([r.copy, r.plain, r.context, r.contextValues], ["152.4 cm", "152.4 cm", "%1", ["5 ft → cm"]])
  const sum = C.evaluate("1000+234*2", env)
  assert.deepEqual([sum.result, sum.copy, sum.plain], ["1,468", "1,468", "1468"], "Enter copies what is shown")
  assert.deepEqual(sum.contextValues, ["1000 + 234 × 2"])
  assert.deepEqual(C.evaluate("sqrt 16", env).contextValues, ["√16"])
  assert.deepEqual(C.evaluate("60 km/h to m/s", env).contextValues, ["60 km/h → m/s"], "a unit slash stays")
  const fx = C.evaluate("10 usd to gbp", env)
  assert.deepEqual([fx.context, fx.contextValues[0]], ["%1 = %2", "1 USD"], "currency shows the rate")
  assert.deepEqual([C.evaluate("3 days from now", env).context, C.evaluate("3 days from now", env).contextValues], ["In %1 days", [3]])
  assert.equal(C.evaluate("time in tokyo", env).context, "%1 (%2)")
  assert.equal(C.evaluate("255 to hex", env).context, "Hexadecimal")
  assert.equal(C.words, undefined, "no number words")
})

test("answers in the picked language: separators, dates and unit names", () => {
  const no = { ...env, decimal: ",", groupSeparator: "\u00a0", formatDate: () => "mandag 19. oktober 2026",
    translate: (s) => ({ hours: "timer", days: "dager" })[s] || s }
  const big = C.evaluate("1234567.891 * 2", no)
  assert.deepEqual([big.result, big.copy, big.plain], ["2\u00a0469\u00a0135,782", "2\u00a0469\u00a0135,782", "2469135.782"])
  assert.deepEqual([C.evaluate("90 min to hours", no).result, C.evaluate("90 min to hours", no).plain], ["1,5 timer", "1.5 hours"])
  assert.equal(C.evaluate("$5k + 10%", no).result, "$5\u00a0500,00")
  assert.equal(C.evaluate("today + 0 days", no).result, "mandag 19. oktober 2026")
  assert.equal(C.evaluate("now + 0 days", no).result, "mandag 19. oktober 2026, 4:06 PM")
  assert.equal(C.evaluate("today + 0 days", no).plain, "2026-10-19")
})

test("numbers typed as the language writes them", () => {
  const no = { ...env, decimal: ",", groupSeparator: "\u00a0" }
  const r = (q) => { const x = C.evaluate(q, no); return x && x.result }
  assert.equal(r("2,5 * 2"), "5", "a decimal comma")
  assert.equal(r("2.5 * 2"), "5", "a point still works")
  assert.equal(r("1,5 hours to min"), "90 minutes")
  assert.equal(r("2 469 135,782 / 2"), "1\u00a0234\u00a0567,891", "group spaces join")
  assert.equal(r("2\u00a0000,5 * 2"), "4\u00a0001", "a copied answer reads back")
  assert.equal(r("max(1; 2)"), "2", "; separates arguments")
  assert.equal(r("max(1, 2)"), "2", "so does a comma with a space")
  assert.equal(r("3 * 100"), "300")
  const withNok = { ...no, rates: { ...env.rates, rates: { ...env.rates.rates, NOK: 11.5 } } }
  assert.ok(C.evaluate("12,50 kr til usd", withNok))
  assert.equal(C.evaluate("12,50 kr til usd", withNok).plain, C.evaluate("12.50 nok to usd", withNok).plain, "kr is kroner")
  assert.equal(result("2,5 * 2"), null, "English keeps the comma as a separator")
  assert.equal(result("1,000,000 * 3"), "3,000,000")
  assert.equal(result("max(1,2)"), "2")
  assert.equal(result("2\u00a0000 * 2"), "4,000", "a non-breaking group space joins in English too")
})

test("dates: relative, countdowns, bare dates and the language's formats", () => {
  const no = { ...env, decimal: ",", groupSeparator: "\u00a0", dayFirst: true }
  const n = (q) => { const x = C.evaluate(q, no); return x && x.result }
  // Monday 19 October 2026 in this file.
  assert.equal(n("om 3 dager"), result("3 days from now"))
  assert.equal(result("in 3 days"), result("3 days from now"))
  assert.equal(n("om 2 uker og 3 dager"), result("2 weeks 3 days from now"))
  assert.equal(n("om en uke"), result("1 week from now"))
  assert.deepEqual([C.evaluate("om 3 dager", no).context, C.evaluate("om 3 dager", no).contextValues], ["In %1 days", [3]])
  assert.equal(n("dager til jul"), "66 days", "jul is Christmas Eve")
  assert.equal(n("hvor mange dager er det igjen til jul"), "66 days")
  assert.equal(n("dager til 24. desember"), "66 days")
  assert.equal(n("dager til 24. des."), "66 days")
  assert.equal(n("dager til 24.12"), "66 days", "day first")
  assert.equal(n("dager til 24.12.2027"), "431 days")
  assert.equal(n("uker til 17. mai"), "30 weeks", "until counts to the next May 17")
  assert.equal(n("dager siden 17. mai"), "155 days", "since counts from the last one")
  assert.equal(result("days since christmas"), "298 days")
  assert.equal(n("neste fredag"), result("next friday + 0 days"), "a relative day alone is an answer")
  assert.equal(n("i morgen"), result("tomorrow + 0 days"))
  assert.equal(n("24. des"), result("dec 24 + 0 days"))
  assert.equal(n("24.12"), result("dec 24 + 0 days"))
  assert.equal(result("dec. 24 - today"), result("dec 24 - today"), "a month abbreviation may end in a full stop")
  assert.equal(result("jul 24 - today"), "-87 days", "jul with a day is July")
  for (const q of ["fredag", "jul", "mai", "friday"]) assert.equal(C.evaluate(q, no), null, "a bare " + q + " stays a search")
  assert.equal(n("2.5 * 2"), "5", "a decimal point is not a date")
  assert.equal(result("24.12 + 0"), "24.12", "English reads 24.12 as a number")
})

test("Norwegian words", () => {
  assert.equal(result("5 fot til cm"), "152.4 cm")
  assert.equal(result("12 tommer i cm"), "30.48 cm")
  assert.equal(result("20 % av 50"), "10")
  assert.equal(result("90 minutter til timer"), "1.5 hours")
  assert.equal(result("2 time som minutter"), "120 minutes", "time after a number is an hour")
  assert.equal(result("3 dager fra nå"), result("3 days from now"))
  assert.equal(result("2 uker siden"), result("2 weeks ago"))
  assert.equal(result("i morgen + 2 dager"), result("tomorrow + 2 days"))
  assert.equal(result("neste fredag + 0 dager"), result("next friday + 0 days"))
  assert.equal(result("tid i tokyo"), result("time in tokyo"))
  assert.equal(result("100 kroner til usd"), result("100 nok to usd"))
  assert.equal(C.evaluate("5 fot til cm", env).input, "5 fot til cm", "the typed text is kept")
  assert.deepEqual(C.evaluate("5 fot til cm", env).contextValues, ["5 fot → cm"])
})

test("mixed units add up", () => {
  assert.equal(result("5 ft 3 in"), "5.25 ft")
  assert.equal(result("5 ft 3 in to cm"), "160.02 cm")
  assert.equal(result("1 m 50 cm"), "1.5 m")
  assert.equal(result("1 h 30 min + 45 min"), "2.25 hours")
  assert.match(result("3 days 4 hours from now"), /^Thursday, 22 October 2026 at 8:06 PM$/)
  for (const q of ["2 kg 3", "10 usd 5 usd", "100 °F 3 °C"]) assert.equal(C.evaluate(q, env), null, q)
})

test("work time follows workHoursPerDay and remToPxRate is configurable", () => {
  assert.equal(result("40 hours in work days"), "5 work days")
  assert.equal(result("2 work weeks to hours"), "80 hours")
  assert.equal(result("15 hours in workdays", { ...env, workHoursPerDay: 7.5 }), "2 work days")
  assert.equal(result("16px to rem", { ...env, remToPxRate: 10 }), "1.6 rem")
  assert.equal(C.evaluate("3 workdays from now", env), null, "work days are not calendar days")
})

test("unix timestamps", () => {
  const stamp = C.evaluate("unix 1700000000", env)
  assert.equal(stamp.result, "Tuesday, 14 November 2023 at 5:13 PM")
  assert.equal(stamp.plain, "2023-11-14 17:13")
  assert.equal(result("1700000000 to date"), stamp.result)
  assert.equal(result("1700000000000 to date"), stamp.result, "13 digits are milliseconds")
  assert.equal(result("timestamp 1700000000"), stamp.result)
  const now = C.evaluate("now to unix", env)
  assert.deepEqual([now.result, now.copy, now.context], [String(NOW / 1000), String(NOW / 1000), "Unix timestamp"])
  assert.equal(result("unix time"), String(NOW / 1000))
  assert.equal(result("unix now"), String(NOW / 1000))
  assert.equal(result("2023-11-14 to unix"), "1699938000")
  for (const q of ["unix", "epoch", "timestamp", "date"]) assert.equal(C.evaluate(q, env), null, q)
})

test("history is newest first, unique, pruned after 90 days and capped", () => {
  let h = []
  h = C.pushHistory(h, { id: "1", query: "2+2", result: "4", copy: "4", kind: "math" }, NOW - 100 * 864e5)
  h = C.pushHistory(h, { id: "2", query: "5 ft to cm", result: "152.4 cm", copy: "152.4 cm", kind: "conversion" }, NOW)
  assert.deepEqual(h.map((e) => e.id), ["2"], "the 100-day-old entry is gone")
  h = C.pushHistory(h, { id: "3", query: "3*3", result: "9", copy: "9", kind: "math" }, NOW)
  h = C.pushHistory(h, { id: "4", query: "5 ft to cm", result: "152.4 cm", copy: "152.4 cm", kind: "conversion" }, NOW)
  assert.deepEqual(h.map((e) => e.id), ["4", "3"])
  assert.deepEqual(C.filterHistory(h, "cm").map((e) => e.id), ["4"])
  let big = []
  for (let i = 0; i < C.HISTORY_LIMIT + 5; i++) big = C.pushHistory(big, { id: String(i), query: "q" + i, result: "", copy: "", kind: "math" }, NOW)
  assert.equal(big.length, C.HISTORY_LIMIT)
})

test("root search puts the Calculator section first; ↵ copies, Ctrl ↵ pastes", () => {
  const Scopes = require("../core/Scopes.js")
  const deps = { Ranker: require("../core/Ranker.js"), Frecency: require("../core/Frecency.js"), OmarchyMenu: require("../core/OmarchyMenu.js"), Scopes }
  const searchScopes = Scopes.merge(Scopes.BUILTINS, []).scopes.filter(Scopes.isQuery)
  const ctx = { commands: {}, frecency: {}, nowMs: NOW, sensitivity: "medium", calculation: C.evaluate("2+2", env), searchScopes }
  const sections = RS.rootSections(RS.BUILTINS.map(RS.builtinCandidate), "2+2", ctx, deps)
  assert.equal(sections[0].id, "calculator")
  assert.equal(sections[0].rows[0].candidate.calcResult, "4")
  assert.equal(sections.at(-1).id, "fallback-commands")
  assert.deepEqual(sections.at(-1).rows.map((r) => r.candidate.id), ["scope-query:google", "scope-query:duckduckgo"])
  const actions = RS.actionsFor({ kind: "calculator" }).map((a) => a.id)
  assert.deepEqual(actions.slice(0, 2), ["copy-answer", "paste-answer"])
  const calcHistory = RS.rootSections(RS.BUILTINS.map(RS.builtinCandidate), "calc hist", { commands: {}, frecency: {}, nowMs: NOW }, deps)
  assert.equal(calcHistory[0].rows[0].candidate.title, "Calculator History")
})
