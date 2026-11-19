// The Todoist input (td + Tab): Todoist's Quick Add syntax read from the
// typed text, the preview card, suggestions for projects, sections, labels
// and people, the search of the open tasks, and the Foamy Todoist helper's
// replies. Pure: no QML, no processes (services/TodoistSource.qml runs the
// helper).
//
// The tokenizer's word rule and the suggestion matching are copied and
// adapted from Foamy Todoist's Model.js (suggestions, projectBefore,
// matchNames, applySuggestion, memberLists, labelList) and
// native/src/todoist.rs (names_project), foamy-todoist commit 1d4fb0b (D7:
// copied until a third copy calls for a shared module). The adaptations: the
// lists come from the helper's `names` reply, which has no user record, and
// the tokenizer also finds p1–p4, !reminder, {deadline} and " // description".
// The task search's plainText and word rule are copied from the same file
// at the same commit (plainText, searchRows); see matchTasks.
//
// Dates are not read here (D14): Todoist parses them on its server, in the
// account's language, so a date stays in the title as typed and the card
// shows the date Todoist set once the task is added.

// The helper contract this menu speaks (foamy-todoist's `contract` field).
var CONTRACT = 1
// Todoist's own limit; the helper checks it too.
var MAX_TEXT = 500
var MAX_SUGGESTIONS = 6
// The task search: results while typing (Ctrl+1…9 open them), and the
// shortest title it searches for.
var MAX_TASK_RESULTS = 9
var MIN_TASK_QUERY = 2
// Tasks listed under "Added from here", newest first, kept for the shell
// session only.
var MAX_RECENT = 5
// Bytes of stdout read from one helper run (cappedCommand()). At the
// helper's own caps (2 000 projects, 5 000 sections, 2 000 labels and
// collaborators, 20 000 memberships, 1 000 tasks of 200 characters) with
// every text at its longest, `names` is about 12 MB, so this leaves room; a
// larger reply is refused, not cut. A real account is a few KB.
var MAX_NAMES_OUTPUT = 16 * 1024 * 1024
var MAX_REPLY_OUTPUT = 256 * 1024
// The helper's own caps on what `names` lists; a reply with more is not one
// this menu reads.
var MAX_PROJECTS = 2000
var MAX_SECTIONS = 5000
var MAX_LABELS = 2000
var MAX_PEOPLE = 2000
var MAX_MEMBERSHIPS = 20000
// Kept in the shell's memory and searched on every keystroke: small.
var MAX_TASKS = 1000
var MAX_NAME = 1000
// The notify request's limits (contract: stdin at most 16 KiB, and the
// request goes with a newline after it, so one byte less).
var MAX_NOTIFY_BYTES = 16 * 1024 - 1
var MAX_NOTIFY_LABELS = 50
// When Todoist asks to wait without saying how long, and the longest wait
// taken from it.
var DEFAULT_RETRY_SECONDS = 60
var MAX_RETRY_SECONDS = 86400

// A run of the helper: `timeout` ends the whole process group at the
// deadline (SIGTERM, SIGKILL KILL_AFTER later), as the Todoist panel runs it;
// the helper's own run budget is 25 s. The watchdog gives up WATCHDOG_GRACE_MS
// after that.
var DEADLINE = "30s"
var DEADLINE_MS = 30000
var KILL_AFTER = "2s"
var WATCHDOG_GRACE_MS = 3000
// The fixed script a helper run goes through: the helper and its arguments
// are its positional parameters, never script text. `head -c` closes the pipe
// at $1 bytes, so the helper dies of SIGPIPE on its next write and pipefail
// reports exit 141 (CAPPED_EXIT); the TERM trap keeps bash, timeout's direct
// child, alive until the pipeline ends, so the helper still gets timeout's
// SIGKILL. The helper's standard input is bash's, the launcher's pipe.
var CAPPED_SCRIPT = 'trap : TERM; set -o pipefail; "${@:2}" | head -c "$1"'
var CAPPED_EXIT = 141

// The helper's error keys the card can show, from foamy-todoist's
// i18n/en.json (tests/i18n.test.js keeps both catalogs covering them).
var HELPER_MESSAGES = [
  "A task can have at most 500 characters.",
  "Another Todoist update is still running. Try again.",
  "Can't create a request id (%1).",
  "Can't reach Todoist. Check your connection.",
  "Can't save the Todoist cache (%1).",
  "Can't use the Todoist cache (%1).",
  "Can't use the Todoist lock file (%1).",
  "Enter a task.",
  "HTTPS isn't supported on this CPU (foamy helpers need AES, carry-less multiply, AVX2, BMI2 and ADX on x86-64, or the crypto extensions on ARMv8)",
  "No keyring is available to store the Todoist token (%1).",
  "No keyring is available to store the Todoist token.",
  "Not signed in to Todoist.",
  "The keyring that holds the Todoist token is locked. Unlock it and try again.",
  "The request can't be read.",
  "The request is too large.",
  "The request isn't valid JSON.",
  "The request to Todoist is too large.",
  "The Todoist helper failed.",
  "Todoist answered HTTP %1.",
  "Todoist didn't accept the API token.",
  "Todoist didn't answer in time.",
  "Todoist is limiting requests. Try again in %1 seconds.",
  "Todoist is limiting requests. Try again later.",
  "Todoist sent an oversized reply.",
  "Todoist sent an unexpected reply."
]

// ---- helpers ------------------------------------------------------------------

// A map with no prototype: names and ids from the user's data ("constructor",
// "__proto__") stay ordinary keys.
function dict() {
  return Object.create(null)
}

function has(map, key) {
  return !!map && typeof map === "object" && Object.prototype.hasOwnProperty.call(map, key)
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// The panel's id rule (Model.validId).
function validId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id)
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function name(value) {
  return typeof value === "string" && value !== "" && value.length <= MAX_NAME ? value : ""
}

// Control characters out, so a name or message is one line of plain text.
function oneLine(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
}

// Characters as the helper counts them (Rust chars: code points), not
// UTF-16 units: an emoji is one, and a cut never splits its surrogate pair
// (an unpaired half is JSON the helper refuses).
function charCount(text) {
  return Array.from(String(text)).length
}

function firstChars(text, max) {
  var s = String(text)
  return s.length <= max ? s : Array.from(s).slice(0, max).join("")
}

function unescapeSpaces(text) {
  return text.replace(/\\ /g, " ")
}

// Task content as plain text: [text](url) links show their text; bold,
// italic, strikethrough and code markers are dropped. Markers inside words
// (snake_case, 2*3*4) stay. Copied from foamy-todoist's Model.js
// (plainText), commit 1d4fb0b.
function plainText(text) {
  if (typeof text !== "string")
    return ""
  return text
    .replace(/!?\[([^\]\n]*)\]\((?:[^()\s]|\([^()\s]*\))*\)/g, "$1")
    .replace(/(^|[^\w*])(\*\*|__)(?=\S)([^\n]*?\S)\2(?![\w*])/g, "$1$3")
    .replace(/(^|[^\w*])([*_])(?=\S)([^\n*_]*?\S)\2(?![\w*])/g, "$1$3")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
}

// ---- tokens -------------------------------------------------------------------

// Whether text[at] is whitespace that ends a word: a space escaped as `\ `
// belongs to the word (Quick Add reads `#My\ Project` as one name).
function breaksWord(text, at) {
  return /\s/.test(text.charAt(at)) && text.charAt(at - 1) !== "\\"
}

// Where " // description" starts: `//` at the start or after whitespace,
// followed by whitespace or the end. -1 without one. Everything after it is
// the description; no token is read there.
function descriptionStart(text) {
  var found = /(^|\s)\/\/(?=\s|$)/.exec(text)
  return found ? found.index + found[1].length : -1
}

// The Quick Add tokens in `text`, in order: {kind, start, end, value}. Kinds:
// project (#name), section (/name), label (@name), assignee (+name, only
// after a #project), priority (p1–p4, value 1–4), reminder (!text), deadline
// ({text}, braces closed) and description (" // text" to the end). A token
// starts at the start or after whitespace (names_project's rule: `C#` and
// `email#1` are not projects); names may hold `\ ` escapes, undone in value.
function tokens(text) {
  var s = String(text || "")
  var out = []
  // Over Todoist's limit nothing is added anyway: no tokens, so a long
  // paste (the field takes 16 KiB) can't build thousands of coloured runs
  // and chips on the shell's UI thread. The card says it is too long.
  if (s.length > MAX_TEXT && charCount(s.trim()) > MAX_TEXT)
    return out
  var description = descriptionStart(s)
  var limit = description >= 0 ? description : s.length
  var projectSeen = false
  var i = 0
  while (i < limit) {
    if (/\s/.test(s.charAt(i))) {
      i++
      continue
    }
    var end = i
    while (end < limit && !breaksWord(s, end))
      end++
    var word = s.slice(i, end)
    var first = word.charAt(0)
    if (first === "{") {
      var close = s.indexOf("}", i + 1)
      if (close > i + 1 && close < limit) {
        out.push({ kind: "deadline", start: i, end: close + 1, value: s.slice(i + 1, close).trim() })
        i = close + 1
        continue
      }
    } else if (word.length > 1 && (first === "#" || first === "/" || first === "@" || (first === "+" && projectSeen))) {
      var kind = { "#": "project", "/": "section", "@": "label", "+": "assignee" }[first]
      out.push({ kind: kind, start: i, end: end, value: unescapeSpaces(word.slice(1)) })
      if (kind === "project")
        projectSeen = true
    } else if (/^p[1-4]$/.test(word)) {
      out.push({ kind: "priority", start: i, end: end, value: Number(word.charAt(1)) })
    } else if (word.length > 1 && first === "!") {
      out.push({ kind: "reminder", start: i, end: end, value: word.slice(1) })
    }
    i = end
  }
  if (description >= 0)
    out.push({ kind: "description", start: description, end: s.length, value: s.slice(description + 2).trim() })
  return out
}

// The text split into runs for drawing: {start, end, text, kind}, kind
// "plain" between tokens. The runs cover the whole text, in order.
function runs(text) {
  var s = String(text || "")
  var out = []
  var at = 0
  var list = tokens(s)
  for (var i = 0; i < list.length; i++) {
    if (list[i].start > at)
      out.push({ start: at, end: list[i].start, text: s.slice(at, list[i].start), kind: "plain" })
    out.push({ start: list[i].start, end: list[i].end, text: s.slice(list[i].start, list[i].end), kind: list[i].kind })
    at = list[i].end
  }
  if (at < s.length)
    out.push({ start: at, end: s.length, text: s.slice(at), kind: "plain" })
  return out
}

// The token the caret is in or right after (its end), or null.
function caretToken(list, caret) {
  for (var i = 0; i < list.length; i++)
    if (caret > list[i].start && caret <= list[i].end)
      return list[i]
  return null
}

// The project a name matches (ignoring case), or null.
function findProject(model, value) {
  if (!model)
    return null
  var lower = String(value || "").toLowerCase()
  for (var id in model.projects)
    if (model.projects[id].name.toLowerCase() === lower)
      return model.projects[id]
  return null
}

// What the card shows for the typed text: the title (the text without the
// tokens Todoist takes out, escapes undone, spaces collapsed) and one chip
// per token, {kind, text, unknown}. With the project list loaded, a #project
// that names none is a muted chip and stays in the title, as Quick Add keeps
// it; without the list every #project counts, and so does the one the caret
// is still in (its name is being typed).
function preview(text, model, caret) {
  var s = String(text || "")
  var list = tokens(s)
  var chips = []
  var title = ""
  var at = 0
  for (var i = 0; i < list.length; i++) {
    var token = list[i]
    var keep = false
    var chip = { kind: token.kind, text: "", unknown: false }
    if (token.kind === "project") {
      var project = model ? findProject(model, token.value) : null
      chip.text = project ? project.name : token.value
      // A partial list (the helper hit a bound) can't say a project is
      // missing, so only a complete one marks it unknown.
      chip.unknown = !!model && !model.truncated && !project && !(caret > token.start && caret <= token.end)
      keep = chip.unknown
    } else if (token.kind === "priority") {
      chip.text = "P" + token.value
    } else {
      chip.text = token.value
    }
    if (chip.text !== "" && token.kind !== "description")
      chips.push(chip)
    title += s.slice(at, keep ? token.end : token.start)
    at = token.end
  }
  title += s.slice(at)
  return { title: unescapeSpaces(title).replace(/\s+/g, " ").trim(), chips: chips }
}

// ---- suggestions --------------------------------------------------------------

// The word at the caret when it is a `#project`, `/section`, `@label` or
// `+person`: the trigger at the start or after whitespace, then up to the
// caret (an escaped space belongs to the word). {kind, key, start, end,
// query, items}: `end` is where the word ends (it may go on past the
// caret), `query` the text between the trigger and the caret (escapes
// undone), `items` the matches, `key` names the word ("12:project") so a
// list closed with Esc stays closed while the word is edited. null without
// a trigger, inside the description, or for a /section or +person with no
// known #project before it (Model.suggestions).
function suggestions(model, text, caret) {
  if (!model || typeof text !== "string" || !(caret > 0) || caret > text.length)
    return null
  var description = descriptionStart(text)
  if (description >= 0 && caret > description)
    return null
  var start = caret
  while (start > 0 && !breaksWord(text, start - 1))
    start--
  var kind = { "#": "project", "@": "label", "/": "section", "+": "assignee" }[text.charAt(start)]
  if (!kind)
    return null
  var end = caret
  while (end < text.length && !breaksWord(text, end))
    end++
  var query = unescapeSpaces(text.slice(start + 1, caret))
  var pool
  if (kind === "project")
    pool = model.projectList.map(function (project) {
      return { kind: "project", id: project.id, name: project.name }
    })
  else if (kind === "label")
    pool = model.labels.map(function (label) {
      return { kind: "label", name: label }
    })
  else {
    var project = projectBefore(model, text, start)
    if (!project)
      return null
    if (kind === "section")
      pool = model.sectionList.filter(function (section) {
        return section.projectId === project.id
      }).map(function (section) {
        return { kind: "section", name: section.name }
      })
    else if (!project.assignable)
      return null
    else
      pool = (has(model.members, project.id) ? model.members[project.id] : []).map(function (person) {
        return { kind: "assignee", name: person.name, email: person.email }
      })
  }
  return { kind: kind, key: start + ":" + kind, start: start, end: end, query: query, items: matchNames(pool, query) }
}

// The project the last `#name` token before `at` names, or null.
function projectBefore(model, text, at) {
  var token = /(^|\s)#((?:\\ |\S)+)/g
  var value = ""
  var found
  var before = text.slice(0, at)
  while ((found = token.exec(before)) !== null)
    value = unescapeSpaces(found[2])
  return value ? findProject(model, value) : null
}

// Prefix matches first, then the rest that contain the query, each by name
// (case-insensitive), at most MAX_SUGGESTIONS. Each item gets where the
// match is (matchStart, matchLength).
function matchNames(pool, query) {
  var needle = query.toLowerCase()
  var prefix = []
  var inside = []
  pool.forEach(function (item) {
    var at = item.name.toLowerCase().indexOf(needle)
    if (at < 0)
      return
    item.matchStart = at
    item.matchLength = needle.length
    if (at === 0)
      prefix.push(item)
    else
      inside.push(item)
  })
  var byName = function (a, b) {
    return compare(a.name.toLowerCase(), b.name.toLowerCase()) || compare(a.name, b.name)
  }
  return prefix.sort(byName).concat(inside.sort(byName)).slice(0, MAX_SUGGESTIONS)
}

// The word replaced by `#Name`, `/Name`, `@name` or `+Name` (spaces escaped
// as `\ `, as Quick Add reads them), then one space (unless one follows
// already); the caret after that space. {text, cursor}, as QueryEdit edits.
function applySuggestion(text, start, end, item) {
  var token = ({ project: "#", label: "@", section: "/", assignee: "+" })[item.kind] + item.name.replace(/ /g, "\\ ")
  var rest = text.slice(end)
  var spaced = /^\s/.test(rest) ? rest : " " + rest
  return { text: text.slice(0, start) + token + spaced, cursor: start + token.length + 1 }
}

// ---- the helper's replies -----------------------------------------------------

// One reply: the last line of the output, parsed, or null.
function parseReply(text) {
  var lines = String(text || "").trim().split("\n")
  try {
    var reply = JSON.parse(lines[lines.length - 1])
    return isObject(reply) ? reply : null
  } catch (e) {
    return null
  }
}

// A helper message: a catalog key, then the values for its %1, %2…
// (U+001F separated). {key, values}; an empty or odd message is the
// helper's generic failure.
function messageParts(message) {
  if (typeof message !== "string" || message === "" || message.length > 4096)
    return { key: "The Todoist helper failed.", values: [] }
  var parts = message.split("\u001f")
  return { key: parts[0], values: parts.slice(1).map(oneLine) }
}

// The seconds Todoist asked to wait: retry_after, at most a day, else
// DEFAULT_RETRY_SECONDS.
function retrySeconds(reply) {
  var seconds = reply && typeof reply.retry_after === "number" && reply.retry_after > 0 ? Math.ceil(reply.retry_after) : DEFAULT_RETRY_SECONDS
  return Math.min(seconds, MAX_RETRY_SECONDS)
}

// The `names` reply as the suggestions and the task search read it: {state,
// inboxProjectId, projects (id -> project), projectList, sectionList, labels
// (names), members (project id -> people), tasks (readTasks), truncated}, or
// null when the reply is not one this contract describes. Records that don't
// fit are skipped; lists longer than the helper's caps refuse the reply.
function readNames(reply) {
  if (!isObject(reply) || reply.ok !== true || reply.contract !== CONTRACT)
    return null
  if (reply.state !== "signed_in" && reply.state !== "signed_out")
    return null
  var lists = { projects: MAX_PROJECTS, sections: MAX_SECTIONS, labels: MAX_LABELS, collaborators: MAX_PEOPLE, tasks: MAX_TASKS }
  for (var key in lists)
    if (!Array.isArray(reply[key]) || reply[key].length > lists[key])
      return null
  if (!isObject(reply.project_collaborators))
    return null
  var model = {
    state: reply.state,
    inboxProjectId: validId(reply.inbox_project_id) ? reply.inbox_project_id : "",
    projects: dict(),
    projectList: [],
    sectionList: [],
    labels: [],
    members: dict(),
    tasks: [],
    truncated: reply.truncated === true
  }
  reply.projects.forEach(function (raw) {
    if (isObject(raw) && validId(raw.id) && name(raw.name) && !model.projects[raw.id]) {
      model.projects[raw.id] = { id: raw.id, name: raw.name, inbox: raw.inbox === true, shared: raw.shared === true, assignable: false }
      model.projectList.push(model.projects[raw.id])
    }
  })
  reply.sections.forEach(function (raw) {
    if (isObject(raw) && validId(raw.id) && validId(raw.project_id) && name(raw.name))
      model.sectionList.push({ id: raw.id, projectId: raw.project_id, name: raw.name })
  })
  var seen = dict()
  reply.labels.forEach(function (raw) {
    if (name(raw) && !seen[raw.toLowerCase()]) {
      seen[raw.toLowerCase()] = true
      model.labels.push(raw)
    }
  })
  var people = dict()
  reply.collaborators.forEach(function (raw) {
    if (isObject(raw) && validId(raw.id) && name(raw.full_name))
      people[raw.id] = { id: raw.id, name: raw.full_name, email: typeof raw.email === "string" && raw.email.length <= MAX_NAME ? raw.email : "" }
  })
  // Assignable: shared, or two or more people active in it (team and
  // workspace projects come with shared false), as memberLists decides.
  var memberships = 0
  for (var projectId in reply.project_collaborators) {
    var ids = reply.project_collaborators[projectId]
    if (!Array.isArray(ids))
      return null
    memberships += ids.length
    if (memberships > MAX_MEMBERSHIPS)
      return null
  }
  model.projectList.forEach(function (project) {
    var ids = has(reply.project_collaborators, project.id) ? reply.project_collaborators[project.id] : []
    project.assignable = project.shared || ids.length >= 2
    if (!project.assignable)
      return
    model.members[project.id] = ids.filter(function (who) {
      return typeof who === "string" && has(people, who)
    }).map(function (who) {
      return people[who]
    }).sort(function (a, b) {
      return compare(a.name.toLowerCase(), b.name.toLowerCase())
    })
  })
  model.tasks = readTasks(reply.tasks, model.projects)
  return model
}

// The open tasks the search matches, in the order `names` gives: {id,
// content (plain text, one line), project (its name or ""), due (Todoist's
// text for the date or ""), haystack}. The haystack is what searchRows
// matches (the content, the project name, the labels), lowercased here once
// so a keystroke only compares.
function readTasks(list, projects) {
  var seen = dict()
  var out = []
  list.forEach(function (raw) {
    if (!isObject(raw) || !validId(raw.id) || seen[raw.id] || typeof raw.content !== "string")
      return
    seen[raw.id] = true
    var project = typeof raw.project_id === "string" && has(projects, raw.project_id) ? projects[raw.project_id].name : ""
    var labels = Array.isArray(raw.labels) ? raw.labels.filter(function (label) {
      return name(label) !== ""
    }) : []
    var content = firstChars(oneLine(plainText(raw.content)), MAX_TEXT)
    out.push({
      id: raw.id,
      content: content,
      project: project,
      due: isObject(raw.due) && typeof raw.due.string === "string" ? firstChars(oneLine(raw.due.string), 200) : "",
      // The day it is due (YYYY-MM-DD), shown from today's point of view;
      // a recurring task shows Todoist's text ("every Monday") instead.
      dueDay: isObject(raw.due) && raw.due.is_recurring !== true && typeof raw.due.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw.due.date) ? raw.due.date.slice(0, 10) : "",
      haystack: [content, project].concat(labels).join("\n").toLowerCase()
    })
  })
  return out
}

// The tasks whose content, project name or labels hold every word of the
// query (ignoring case; `@word` matches the label), the first
// MAX_TASK_RESULTS in the order `names` gives; none for a query shorter than
// MIN_TASK_QUERY characters. The word rule and the match are copied from
// foamy-todoist's Model.js (searchRows), commit 1d4fb0b; adapted: the
// haystacks come from readTasks, and the results are not grouped.
function matchTasks(model, query) {
  if (!model || !model.tasks || charCount(String(query || "").trim()) < MIN_TASK_QUERY)
    return []
  var words = String(query || "").toLowerCase().split(/\s+/).filter(function (word) {
    return word !== ""
  }).map(function (word) {
    return word.charAt(0) === "@" && word.length > 1 ? word.slice(1) : word
  })
  if (!words.length)
    return []
  var out = []
  for (var i = 0; i < model.tasks.length && out.length < MAX_TASK_RESULTS; i++) {
    var haystack = model.tasks[i].haystack
    if (words.every(function (word) {
      return haystack.indexOf(word) >= 0
    }))
      out.push(model.tasks[i])
  }
  return out
}

// An added task from the short `add` reply, checked: {id, content, project,
// projectInbox, sectionId, priority, labels, due}, `due` Todoist's own text
// for the date ("tomorrow 9am" reads as Todoist wrote it), or null.
function readTask(reply) {
  if (!validId(reply.added))
    return null
  var task = isObject(reply.task) && reply.task.id === reply.added ? reply.task : null
  var project = isObject(reply.project) && validId(reply.project.id) ? reply.project : null
  var labels = task && Array.isArray(task.labels) ? task.labels.filter(function (label) {
    return name(label) !== ""
  }).slice(0, MAX_NOTIFY_LABELS) : []
  var due = task && isObject(task.due) && typeof task.due.string === "string" ? firstChars(oneLine(task.due.string), 200) : ""
  return {
    id: reply.added,
    content: task && typeof task.content === "string" ? firstChars(oneLine(task.content), MAX_TEXT) : "",
    project: project ? firstChars(oneLine(name(project.name)), 200) : "",
    projectInbox: !!project && project.inbox === true,
    sectionId: task && validId(task.section_id) ? task.section_id : "",
    priority: task && typeof task.priority === "number" && task.priority >= 1 && task.priority <= 4 ? Math.round(task.priority) : 1,
    labels: labels,
    due: due
  }
}

// Where a helper run ended, from its exit and output: {kind, message,
// retryAfter, task, warning, code}. Kinds: added, refused (Todoist or the
// helper said no; Enter again retries), signedOut, rateLimited (Enter waits
// retryAfter seconds), unknown (the request may have gone out: the task may
// exist), needsUpdate (not this contract) and unavailable (no helper for
// this CPU). `run` is {exitCode, exitStatus, output, capped, timedOut}.
//
// For `add`, an end without a reply after the helper started (a deadline, a
// crash, a cut reply) is unknown, never a plain failure: Quick Add may have
// answered already, and adding again could make a duplicate.
function addOutcome(run) {
  if (run.unavailable)
    return { kind: "unavailable", message: { key: "Foamy Todoist isn't available on this computer", values: [] } }
  if (run.timedOut || run.capped)
    return { kind: "unknown", message: { key: "Todoist may have added it. Check Todoist before you add it again.", values: [] } }
  var reply = parseReply(run.output)
  if (!reply)
    return { kind: "unknown", message: { key: "Todoist may have added it. Check Todoist before you add it again.", values: [] } }
  if (reply.ok === true) {
    if (reply.contract !== CONTRACT)
      return { kind: "needsUpdate", message: { key: "Foamy Todoist needs an update", values: [] } }
    var task = readTask(reply)
    if (!task)
      return { kind: "unknown", message: { key: "Todoist may have added it. Check Todoist before you add it again.", values: [] } }
    var out = { kind: "added", task: task, warning: null, retryAfter: 0 }
    if (typeof reply.warning === "string" && reply.warning !== "")
      out.warning = messageParts(reply.warning)
    if (reply.warning_code === "RATE_LIMITED")
      out.retryAfter = retrySeconds(reply)
    return out
  }
  // Only a well-formed refusal says the task was not added; anything else
  // (no `ok`, no code) can't, so Enter must not resend it unasked.
  if (reply.ok !== false || typeof reply.code !== "string" || reply.code === "" || typeof reply.error !== "string")
    return { kind: "unknown", message: { key: "Todoist may have added it. Check Todoist before you add it again.", values: [] } }
  var code = reply.code
  var message = messageParts(reply.error)
  if (code === "UNKNOWN_OUTCOME")
    return { kind: "unknown", code: code, message: { key: "Todoist may have added it. Check Todoist before you add it again.", values: [] } }
  if (code === "SIGNED_OUT" || code === "INVALID_TOKEN")
    return { kind: "signedOut", code: code, message: message }
  if (code === "RATE_LIMITED")
    return { kind: "rateLimited", code: code, message: message, retryAfter: retrySeconds(reply) }
  return { kind: "refused", code: code, message: message }
}

// Where a `names` run ended: {kind: "ready", model} | {kind: "signedOut",
// model} | {kind: "needsUpdate"} | {kind: "unavailable"} | {kind: "failed",
// detail}. A failed one only means no suggestions: adding still works.
function namesOutcome(run) {
  if (run.unavailable)
    return { kind: "unavailable" }
  if (run.timedOut)
    return { kind: "failed", detail: "timed out" }
  if (run.capped)
    return { kind: "failed", detail: "the reply is over " + MAX_NAMES_OUTPUT + " bytes" }
  var reply = parseReply(run.output)
  if (!reply)
    return { kind: "failed", detail: "no reply (exit " + run.exitCode + ")" }
  // A helper from before `names` refuses the command as INVALID_ARGUMENT.
  if (reply.ok !== true)
    return reply.code === "INVALID_ARGUMENT" ? { kind: "needsUpdate" } : { kind: "failed", detail: typeof reply.code === "string" ? reply.code : "error" }
  var model = readNames(reply)
  if (!model)
    return { kind: "needsUpdate" }
  return { kind: model.state === "signed_out" ? "signedOut" : "ready", model: model }
}

// ---- requests -----------------------------------------------------------------

// The `add` request: the text as typed (Todoist's Quick Add reads it) and the
// short reply. null for text Todoist would refuse.
function addRequest(text) {
  var t = String(text || "").trim()
  if (!t || charCount(t) > MAX_TEXT)
    return null
  return { text: t, reply: "task" }
}

function utf8Length(text) {
  var bytes = 0
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xD800 && code <= 0xDBFF) { bytes += 4; i++ }
    else bytes += 3
  }
  return bytes
}

function clip(value, max) {
  return firstChars(oneLine(value), max)
}

// The `notify` request (contract 1): kind added | failed | unknown, the
// translated headline, detail and button label, the typed text and, for an
// added task, the task. Every field within its limit; labels go first, then
// the detail, when the whole request would pass MAX_NOTIFY_BYTES.
function notifyRequest(kind, texts, text, task) {
  var request = {
    kind: kind,
    title: clip(texts.title, 200) || "Todoist",
    detail: clip(texts.detail, 1000),
    open_label: clip(texts.open, 100) || "Todoist",
    text: clip(text, MAX_TEXT),
    task: kind === "added" && task ? {
      id: task.id,
      // A reply without the task (cut by the helper's bounds) leaves no
      // content; the helper needs some, so the typed text stands in, as on
      // the card and under Added from here.
      content: clip(task.content, MAX_TEXT) || clip(String(text || "").trim(), MAX_TEXT),
      project: clip(task.project, 200),
      due: clip(task.due, 200),
      labels: task.labels.slice(0, MAX_NOTIFY_LABELS).map(function (label) {
        return clip(label, 100)
      })
    } : null
  }
  var encoded = JSON.stringify(request)
  while (utf8Length(encoded) > MAX_NOTIFY_BYTES && request.task && request.task.labels.length) {
    request.task.labels.pop()
    encoded = JSON.stringify(request)
  }
  if (utf8Length(encoded) > MAX_NOTIFY_BYTES) {
    request.detail = ""
    encoded = JSON.stringify(request)
  }
  return encoded
}

// One helper run's argv after `timeout`: the bundled helper through
// FoamyNative's wrapper (`native`, its argv for the command), its stdout cut
// at maxBytes.
function cappedCommand(native, maxBytes) {
  return ["timeout", "--kill-after=" + KILL_AFTER, DEADLINE, "bash", "-c", CAPPED_SCRIPT, "foamy-todoist", String(maxBytes)].concat(native)
}

function wasCapped(exitCode, exitStatus) {
  return exitStatus === 0 && exitCode === CAPPED_EXIT
}

// Whether a run ended at its deadline: timeout exits 124 after its SIGTERM,
// or is itself SIGKILLed (exit 9 as a crash) when the group outlived it.
function timedOut(exitCode, exitStatus, elapsedMs) {
  return elapsedMs >= DEADLINE_MS && (exitStatus === 0 ? exitCode === 124 : exitCode === 9)
}

// ---- the card -----------------------------------------------------------------

// The syntax chips the empty card shows.
var SYNTAX = [
  { kind: "date", text: "tomorrow 9am" },
  { kind: "project", text: "#Project" },
  { kind: "section", text: "/Section" },
  { kind: "label", text: "@label" },
  { kind: "priority", text: "p1–p4" },
  { kind: "reminder", text: "!reminder" },
  { kind: "deadline", text: "{deadline}" },
  { kind: "description", text: "// description" }
]

// The chips for an added task, from Todoist's reply.
function taskChips(task) {
  var chips = []
  if (task.due)
    chips.push({ kind: "date", text: task.due, unknown: false })
  if (task.project)
    chips.push({ kind: "project", text: task.project, unknown: false })
  task.labels.forEach(function (label) {
    chips.push({ kind: "label", text: label, unknown: false })
  })
  if (task.priority > 1)
    chips.push({ kind: "priority", text: "P" + (5 - task.priority), unknown: false })
  return chips
}

// The card for the field's text: {state, title, chips, status}. state is
// empty, typing, adding, added, refused, unknown, rateLimited, signedOut,
// needsUpdate or unavailable; status is null or {tone, text, values,
// spinner} with an English template the UI translates (tone: muted, accent,
// success, warning, error). `s` is TodoistSource's state: {availability, adding, addingText,
// result, retryUntil, confirming}; `nowMs` the clock; `caret` where the
// cursor is (or undefined). `literal`: the title is what was typed or what
// Todoist made of it, never a text to translate.
function card(text, model, s, nowMs, caret) {
  var t = String(text || "")
  var p = preview(t, model, caret)
  var status = null
  function line(tone, english, values, spinner) {
    return { tone: tone, text: english, values: values || [], spinner: !!spinner }
  }
  if (s.availability === "needsUpdate")
    return { state: "needsUpdate", literal: false, title: "Foamy Todoist needs an update", chips: [], status: line("error", "Update Foamy Todoist to add tasks here.") }
  if (s.availability === "unavailable")
    return { state: "unavailable", literal: false, title: "Foamy Todoist isn't available on this computer", chips: [], status: line("error", "Its helper has no build for this CPU.") }
  if (s.adding) {
    var adding = preview(s.addingText, model)
    return { state: "adding", literal: true, title: adding.title, chips: adding.chips, status: line("accent", "Adding to Todoist…", [], true) }
  }
  var result = s.result
  if (result && result.kind === "added" && t.trim() === "") {
    var done = { state: "added", literal: true, title: result.task.content || result.text, chips: taskChips(result.task), status: line("success", "Added to Todoist") }
    if (result.warning)
      done.status = line("warning", result.warning.key, result.warning.values)
    return done
  }
  var waitSeconds = s.retryUntil > nowMs ? Math.ceil((s.retryUntil - nowMs) / 1000) : 0
  if (waitSeconds > 0)
    status = line("warning", "Todoist asked to wait %1 s", [waitSeconds])
  else if (s.availability === "signedOut")
    status = line("error", "Foamy Todoist is signed out")
  else if (result && result.text === t.trim() && result.kind === "unknown")
    status = line("warning", s.confirming ? "Press ↵ again to add it anyway." : result.message.key, s.confirming ? [] : result.message.values)
  else if (result && result.text === t.trim() && (result.kind === "refused" || result.kind === "signedOut"))
    status = line("error", result.message.key, result.message.values)
  if (!p.title && !p.chips.length) {
    if (s.availability === "signedOut")
      return { state: "signedOut", literal: false, title: "Foamy Todoist is signed out", chips: [], status: line("muted", "Sign in from Foamy Todoist's settings to add tasks here.") }
    return { state: "empty", literal: false, title: "Type a task the way Todoist's Quick Add reads it", chips: SYNTAX.map(function (c) {
      return { kind: c.kind, text: c.text, unknown: false }
    }), status: status }
  }
  var state = "typing"
  if (waitSeconds > 0)
    state = "rateLimited"
  else if (s.availability === "signedOut")
    state = "signedOut"
  else if (result && result.text === t.trim() && (result.kind === "unknown" || result.kind === "refused"))
    state = result.kind
  if (charCount(t.trim()) > MAX_TEXT && !status)
    status = line("error", "A task can have at most 500 characters.")
  // A names reply cut at one of the helper's caps (projects, tasks, …).
  if (!status && model && model.truncated)
    status = line("muted", "Suggestions show part of your Todoist: it has more than Foamy Todoist keeps.")
  // A status line only when there is something to say.
  return { state: state, literal: true, title: p.title, chips: p.chips, status: status }
}

// Whether Enter adds now: not during an add, nor while Todoist asks to wait,
// nor with a helper this menu can't use, and with text Todoist takes.
function canAdd(text, s, nowMs) {
  return !s.adding && !(s.retryUntil > nowMs) && s.availability !== "needsUpdate" && s.availability !== "unavailable" && addRequest(text) !== null
}

// A task added from here, for "Added from here".
function recentEntry(task, text, nowMs) {
  return { id: task.id, content: task.content || String(text || "").trim(), project: task.project, due: task.due, addedAt: nowMs }
}

function pushRecent(list, entry) {
  return [entry].concat((list || []).filter(function (e) {
    return e.id !== entry.id
  })).slice(0, MAX_RECENT)
}

// ---- rows and actions ---------------------------------------------------------

var CARD_ID = "todoist:card"
// What each chip starts with.
var CHIP_MARKS = { date: "◷ ", project: "# ", section: "/ ", label: "@ ", assignee: "+ ", priority: "⚑ ", reminder: "! ", deadline: "{" }
var GLYPHS = { project: "#", section: "/", label: "@", assignee: "+" }
var SUGGESTION_TITLES = { project: "Projects", section: "Sections", label: "Labels", assignee: "People" }
var SUGGESTION_TYPES = { project: "Project", section: "Section", label: "Label", assignee: "Person" }
// Nerd Font glyphs: md-open-in-new, md-inbox, md-checkbox-marked-circle-outline.
var OPEN_GLYPH = "\u{f03cc}"
var INBOX_GLYPH = "\u{f0687}"
var TASK_GLYPH = "\u{f0134}"

function row(id, kind, title, extra) {
  var c = { id: id, type: "command", kind: kind, title: title, subtitle: "", keywords: [], typeLabel: "", glyph: "", rootSearch: { when: "never" } }
  for (var k in extra || {})
    c[k] = extra[k]
  return c
}

// The suggestions shown for the caret, or null: none while adding, and none
// for a word whose list was closed with Esc (hiddenKey).
function shownSuggestions(model, text, cursor, s, hiddenKey) {
  if (s.adding)
    return null
  var found = suggestions(model, text, cursor)
  return found && found.items.length && found.key !== hiddenKey ? found : null
}

// Where a task row's id starts: todoist:task:<id>, a task the search found.
var TASK_ROW = "todoist:task:"

function isTaskRow(rowId) {
  return String(rowId || "").indexOf(TASK_ROW) === 0
}

// The tasks the search shows for the typed text: matches of the card's
// title, only while the field has text, no suggestion list is showing and
// no add is running.
function shownTasks(text, cursor, env) {
  var s = String(text || "")
  if (env.state.adding || s.trim() === "" || shownSuggestions(env.model, s, cursor, env.state, env.hiddenKey))
    return []
  return matchTasks(env.model, preview(s, env.model, cursor).title)
}

// When a searched task is due, as of now: Today, Tomorrow, Yesterday or a
// short date (env.formatDay, the language's "ddd d MMM"); Todoist's own
// text for a recurring task, since its next date moves. Todoist's text for
// a one-off date ("tomorrow") would go stale once the day passes.
function dueLabel(task, env) {
  if (!task.dueDay)
    return task.due
  var parts = task.dueDay.split("-")
  var due = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
  var now = new Date(env.nowMs || Date.now())
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  var days = Math.round((due - today) / 86400000)
  var t = typeof env.t === "function" ? env.t : function (s) { return s }
  if (days === 0)
    return t("Today")
  if (days === 1)
    return t("Tomorrow")
  if (days === -1)
    return t("Yesterday")
  return typeof env.formatDay === "function" ? env.formatDay(task.dueDay) : task.dueDay
}

// A task row's subtitle: its project, then its date.
function whereLine(project, due) {
  return [project, due].filter(function (part) {
    return part
  }).join(" · ")
}

// The Todoist input's list: the card first, then the row the card's state
// offers (Open Inbox after an unknown outcome,
// Open Foamy Todoist when signed out), then the suggestions for the word at
// the caret, or else, with text in the field, the tasks it matches
// (Ctrl+1…9 open them), or, with the field empty, the tasks added from here.
// `env`: {model, state (see card()), recent, nowMs, hiddenKey, t
// (translate), relative (RootSearch's relativeParts)}. Every text the UI
// shows is translated here; what the user typed never goes through t().
function sections(text, cursor, env) {
  var t = env.t
  var s = env.state
  var c = card(text, env.model, s, env.nowMs, cursor)
  var shown = {
    state: c.state,
    literal: c.literal,
    title: c.literal ? c.title : t(c.title),
    chips: c.chips.map(function (chip) {
      // The syntax help shows the syntax itself, its example date in the
      // picked language; other chips get their mark.
      if (c.state === "empty")
        return { kind: chip.kind, label: chip.kind === "date" ? t(chip.text) : chip.text, unknown: false }
      var label = CHIP_MARKS[chip.kind] + chip.text + (chip.kind === "deadline" ? "}" : "")
      return { kind: chip.kind, label: chip.unknown ? t("%1 (new or unknown project)", [label]) : label, unknown: chip.unknown }
    }),
    status: c.status ? { tone: c.status.tone, text: t(c.status.text, c.status.values), spinner: c.status.spinner } : null
  }
  var hasText = String(text || "").trim() !== ""
  // caretKey: the word at the caret that could list suggestions, hidden or
  // not, so the launcher can forget an Esc once that word is gone.
  var atCaret = s.adding ? null : suggestions(env.model, String(text || ""), cursor)
  var out = [{ id: "todoist-card", title: "", caretKey: atCaret ? atCaret.key : "", rows: [{ candidate: row(CARD_ID, "todoist-card", shown.title, { card: JSON.stringify(shown), selectable: hasText || c.state === "added" }), record: null }] }]
  var offered = []
  if (c.state === "unknown")
    offered.push(row("todoist:open-inbox", "todoist-action", t("Open Inbox in Todoist"), { glyph: INBOX_GLYPH }))
  if (c.state === "signedOut")
    offered.push(row("todoist:open-app", "todoist-action", t("Open Foamy Todoist"), { glyph: OPEN_GLYPH }))
  if (offered.length)
    out.push({ id: "todoist-offered", title: "", rows: offered.map(function (r) {
      return { candidate: r, record: null }
    }) })
  var found = shownSuggestions(env.model, String(text || ""), cursor, s, env.hiddenKey)
  if (found) {
    out.push({ id: "todoist-suggestions:" + found.key, title: SUGGESTION_TITLES[found.kind], rows: found.items.map(function (item, i) {
      return { candidate: row("todoist:suggest:" + i, "todoist-suggestion", item.name, { subtitle: item.email || "", glyph: GLYPHS[item.kind], typeLabel: SUGGESTION_TYPES[item.kind] }), record: null }
    }) })
    return out
  }
  // With text in the field the tasks it matches take the place of Added
  // from here, which only an empty field shows.
  if (hasText) {
    var tasks = shownTasks(text, cursor, env)
    if (tasks.length)
      out.push({ id: "todoist-tasks", title: "Tasks", rows: tasks.map(function (task, i) {
        return { candidate: row(TASK_ROW + task.id, "todoist-task", task.content, { subtitle: whereLine(task.project, dueLabel(task, env)), glyph: TASK_GLYPH, typeLabel: "Ctrl %1", typeLabelValues: [i + 1], typeIsKeys: true }), record: null }
      }) })
    return out
  }
  var recent = env.recent || []
  if (recent.length)
    out.push({ id: "todoist-recent", title: "Added from here", rows: recent.map(function (e) {
      var when = env.relative(e.addedAt, env.nowMs)
      return { candidate: row("todoist:recent:" + e.id, "todoist-recent", e.content, { subtitle: whereLine(e.project, e.due), glyph: TASK_GLYPH, typeLabel: when[0], typeLabelValues: when[1] }), record: null }
    }) })
  return out
}

// The task a row opens (Open in Todoist, a task added from here, a task the
// search found), or "".
function rowTask(rowId) {
  var match = /^todoist:(?:open-task|recent|task):(.+)$/.exec(String(rowId || ""))
  return match && validId(match[1]) ? match[1] : ""
}

// Which Ctrl+1…9 opens a task row: its place among the tasks shown for the
// text, or 0 when it is not one of them.
function taskNumber(rowId, text, cursor, env) {
  if (!isTaskRow(rowId))
    return 0
  var id = rowTask(rowId)
  var tasks = shownTasks(text, cursor, env)
  for (var i = 0; i < tasks.length; i++)
    if (tasks[i].id === id)
      return i + 1
  return 0
}

// The suggestion Tab inserts for a row: the row's own, or the first one when
// the card is selected. {text, cursor} after the insert, or null.
function insertFor(rowId, text, cursor, env) {
  var found = shownSuggestions(env.model, String(text || ""), cursor, env.state, env.hiddenKey)
  if (!found)
    return null
  var match = /^todoist:suggest:([0-9]+)$/.exec(String(rowId || ""))
  var index = match ? Number(match[1]) : (rowId === CARD_ID ? 0 : -1)
  if (index < 0 || index >= found.items.length)
    return null
  return applySuggestion(String(text || ""), found.start, found.end, found.items[index])
}

// The actions for a row of the input, the first one Enter's. With text in
// the field Enter adds the task whatever row is selected (it never inserts a
// suggestion); with the field empty Enter runs the selected row. English
// titles, translated by the launcher. `closeOnAdd` is the
// todoistCloseOnAdd setting: Shift+Enter does the other.
function actions(rowId, text, cursor, env, closeOnAdd) {
  var list = []
  function add(id, title, shortcut, section) {
    list.push({ id: id, title: title, shortcut: shortcut || "", section: section || "primary", icon: "" })
  }
  var task = rowTask(rowId)
  if (String(text || "").trim() !== "") {
    add("todoist-add", "Add Task", "↵")
    add("todoist-add-alt", closeOnAdd ? "Add and Keep Open" : "Add and Close", "Shift ↵")
    if (insertFor(rowId, text, cursor, env))
      add("todoist-insert", "Insert", "Tab")
    // A task the search found: Enter still adds, its Ctrl+N or a click opens it.
    var number = taskNumber(rowId, text, cursor, env)
    if (number)
      add("open", "Open in Todoist", "Ctrl " + number)
  } else if (task)
    add("open", "Open in Todoist", "↵")
  // The card after an add is the task: Enter or Ctrl+O opens it.
  else if (rowId === CARD_ID && env.lastTaskId)
    add("todoist-open-last", "Open in Todoist", "Ctrl O")
  else if (rowId === "todoist:open-inbox")
    add("open", "Open Inbox in Todoist", "↵")
  else if (rowId === "todoist:open-app")
    add("open", "Open Foamy Todoist", "↵")
  // After an unknown outcome the text stays and Enter adds it again, so the
  // way to check Todoist first must not depend on an empty field.
  var result = env.state && env.state.result
  if (result && result.kind === "unknown" && !(rowId === "todoist:open-inbox" && String(text || "").trim() === ""))
    add("todoist-open-inbox", "Open Inbox in Todoist", "")
  var last = env.lastTaskId
  if (last && last !== task && !(list.length && list[0].id === "todoist-open-last"))
    add("todoist-open-last", "Open in Todoist", "Ctrl O")
  // Not twice: on its own row with the field empty it is already Enter's.
  if (!(rowId === "todoist:open-app" && String(text || "").trim() === ""))
    add("todoist-open-app", "Open Foamy Todoist", "")
  if (String(text || "").trim() !== "")
    add("todoist-copy-text", "Copy Text", "Ctrl Shift C", "copy")
  return list
}

if (typeof module !== "undefined") {
  module.exports = {
    CONTRACT: CONTRACT, MAX_TEXT: MAX_TEXT, MAX_SUGGESTIONS: MAX_SUGGESTIONS, MAX_RECENT: MAX_RECENT,
    MAX_TASKS: MAX_TASKS, MAX_TASK_RESULTS: MAX_TASK_RESULTS, MIN_TASK_QUERY: MIN_TASK_QUERY,
    plainText: plainText, readTasks: readTasks, dueLabel: dueLabel, matchTasks: matchTasks, TASK_ROW: TASK_ROW, isTaskRow: isTaskRow,
    shownTasks: shownTasks, taskNumber: taskNumber,
    MAX_NAMES_OUTPUT: MAX_NAMES_OUTPUT, MAX_REPLY_OUTPUT: MAX_REPLY_OUTPUT, MAX_NOTIFY_BYTES: MAX_NOTIFY_BYTES,
    DEADLINE_MS: DEADLINE_MS, WATCHDOG_GRACE_MS: WATCHDOG_GRACE_MS, CAPPED_SCRIPT: CAPPED_SCRIPT, CAPPED_EXIT: CAPPED_EXIT,
    HELPER_MESSAGES: HELPER_MESSAGES, SYNTAX: SYNTAX,
    validId: validId, charCount: charCount, firstChars: firstChars, tokens: tokens, runs: runs, caretToken: caretToken, descriptionStart: descriptionStart,
    preview: preview, suggestions: suggestions, projectBefore: projectBefore, matchNames: matchNames,
    applySuggestion: applySuggestion, parseReply: parseReply, messageParts: messageParts, retrySeconds: retrySeconds,
    readNames: readNames, readTask: readTask, addOutcome: addOutcome, namesOutcome: namesOutcome,
    addRequest: addRequest, notifyRequest: notifyRequest, utf8Length: utf8Length, cappedCommand: cappedCommand,
    wasCapped: wasCapped, timedOut: timedOut, card: card, canAdd: canAdd, taskChips: taskChips,
    recentEntry: recentEntry, pushRecent: pushRecent,
    CARD_ID: CARD_ID, sections: sections, rowTask: rowTask, insertFor: insertFor, actions: actions
  }
}
