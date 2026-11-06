// Foamy Menu's settings: the foamy.menu entry in ~/.config/omarchy/shell.json,
// as every Omarchy shell plugin keeps them. manifest.json barWidget.schema and
// barWidget.defaults mirror these fields (tests/settings.test.js checks it);
// kit/FoamyPrefs.js validates a stored value and falls back to the default.
//
//   omarchy bar set foamy.menu webSearchHistory true --json
//
// Zoom (Ctrl +/-), favorites, ranking and history are state, not settings:
// they stay in ~/.local/share/foamy-menu/db/.

// Besides the manifest schema keys, each field carries what the launcher's
// settings view shows: section and title (short, translated), optionTitles,
// unit, and hidden for those left to shell.json.
var fields = [
  { key: "width", type: "integer", label: "Minimum menu width (0 = default)", defaultValue: 360, min: 0, max: 4096, step: 10,
    section: "Bar Button", title: "Minimum width", unit: "px" },
  { key: "icon", type: "string", label: "Bar icon", defaultValue: "\u{f08c7}",
    section: "Bar Button", title: "Icon" },
  { key: "iconFont", type: "string", label: "Icon font (empty = bar font)", defaultValue: "",
    section: "Bar Button", title: "Icon font", emptyTitle: "Bar font" },
  { key: "windowMode", type: "enum", label: "Window: expanded, or compact (only the search field until you type)",
    options: ["expanded", "compact"], defaultValue: "expanded",
    section: "Window", title: "Window mode", optionTitles: { expanded: "Expanded", compact: "Compact" } },
  { key: "escapeKeyBehavior", type: "enum", label: "Esc: go back one level, or close and start over",
    options: ["pop-back-or-close", "close-and-pop-to-root"], defaultValue: "pop-back-or-close",
    section: "Window", title: "Esc", optionTitles: { "pop-back-or-close": "Go back", "close-and-pop-to-root": "Close and start over" } },
  { key: "popToRootTimeout", type: "integer", label: "Seconds a closed launcher keeps its place (0 = always start over)",
    defaultValue: 90, min: 0, max: 3600, step: 10,
    section: "Window", title: "Keep place after closing", unit: "s" },
  { key: "navigationBindings", type: "enum", label: "Move keys besides the arrows: Ctrl+N/P (emacs) or Ctrl+J/K (vim-motions)",
    options: ["emacs", "vim-motions"], defaultValue: "emacs",
    section: "Window", title: "Move keys", optionTitles: { emacs: "Ctrl+N/P", "vim-motions": "Ctrl+J/K" } },
  { key: "rootSearchSensitivity", type: "enum", label: "How loosely search matches typos",
    options: ["low", "medium", "high"], defaultValue: "medium",
    section: "Window", title: "Typo tolerance", optionTitles: { low: "Low", medium: "Medium", high: "High" } },
  { key: "keepVisibleOnFocusLoss", type: "boolean", label: "Stay open when clicking outside", defaultValue: false,
    section: "Window", title: "Stay open when clicking outside" },
  { key: "sshScope", type: "boolean", label: "SSH scope (ssh + Tab)", defaultValue: true,
    section: "Scopes", title: "SSH scope" },
  { key: "webSearchHistory", type: "boolean", label: "Save web searches and list them as Recent Searches", defaultValue: false,
    section: "Scopes", title: "Save web searches" },
  { key: "webSearchSuggestions", type: "boolean", label: "Show search suggestions while typing (sends what you type to the engine)", defaultValue: false,
    section: "Scopes", title: "Search suggestions" },
  // Daily ECB reference rates from frankfurter.dev for currency conversion.
  { key: "currencyRates", type: "boolean", label: "Download exchange rates for currency conversion", defaultValue: true,
    section: "Calculator", title: "Exchange rates" },
  { key: "clockFormat", type: "enum", label: "Clock in time calculations (auto follows the system)",
    options: ["auto", "12h", "24h"], defaultValue: "auto",
    section: "Calculator", title: "Clock", optionTitles: { auto: "Automatic", "12h": "12-hour", "24h": "24-hour" } },
  { key: "remToPxRate", type: "number", label: "Pixels per rem in unit conversions", defaultValue: 16, min: 1, max: 1000, step: 1,
    section: "Calculator", title: "Pixels per rem", unit: "px" },
  { key: "workHoursPerDay", type: "number", label: "Hours in a work day in time conversions", defaultValue: 8, min: 1, max: 24, step: 1,
    section: "Calculator", title: "Work day", unit: "h" },
  { key: "logLevel", type: "enum", label: "Log level", options: ["trace", "debug", "info", "warning", "error", "fatal"], defaultValue: "info",
    hidden: true }
]

// The settings view's sections, in order.
var SECTIONS = ["Window", "Scopes", "Calculator", "Bar Button"]

function field(key) {
  for (var i = 0; i < fields.length; i++) if (fields[i].key === key) return fields[i]
  return null
}

// How a value reads in the settings view: [English template, values] for the
// UI to translate ("On", "Expanded", "%1 s" with [90]).
function display(f, value) {
  if (f.type === "boolean") return [value ? "On" : "Off", []]
  if (f.type === "enum") return [(f.optionTitles && f.optionTitles[value]) || String(value), []]
  if (f.type === "integer" || f.type === "number") {
    if (f.key === "width" && value === 0) return ["Default", []]
    if (f.key === "popToRootTimeout" && value === 0) return ["Never", []]
    return [f.unit ? "%1 " + f.unit : "%1", [value]]
  }
  if (value === "" && f.emptyTitle) return [f.emptyTitle, []]
  return [String(value), []]
}

// The value after ←/→: the next or previous choice (wrapping), a number one
// step along (within min/max), a switch flipped. Text has none (null).
function stepped(f, value, direction) {
  if (f.type === "boolean") return !value
  if (f.type === "enum") {
    var at = f.options.indexOf(value)
    return f.options[(at + direction + f.options.length) % f.options.length]
  }
  if (f.type === "integer" || f.type === "number") {
    var next = value + direction * (f.step || 1)
    if (f.min !== undefined) next = Math.max(f.min, next)
    if (f.max !== undefined) next = Math.min(f.max, next)
    return f.type === "integer" ? Math.round(next) : Math.round(next * 1000) / 1000
  }
  return null
}

// Text typed in the edit view as a value for the field; empty is the default.
// undefined when it is not a number where one is needed.
function parse(f, text) {
  var raw = String(text === undefined || text === null ? "" : text).trim()
  if (raw === "") return f.defaultValue
  if (f.type === "integer" || f.type === "number") {
    var n = Number(raw.replace(",", "."))
    return isFinite(n) ? n : undefined
  }
  return raw
}

// What the edit view says under the field: the allowed values.
function hint(f) {
  if (f.type === "integer") return ["A whole number from %1 to %2. Empty uses the default.", [f.min, f.max]]
  if (f.type === "number") return ["A number from %1 to %2. Empty uses the default.", [f.min, f.max]]
  return ["Empty uses the default.", []]
}

// Every field's value from a shell.json entry, defaults for anything missing
// or invalid. Prefs is kit/FoamyPrefs.js.
function resolve(Prefs, entry) {
  return Prefs.values(fields, entry && typeof entry === "object" ? entry : {})
}

// The built-in scopes with these settings applied: the SSH scope's switch and
// the web searches' saved searches and suggestions. A scope file can still
// override a built-in afterwards.
function applyToScopes(builtins, settings) {
  return builtins.map(function(scope) {
    var next = {}
    for (var k in scope) next[k] = scope[k]
    if (scope.id === "ssh") next.enabled = settings.sshScope
    if (scope.source && scope.source.type === "query") {
      next.history = settings.webSearchHistory
      next.suggest = settings.webSearchSuggestions
    }
    return next
  })
}

if (typeof module !== "undefined") module.exports = {
  fields: fields, SECTIONS: SECTIONS, field: field, resolve: resolve, applyToScopes: applyToScopes,
  display: display, stepped: stepped, parse: parse, hint: hint
}
