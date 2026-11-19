// core/TodoistInput.js: Quick Add tokens, the card, suggestions, and the
// helper's replies read against contract 1.
const test = require("node:test")
const assert = require("node:assert/strict")
const TI = require("../core/TodoistInput.js")

const kinds = (text) => TI.tokens(text).map((t) => [t.kind, text.slice(t.start, t.end), t.value])

test("tokens: each Quick Add token kind, where Todoist reads one", () => {
  const cases = [
    ["Buy milk #Home", [["project", "#Home", "Home"]]],
    ["Call #My\\ Project now", [["project", "#My\\ Project", "My Project"]]],
    ["Plan #Work /Next\\ week", [["project", "#Work", "Work"], ["section", "/Next\\ week", "Next week"]]],
    ["Ring Ola @phone @errands", [["label", "@phone", "phone"], ["label", "@errands", "errands"]]],
    ["Review #Team +Kari", [["project", "#Team", "Team"], ["assignee", "+Kari", "Kari"]]],
    ["Score +1 for this", []],
    ["Fix it p1", [["priority", "p1", 1]]],
    ["p4 first", [["priority", "p4", 4]]],
    ["p5 and P2 and ap1", []],
    ["Leave !30min", [["reminder", "!30min", "30min"]]],
    ["Hello! and ! alone", []],
    ["File taxes {april 30}", [["deadline", "{april 30}", "april 30"]]],
    ["Open {brace", []],
    ["Write report // with #tags @inside p1", [["description", "// with #tags @inside p1", "with #tags @inside p1"]]],
    ["a//b and http://x", []],
    ["C# notes for email#1 and a@b.no", []],
    ["# alone, @ alone and / alone", []],
    ["Buy milk", []]
  ]
  for (const [text, expected] of cases) assert.deepEqual(kinds(text), expected, text)
})

test("tokens: date words are left to Todoist (D14)", () => {
  assert.deepEqual(kinds("Call the dentist tomorrow 9am"), [])
  assert.deepEqual(kinds("i morgen kl 9 every monday"), [])
})

test("runs cover the whole text, in order, with each token's kind", () => {
  const text = "Call #Home @phone p2 !9am {fri} // notes"
  const runs = TI.runs(text)
  assert.equal(runs.map((r) => r.text).join(""), text)
  assert.deepEqual(runs.filter((r) => r.kind !== "plain").map((r) => r.kind), ["project", "label", "priority", "reminder", "deadline", "description"])
  for (let i = 1; i < runs.length; i++) assert.equal(runs[i].start, runs[i - 1].end)
  assert.deepEqual(TI.runs(""), [])
})

test("the caret token is the one the caret is in or right after", () => {
  const list = TI.tokens("Buy #Ho milk")
  assert.equal(TI.caretToken(list, 7).kind, "project")
  assert.equal(TI.caretToken(list, 4), null, "before the trigger")
  assert.equal(TI.caretToken(list, 8), null, "past the space")
})

const names = {
  ok: true, contract: 1, state: "signed_in", inbox_project_id: "inbox1",
  projects: [
    { id: "inbox1", name: "Inbox", parent_id: null, child_order: 0, inbox: true, shared: false },
    { id: "home1", name: "Home", parent_id: null, child_order: 1, inbox: false, shared: false },
    { id: "lab1", name: "Homelab", parent_id: null, child_order: 2, inbox: false, shared: false },
    { id: "team1", name: "Team Plans", parent_id: null, child_order: 3, inbox: false, shared: true },
    { id: "bad id", name: "Broken" }
  ],
  sections: [{ id: "s1", project_id: "home1", name: "Garden", section_order: 1 }, { id: "s2", project_id: "team1", name: "Next week", section_order: 1 }],
  labels: ["phone", "phone-calls", "Errands", "errands", 7],
  collaborators: [{ id: "u1", full_name: "Kari Nordmann", email: "kari@example.org" }, { id: "u2", full_name: "Ola", email: "ola@example.org" }],
  project_collaborators: { team1: ["u2", "u1", "nobody"] },
  truncated: false
}

test("readNames checks the contract and the shapes, and skips records that don't fit", () => {
  const model = TI.readNames(names)
  assert.deepEqual(model.projectList.map((p) => p.id), ["inbox1", "home1", "lab1", "team1"])
  assert.deepEqual(model.labels, ["phone", "phone-calls", "Errands"], "one per name, ignoring case")
  assert.equal(model.inboxProjectId, "inbox1")
  assert.deepEqual(model.members.team1.map((p) => p.name), ["Kari Nordmann", "Ola"])
  assert.equal(model.projects.home1.assignable, false)
  assert.equal(TI.readNames({ ...names, contract: undefined }), null, "no contract")
  assert.equal(TI.readNames({ ...names, contract: 2 }), null, "another contract")
  assert.equal(TI.readNames({ ...names, projects: "x" }), null)
  assert.equal(TI.readNames({ ...names, labels: Array.from({ length: 2001 }, () => "x") }), null, "over the helper's cap")
  assert.equal(TI.readNames({ ...names, state: "maybe" }), null)
  const out = TI.readNames({ ...names, projects: [{ id: "__proto__", name: "Proto" }, { id: "constructor", name: "Ctor" }] })
  assert.deepEqual(out.projectList.map((p) => p.name), ["Proto", "Ctor"], "ids from the user's data are plain keys")
})

const model = TI.readNames(names)

test("preview: the title without the tokens, one chip per token, unknown projects kept", () => {
  assert.deepEqual(TI.preview("Call the dentist tomorrow 9am #Home @phone p2", model), {
    title: "Call the dentist tomorrow 9am",
    chips: [{ kind: "project", text: "Home", unknown: false }, { kind: "label", text: "phone", unknown: false }, { kind: "priority", text: "P2", unknown: false }]
  })
  const unknown = TI.preview("Buy paint #Garage", model)
  assert.equal(unknown.title, "Buy paint #Garage", "Quick Add keeps an unknown #project in the title")
  assert.deepEqual(unknown.chips, [{ kind: "project", text: "Garage", unknown: true }])
  assert.equal(TI.preview("Buy paint #Garage", null).title, "Buy paint", "without the list every #project counts")
  assert.deepEqual(TI.preview("Buy paint #Gar", model, 14), { title: "Buy paint", chips: [{ kind: "project", text: "Gar", unknown: false }] }, "a name still being typed is not unknown yet")
  assert.equal(TI.preview("Plan #team\\ plans trip", model).chips[0].text, "Team Plans", "matched ignoring case, shown as named")
  assert.equal(TI.preview("Write\\ it   up // the details", model).title, "Write it up")
  assert.deepEqual(TI.preview("", model), { title: "", chips: [] })
})

test("suggestions: projects, labels, sections of the #project before, people of a shared project", () => {
  const at = (text, caret) => TI.suggestions(model, text, caret === undefined ? text.length : caret)
  const projects = at("Buy #ho")
  assert.equal(projects.kind, "project")
  assert.deepEqual(projects.items.map((i) => i.name), ["Home", "Homelab"])
  assert.equal(projects.query, "ho")
  assert.deepEqual(at("Call @ph").items.map((i) => i.name), ["phone", "phone-calls"])
  assert.deepEqual(at("Call @zzz").items, [], "no match: an empty list")
  assert.deepEqual(at("Dig #Home /ga").items.map((i) => i.name), ["Garden"])
  assert.equal(at("Dig /ga"), null, "a section needs a project before it")
  assert.equal(at("Dig #Nowhere /ga"), null)
  assert.deepEqual(at("Meet #Team\\ Plans +ka").items.map((i) => [i.name, i.email]), [["Kari Nordmann", "kari@example.org"]])
  assert.equal(at("Fix #Home +ka"), null, "nobody to assign in a personal project")
  assert.equal(at("Buy milk"), null)
  assert.equal(at("C#"), null, "C# is not a project")
  assert.equal(at("Notes // #ho"), null, "nothing inside the description")
  assert.deepEqual(at("Buy #Ho milk", 7).items.map((i) => i.name), ["Home", "Homelab"], "the word ends past the caret")
  assert.equal(at("Buy #Ho milk", 7).end, 7)
  assert.equal(at("#").query, "", "the trigger alone lists everything")
  assert.equal(at("#").items.length, 4)
})

test("matchNames: prefix matches first, then the rest, at most six", () => {
  const pool = ["Garden", "Garage", "Big garage", "a", "b", "c", "garx", "gary"].map((name) => ({ kind: "label", name }))
  const items = TI.matchNames(pool, "gar")
  assert.deepEqual(items.map((i) => i.name), ["Garage", "Garden", "garx", "gary", "Big garage"])
  assert.deepEqual([items[4].matchStart, items[4].matchLength], [4, 3])
  assert.equal(TI.matchNames(pool, "").length, TI.MAX_SUGGESTIONS)
})

test("applySuggestion: the word replaced, spaces escaped, one space after", () => {
  assert.deepEqual(TI.applySuggestion("Plan #te", 5, 8, { kind: "project", name: "Team Plans" }), { text: "Plan #Team\\ Plans ", cursor: 18 })
  assert.deepEqual(TI.applySuggestion("Call @ph now", 5, 8, { kind: "label", name: "phone" }), { text: "Call @phone now", cursor: 12 })
  assert.deepEqual(TI.applySuggestion("x /g", 2, 4, { kind: "section", name: "Garden" }), { text: "x /Garden ", cursor: 10 })
  assert.deepEqual(TI.applySuggestion("+k", 0, 2, { kind: "assignee", name: "Kari Nordmann" }), { text: "+Kari\\ Nordmann ", cursor: 16 })
})

const run = (reply, extra) => ({ exitCode: 0, exitStatus: 0, output: typeof reply === "string" ? reply : JSON.stringify(reply) + "\n", ...extra })
const added = {
  ok: true, contract: 1, added: "t1",
  task: { id: "t1", content: "Call the dentist", project_id: "home1", section_id: null, priority: 3, labels: ["phone"], due: { date: "2026-11-20T09:00:00", is_recurring: false, string: "tomorrow 9am" } },
  project: { id: "home1", name: "Home", inbox: false }
}

test("addOutcome: each helper reply and exit, as the error table reads them", () => {
  const ok = TI.addOutcome(run(added))
  assert.equal(ok.kind, "added")
  assert.deepEqual(ok.task, { id: "t1", content: "Call the dentist", project: "Home", projectInbox: false, sectionId: "", priority: 3, labels: ["phone"], due: "tomorrow 9am" })
  const warned = TI.addOutcome(run({ ...added, warning: "Can't save the Todoist cache (%1).\u001fdisk full", warning_code: "RATE_LIMITED", retry_after: 12, stale: true }))
  assert.deepEqual([warned.kind, warned.warning, warned.retryAfter], ["added", { key: "Can't save the Todoist cache (%1).", values: ["disk full"] }, 12])
  const cases = [
    [{ ok: false, contract: 1, code: "SIGNED_OUT", error: "Not signed in to Todoist." }, "signedOut"],
    [{ ok: false, contract: 1, code: "INVALID_TOKEN", error: "Todoist didn't accept the API token." }, "signedOut"],
    [{ ok: false, contract: 1, code: "KEYRING_LOCKED", error: "The keyring that holds the Todoist token is locked. Unlock it and try again." }, "refused"],
    [{ ok: false, contract: 1, code: "NETWORK", error: "Can't reach Todoist. Check your connection." }, "refused"],
    [{ ok: false, contract: 1, code: "HTTP", error: "Todoist answered HTTP %1.\u001f503" }, "refused"],
    [{ ok: false, contract: 1, code: "BUSY", error: "Another Todoist update is still running. Try again." }, "refused"],
    [{ ok: false, contract: 1, code: "UNKNOWN_OUTCOME", error: "Todoist didn't answer. The task may have been added: check the list before adding it again." }, "unknown"],
    [{ ok: false, contract: 1, code: "RATE_LIMITED", error: "Todoist is limiting requests. Try again in %1 seconds.\u001f30", retry_after: 30 }, "rateLimited"],
    [{ ok: true, added: "t1" }, "needsUpdate"],
    [{ ok: true, contract: 1 }, "unknown"],
    ["not json", "unknown"],
    ["", "unknown"]
  ]
  for (const [reply, kind] of cases) assert.equal(TI.addOutcome(run(reply)).kind, kind, JSON.stringify(reply))
  assert.deepEqual(TI.addOutcome(run(cases[4][0])).message, { key: "Todoist answered HTTP %1.", values: ["503"] })
  assert.equal(TI.addOutcome(run(cases[7][0])).retryAfter, 30)
  assert.equal(TI.addOutcome(run({ ok: false, code: "RATE_LIMITED", error: "x" })).retryAfter, 60, "no retry_after: a minute")
  assert.equal(TI.addOutcome(run({ ok: false, code: "RATE_LIMITED", error: "x", retry_after: 1e9 })).retryAfter, 86400, "at most a day")
  assert.equal(TI.addOutcome(run("", { timedOut: true })).kind, "unknown", "the menu's deadline: the request may have gone out")
  assert.equal(TI.addOutcome(run("", { capped: true })).kind, "unknown")
  assert.equal(TI.addOutcome(run("", { unavailable: true })).kind, "unavailable")
  assert.equal(TI.addOutcome(run({ ok: false, code: "X", error: 5 })).kind, "unknown", "a refusal without its message is not a well-formed one")
})

test("namesOutcome: ready, signed out, a helper to update, a failure that only hides suggestions", () => {
  assert.equal(TI.namesOutcome(run(names)).kind, "ready")
  const out = TI.namesOutcome(run({ ...names, state: "signed_out", projects: [], sections: [], labels: [], collaborators: [], project_collaborators: {}, inbox_project_id: null }))
  assert.equal(out.kind, "signedOut")
  assert.equal(out.model.inboxProjectId, "")
  assert.equal(TI.namesOutcome(run({ ok: false, code: "INVALID_ARGUMENT", error: "The Todoist helper was called with the wrong arguments." })).kind, "needsUpdate", "a helper from before names")
  assert.equal(TI.namesOutcome(run({ ...names, contract: undefined })).kind, "needsUpdate")
  assert.equal(TI.namesOutcome(run({ ok: false, contract: 1, code: "BUSY", error: "x" })).kind, "failed")
  assert.equal(TI.namesOutcome(run("", { capped: true })).kind, "failed")
  assert.equal(TI.namesOutcome(run("", { timedOut: true })).kind, "failed")
  assert.equal(TI.namesOutcome(run("", { unavailable: true })).kind, "unavailable")
})

test("addRequest: the text as typed, 1–500 characters, with the short reply", () => {
  assert.deepEqual(TI.addRequest("  Buy milk #Home  "), { text: "Buy milk #Home", reply: "task" })
  assert.equal(TI.addRequest("   "), null)
  assert.equal(TI.addRequest("x".repeat(501)), null)
  assert.ok(TI.addRequest("x".repeat(500)))
})

test("notifyRequest: within every limit, labels dropped first when it would pass 16 KiB", () => {
  const task = { id: "t1", content: "Call\nthe dentist", project: "Home", due: "tomorrow 9am", labels: ["phone"] }
  const request = JSON.parse(TI.notifyRequest("added", { title: "Added to Todoist", detail: "", open: "Open in Todoist" }, "", task))
  assert.deepEqual(request, { kind: "added", title: "Added to Todoist", detail: "", open_label: "Open in Todoist", text: "", task: { id: "t1", content: "Call the dentist", project: "Home", due: "tomorrow 9am", labels: ["phone"] } })
  const failed = JSON.parse(TI.notifyRequest("failed", { title: "Could not add the task", detail: "No network", open: "Open Inbox in Todoist" }, "Buy milk", task))
  assert.equal(failed.task, null, "only an added task goes along")
  const wide = "𝔵".repeat(400)
  const big = TI.notifyRequest("added", { title: wide, detail: wide.repeat(3), open: wide }, wide, { ...task, content: wide, project: wide, due: wide, labels: Array.from({ length: 80 }, () => wide) })
  assert.ok(TI.utf8Length(big) + 1 <= 16 * 1024, "with its newline within the helper's 16 KiB: " + TI.utf8Length(big))
  const parsed = JSON.parse(big)
  assert.ok(TI.charCount(parsed.title) <= 200 && TI.charCount(parsed.open_label) <= 100 && parsed.task.labels.length <= 50)
})

test("notify and add count and cut characters as the helper does: an emoji is one, never split", () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  const label = "a".repeat(99) + "😀" + "b"
  const task = { id: "t1", content: "c".repeat(499) + "😀😀", project: "p".repeat(199) + "😀😀", due: "", labels: [label] }
  const encoded = TI.notifyRequest("added", { title: "t".repeat(199) + "😀😀", detail: "", open: "o" }, "", task)
  assert.ok(!lone.test(encoded), "no unpaired surrogate")
  const request = JSON.parse(encoded)
  assert.equal(request.task.labels[0], "a".repeat(99) + "😀")
  assert.equal(TI.charCount(request.task.content), 500)
  assert.equal(TI.charCount(request.task.project), 200)
  assert.equal(TI.charCount(request.title), 200)
  const read = TI.readTask({ added: "t1", task: { id: "t1", content: "c".repeat(499) + "😀😀", labels: [], due: { string: "d".repeat(199) + "😀😀" } }, project: null })
  assert.ok(!lone.test(read.content + read.due))
  assert.equal(TI.charCount(read.content), 500)
  // 499 characters and an emoji are 500 for the helper, not 501.
  assert.deepEqual(TI.addRequest("x".repeat(499) + "😀"), { text: "x".repeat(499) + "😀", reply: "task" })
  assert.equal(TI.addRequest("x".repeat(500) + "😀"), null)
})

test("text over 500 characters has no tokens: one plain run, no chips, the card says why", () => {
  const flood = "x " + "@a ".repeat(5460)
  assert.deepEqual(TI.tokens(flood), [])
  assert.equal(TI.runs(flood).length, 1)
  const card = TI.card(flood, null, { availability: "ready", adding: false, addingText: "", result: null, retryUntil: 0, confirming: false }, 0, flood.length)
  assert.equal(card.chips.length, 0)
  assert.equal(card.status.text, "A task can have at most 500 characters.")
  // At the limit the tokens are still read.
  assert.equal(TI.tokens("x".repeat(496) + " @ab").length, 1)
})

test("a cut names list is shown as partial: no project called unknown, and the card says so", () => {
  const idleState = { availability: "ready", adding: false, addingText: "", result: null, retryUntil: 0, confirming: false }
  const reply = { ok: true, contract: 1, state: "signed_in", inbox_project_id: null, projects: [{ id: "p1", name: "Home", inbox: false, shared: false }], sections: [], labels: [], collaborators: [], project_collaborators: {}, truncated: true }
  const partial = TI.readNames(reply)
  const card = TI.card("Buy milk #Garden", partial, idleState, 0, 0)
  assert.equal(card.chips[0].unknown, false)
  assert.equal(card.status.text, "Suggestions show part of your Todoist: it has more than Foamy Todoist keeps.")
  const whole = TI.readNames({ ...reply, truncated: false })
  const complete = TI.card("Buy milk #Garden", whole, idleState, 0, 0)
  assert.equal(complete.chips[0].unknown, true)
  assert.equal(complete.status.text, "Todoist reads the date when the task is added")
})

test("an add reply that is neither a success nor a well-formed refusal is an unknown outcome", () => {
  const out = (reply) => TI.addOutcome({ exitCode: 0, exitStatus: 0, output: JSON.stringify(reply) + "\n" }).kind
  assert.equal(out({ contract: 1, added: "t1" }), "unknown", "no ok")
  assert.equal(out({ ok: "false", code: "HTTP", error: "x", contract: 1 }), "unknown", "ok not a boolean")
  assert.equal(out({ ok: false, contract: 1, error: "x" }), "unknown", "no code")
  assert.equal(out({ ok: false, code: "HTTP", contract: 1 }), "unknown", "no message")
  assert.equal(out({ ok: false, code: "HTTP", error: "Todoist answered %1.\u001f500", contract: 1 }), "refused")
})

test("notify for an add whose reply had no task: the typed text is the content", () => {
  const task = TI.readTask({ added: "t1", task: null, project: null })
  assert.equal(task.content, "")
  const request = JSON.parse(TI.notifyRequest("added", { title: "Added to Todoist", detail: "", open: "Open in Todoist" }, "  Buy milk #Home ", task))
  assert.equal(request.task.content, "Buy milk #Home")
})

test("the helper runs under timeout and a fixed output cap; its argv never holds the text", () => {
  const argv = TI.cappedCommand(["bash", "-c", "exec x", "foamy-native", "/p", "foamy-todoist-helper", "add"], 1024)
  assert.deepEqual(argv.slice(0, 8), ["timeout", "--kill-after=2s", "30s", "bash", "-c", TI.CAPPED_SCRIPT, "foamy-todoist", "1024"])
  assert.equal(argv[argv.length - 1], "add")
  assert.ok(TI.wasCapped(141, 0) && !TI.wasCapped(141, 1) && !TI.wasCapped(0, 0))
  assert.ok(TI.timedOut(124, 0, 30000) && TI.timedOut(9, 1, 31000) && !TI.timedOut(124, 0, 100))
})

const idle = { availability: "ready", adding: false, addingText: "", result: null, retryUntil: 0, confirming: false }

test("card: every state of the States table", () => {
  const at = (text, s, now) => TI.card(text, model, { ...idle, ...s }, now || 1000)
  assert.equal(at("").state, "empty")
  assert.equal(at("").chips.length, TI.SYNTAX.length)
  const typing = at("Call the dentist tomorrow #Home")
  assert.deepEqual([typing.state, typing.title, typing.status.text], ["typing", "Call the dentist tomorrow", "Todoist reads the date when the task is added"])
  const adding = at("", { adding: true, addingText: "Call #Home" })
  assert.deepEqual([adding.state, adding.title, adding.status.spinner], ["adding", "Call", true])
  const task = TI.addOutcome(run(added)).task
  const done = at("", { result: { kind: "added", text: "Call the dentist tomorrow 9am #Home", task } })
  assert.deepEqual([done.state, done.title, done.chips.map((c) => c.text)], ["added", "Call the dentist", ["tomorrow 9am", "Home", "phone", "P2"]])
  assert.equal(at("Next", { result: { kind: "added", text: "x", task } }).state, "typing", "typing again after an add")
  const refused = at("Buy milk", { result: { kind: "refused", text: "Buy milk", message: { key: "Can't reach Todoist. Check your connection.", values: [] } } })
  assert.deepEqual([refused.state, refused.status.tone, refused.status.text], ["refused", "error", "Can't reach Todoist. Check your connection."])
  assert.equal(at("Buy milk!", { result: { kind: "refused", text: "Buy milk", message: { key: "x", values: [] } } }).state, "typing", "an edit leaves the failure")
  const unknown = { kind: "unknown", text: "Buy milk", message: { key: "Todoist may have added it. Check Todoist before you add it again.", values: [] } }
  assert.deepEqual([at("Buy milk", { result: unknown }).state, at("Buy milk", { result: unknown }).status.tone], ["unknown", "warning"])
  assert.equal(at("Buy milk", { result: unknown, confirming: true }).status.text, "Press ↵ again to add it anyway.")
  const waiting = at("Buy milk", { retryUntil: 31000 }, 1000)
  assert.deepEqual([waiting.state, waiting.status.text, waiting.status.values], ["rateLimited", "Todoist asked to wait %1 s", [30]])
  assert.equal(at("Buy milk", { retryUntil: 31000 }, 31000).state, "typing", "the wait ends")
  assert.equal(at("", { availability: "signedOut" }).state, "signedOut")
  assert.equal(at("", { availability: "signedOut" }).title, "Foamy Todoist is signed out")
  assert.equal(at("Buy milk", { availability: "signedOut" }).status.text, "Foamy Todoist is signed out")
  assert.equal(at("Buy milk", { availability: "needsUpdate" }).title, "Foamy Todoist needs an update")
  assert.equal(at("", { availability: "unavailable" }).title, "Foamy Todoist isn't available on this computer")
  assert.deepEqual([at("Buy milk", { availability: "signedOut" }).literal, at("", { availability: "signedOut" }).literal], [true, false], "typed text stays a title, never a template")
  assert.equal(at("x".repeat(501)).status.text, "A task can have at most 500 characters.")
})

test("canAdd: one add at a time, never while Todoist asks to wait or with a helper this menu can't use", () => {
  assert.ok(TI.canAdd("Buy milk", idle, 0))
  assert.ok(TI.canAdd("Buy milk", { ...idle, availability: "checking" }, 0))
  assert.ok(!TI.canAdd("Buy milk", { ...idle, adding: true }, 0))
  assert.ok(!TI.canAdd("Buy milk", { ...idle, retryUntil: 10 }, 5))
  assert.ok(TI.canAdd("Buy milk", { ...idle, retryUntil: 10 }, 10))
  assert.ok(!TI.canAdd("Buy milk", { ...idle, availability: "needsUpdate" }, 0))
  assert.ok(!TI.canAdd("Buy milk", { ...idle, availability: "unavailable" }, 0))
  assert.ok(!TI.canAdd(" ", idle, 0))
})

test("Added from here: newest first, each task once, at most five", () => {
  let list = []
  for (let i = 0; i < 7; i++) list = TI.pushRecent(list, TI.recentEntry({ id: "t" + i, content: "Task " + i, project: "Inbox", due: "" }, "", i))
  assert.deepEqual(list.map((e) => e.id), ["t6", "t5", "t4", "t3", "t2"])
  list = TI.pushRecent(list, TI.recentEntry({ id: "t4", content: "", project: "", due: "" }, " typed ", 9))
  assert.deepEqual(list.map((e) => e.id), ["t4", "t6", "t5", "t3", "t2"])
  assert.equal(list[0].content, "typed", "the typed text when Todoist's reply had none")
})

const env = (extra) => ({ model, state: idle, recent: [], nowMs: 5000, hiddenKey: "", lastTaskId: "", t: (s, v) => (v && v.length ? s.replace("%1", v[0]) : s), relative: () => ["Just now", []], ...extra })
const ids = (sections) => sections.flatMap((s) => s.rows.map((r) => r.candidate.id))

test("sections: the card, the offered row, then suggestions or the tasks added from here", () => {
  const recent = [TI.recentEntry({ id: "t1", content: "Call", project: "Home", due: "tomorrow" }, "", 1000)]
  assert.deepEqual(ids(TI.sections("", 0, env({ recent }))), ["todoist:card", "todoist:recent:t1"])
  const card = JSON.parse(TI.sections("", 0, env()).at(0).rows[0].candidate.card)
  assert.equal(card.state, "empty")
  assert.equal(TI.sections("", 0, env())[0].rows[0].candidate.selectable, false, "an empty card is not a row Enter runs")
  const typing = TI.sections("Buy #ho", 7, env({ recent }))
  assert.deepEqual(ids(typing), ["todoist:card", "todoist:suggest:0", "todoist:suggest:1"])
  assert.equal(typing[1].id, "todoist-suggestions:4:project")
  assert.equal(typing[1].title, "Projects")
  assert.deepEqual(ids(TI.sections("Buy #ho", 7, env({ recent, hiddenKey: "4:project" }))), ["todoist:card", "todoist:recent:t1"], "Esc closed the list")
  assert.deepEqual(ids(TI.sections("Buy #ho", 7, env({ state: { ...idle, adding: true, addingText: "Buy #ho" } }))), ["todoist:card"], "no list while adding")
  const task = TI.addOutcome(run(added)).task
  assert.deepEqual(ids(TI.sections("", 0, env({ state: { ...idle, result: { kind: "added", text: "x", task } } }))), ["todoist:card", "todoist:open-task:t1"])
  assert.deepEqual(ids(TI.sections("Buy", 3, env({ state: { ...idle, result: { kind: "unknown", text: "Buy", message: { key: "k", values: [] } } } }))), ["todoist:card", "todoist:open-inbox"])
  assert.deepEqual(ids(TI.sections("", 0, env({ state: { ...idle, availability: "signedOut" } }))), ["todoist:card", "todoist:open-app"])
  const literal = JSON.parse(TI.sections("Today", 5, env({ t: () => "TRANSLATED" }))[0].rows[0].candidate.card)
  assert.equal(literal.title, "Today", "typed text is never translated")
})

test("actions: with text Enter adds whatever row is selected; with none it runs the row", () => {
  const e = env({ lastTaskId: "t1" })
  assert.deepEqual(TI.actions("todoist:card", "Buy #ho", 7, e, false).map((a) => a.id), ["todoist-add", "todoist-add-alt", "todoist-insert", "todoist-open-last", "todoist-open-app", "todoist-copy-text"])
  assert.equal(TI.actions("todoist:suggest:1", "Buy #ho", 7, e, false)[0].id, "todoist-add", "Enter never inserts")
  assert.equal(TI.actions("todoist:card", "Buy", 3, e, true)[1].title, "Add and Keep Open")
  assert.equal(TI.actions("todoist:card", "Buy", 3, e, false)[1].title, "Add and Close")
  assert.deepEqual(TI.actions("todoist:recent:t1", "", 0, e, false).map((a) => a.id), ["open", "todoist-open-app"])
  // After an unknown outcome the kept text adds on Enter; the Inbox stays one action away on every row.
  const unknown = env({ state: { ...idle, result: { kind: "unknown", text: "Buy", message: { key: "k", values: [] } } } })
  assert.deepEqual(TI.actions("todoist:card", "Buy", 3, unknown, false).map((a) => a.id), ["todoist-add", "todoist-add-alt", "todoist-open-inbox", "todoist-open-app", "todoist-copy-text"])
  assert.deepEqual(TI.actions("todoist:open-inbox", "Buy", 3, unknown, false).map((a) => a.id), ["todoist-add", "todoist-add-alt", "todoist-open-inbox", "todoist-open-app", "todoist-copy-text"])
  assert.deepEqual(TI.actions("todoist:open-inbox", "", 0, unknown, false).map((a) => a.id), ["open", "todoist-open-app"])
  // Signed out with the draft kept: its recovery row still opens Foamy Todoist from Ctrl+K.
  assert.deepEqual(TI.actions("todoist:open-app", "Buy", 3, e, false).map((a) => a.id), ["todoist-add", "todoist-add-alt", "todoist-open-last", "todoist-open-app", "todoist-copy-text"])
  assert.deepEqual(TI.actions("todoist:open-app", "", 0, e, false).map((a) => a.id), ["open", "todoist-open-last"])
  assert.deepEqual(TI.actions("todoist:open-inbox", "", 0, env(), false).map((a) => [a.id, a.title]), [["open", "Open Inbox in Todoist"], ["todoist-open-app", "Open Foamy Todoist"]])
  assert.deepEqual(TI.insertFor("todoist:suggest:1", "Buy #ho", 7, e), { text: "Buy #Homelab ", cursor: 13 })
  assert.deepEqual(TI.insertFor("todoist:card", "Buy #ho", 7, e), { text: "Buy #Home ", cursor: 10 }, "Tab on the card inserts the first")
  assert.equal(TI.insertFor("todoist:card", "Buy milk", 8, e), null)
  assert.equal(TI.rowTask("todoist:recent:t1"), "t1")
  assert.equal(TI.rowTask("todoist:recent:bad id"), "")
})
