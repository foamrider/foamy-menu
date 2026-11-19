import QtQuick
import Quickshell
import Quickshell.Io
import "plugin" as Foamy

// The Todoist input end to end (tests/todoist.py): td + Tab, suggestions,
// Tab inserts, Enter adds once (Enter and typing during the add do nothing),
// the result card, Ctrl+O, the task search and Ctrl+2 opening its second
// result, an unknown outcome's second Enter, signed out, a
// names reply for an earlier visit dropped, close-on-add and Esc during an
// add, with notify run only while the launcher is closed. The fake helper
// and omarchy-shell record what they were asked.
ShellRoot {
  id: test
  property int stage: 0
  property int checks: 0
  property int attempts: 0
  property bool capturing: false
  readonly property var launcher: menu.launcherItem
  readonly property var backend: launcher.backendApi
  readonly property var view: launcher.window
  readonly property var todoist: backend.todoist
  readonly property bool norwegian: Quickshell.env("FOAMY_TEST_LANGUAGE") === "no"
  function said(english, norwegian) {
    return test.norwegian ? norwegian : english
  }
  function check(ok, detail) {
    if (!ok) {
      console.log("FOAMY FAIL " + detail)
      Qt.exit(1)
      return
    }
    checks++
    console.log("PASS " + detail)
  }
  // Holds the current stage until cond is true, or fails after 30 s.
  property double waitingSince: 0
  function waitFor(cond) {
    if (cond) {
      waitingSince = 0
      return false
    }
    if (!waitingSince)
      waitingSince = Date.now()
    if (Date.now() - waitingSince > 30000) {
      check(false, "timed out waiting at stage " + (stage - 1))
      return true
    }
    stage--
    return true
  }
  function type(text) {
    for (var i = 0; i < text.length; i++)
      view.handleKey({
        key: 0,
        modifiers: Qt.NoModifier,
        text: text.charAt(i)
      })
  }
  function key(code, modifiers) {
    view.handleKey({
      key: code,
      modifiers: modifiers || Qt.NoModifier,
      text: ""
    })
  }
  function capture(name, next) {
    var folder = Quickshell.env("FOAMY_MENU_SHOTS")
    if (!folder) {
      if (next)
        next()
      return
    }
    test.capturing = true
    view.cardItem.grabToImage(function (result) {
      test.check(result.saveToFile(folder + "/" + name + ".png"), "save " + name)
      test.capturing = false
      if (next)
        next()
    })
  }
  // The input's list as the launcher asks for it.
  function sections() {
    return backend.callSync("rootSearch.search", {
      query: view.query,
      view: view.view,
      cursor: view.cursorPos,
      hideSuggestions: view.todoistHiddenKey
    }).data
  }
  function card() {
    return JSON.parse(test.sections()[0].rows[0].card)
  }
  function rowIds() {
    return test.sections().reduce(function (all, s) {
      return all.concat(s.rows.map(function (r) {
        return r.id
      }))
    }, [])
  }
  // The fake helper's requests: [{command, request}].
  function calls(command) {
    helperLog.reload()
    return helperLog.text().split("\n").filter(function (l) {
      return l
    }).map(function (l) {
      return JSON.parse(l)
    }).filter(function (c) {
      return !command || c.command === command
    })
  }
  function shellCalls() {
    shellLog.reload()
    return shellLog.text().split("\n").filter(function (l) {
      return l
    })
  }
  property double since: 0
  Foamy.Menu {
    id: menu
    manifest: ({
        id: "foamy.menu",
        version: "0.0.0-runtime"
      })
  }
  FileView {
    id: helperLog
    path: Quickshell.env("FOAMY_TODOIST_FAKE_LOG")
    printErrors: false
    blockLoading: true
  }
  FileView {
    id: shellLog
    path: Quickshell.env("FOAMY_SHELL_LOG")
    printErrors: false
    blockLoading: true
  }
  // Turns the fake helper's slow names on and off.
  Process {
    id: flag
    property bool done: false
    onExited: flag.done = true
  }
  function slowNames(on) {
    flag.done = false
    flag.command = on ? ["touch", Quickshell.env("FOAMY_TODOIST_FAKE_STATE") + "/slow-names"] : ["rm", "-f", Quickshell.env("FOAMY_TODOIST_FAKE_STATE") + "/slow-names"]
    flag.running = true
  }
  Timer {
    running: true
    repeat: true
    interval: 250
    onTriggered: {
      if (test.capturing)
        return
      if (!backend.ready || backend.loading) {
        if (++test.attempts > 100) {
          test.check(false, "backend becomes ready")
          Qt.exit(1)
        }
        return
      }
      test.attempts = 0
      switch (test.stage++) {
      case 0:
        if (test.waitFor(test.todoist.installed && backend.scopes.some(function (s) {
          return s.id === "todoist"
        })))
          break
        test.check(backend.settings.todoistQuickAdd === true && backend.settings.todoistCloseOnAdd === false, "the Todoist settings come from shell.json")
        test.check(backend.paths.todoistPlugin.endsWith("/.config/omarchy/plugins/foamy.todoist"), "Foamy Todoist is found in Omarchy's plugin folder")
        view.implicitWidth = Number(Quickshell.env("FOAMY_TEST_WIDTH"))
        view.implicitHeight = 800
        menu.open('{"menu":"root"}')
        break
      case 1:
        test.check(launcher.opened, "the launcher opens")
        view.setQuery("td")
        key(Qt.Key_Tab)
        break
      case 2:
        test.check(view.view.kind === "scope" && view.view.scopeId === "todoist" && view.inputView, "td + Tab enters the Todoist input")
        // The fake's log is read through a FileView, which may lag a write.
        if (test.waitFor(test.todoist.availability === "ready" && test.calls("names").length >= 1))
          break
        test.check(test.calls("names").length === 1, "entering runs names once")
        test.check(view.placeholder === test.said("Add a task…", "Legg til en oppgave…"), "the input's placeholder")
        test.check(test.card().state === "empty" && test.card().chips.length === 8, "an empty field shows the syntax")
        test.check(view.selectedIndex === -1, "nothing for Enter to run yet")
        test.capture("empty", function () {
          view.setQuery("call the dentist #ho")
        })
        break
      case 3:
        test.check(view.todoistSuggestKey === "17:project", "a #word lists projects: " + view.todoistSuggestKey)
        test.check(test.rowIds().join() === "todoist:card,todoist:suggest:0,todoist:suggest:1", "Home and Homelab: " + test.rowIds())
        test.check(view.selectedRow && view.selectedRow.itemId === "todoist:card", "the card is selected")
        test.check(view.queryRuns.some(function (r) {
          return r.kind === "project" && r.text === "#ho"
        }), "the field colours the token")
        test.check(view.actionsForSelected()[0].id === "todoist-add", "Enter adds")
        test.capture("suggestions", function () {
          key(Qt.Key_Tab)
        })
        break
      case 4:
        test.check(view.query === "call the dentist #Home " && view.cursorPos === view.query.length, "Tab inserts the first suggestion: " + view.query)
        test.type("@ph")
        test.check(view.todoistSuggestKey === "23:label", "an @word lists labels")
        key(Qt.Key_Escape)
        test.check(view.inputView && view.query === "call the dentist #Home @ph" && view.todoistSuggestKey === "", "Esc closes the suggestions first")
        test.type("o")
        test.check(view.todoistSuggestKey === "", "the closed list stays closed in the same word")
        key(Qt.Key_Escape)
        test.check(view.inputView && view.query === "", "then Esc clears the text")
        test.type("call the dentist #Home @ph")
        test.check(view.todoistSuggestKey === "23:label", "a new word in the same place lists again")
        view.setQuery("call the dentist slow #Home @phone p2")
        test.check(test.card().title === "call the dentist slow" && test.card().chips.map(function (c) {
          return c.kind
        }).join() === "project,label,priority", "the card reads the tokens: " + JSON.stringify(test.card()))
        test.capture("typing", function () {
          key(Qt.Key_Return)
        })
        break
      case 5:
        test.check(backend.todoistAdding && test.card().state === "adding", "Enter adds")
        test.type("x")
        key(Qt.Key_Backspace)
        key(Qt.Key_Return)
        test.check(view.query === "call the dentist slow #Home @phone p2", "the text is locked while adding")
        test.capture("adding")
        break
      case 6:
        if (test.waitFor(!backend.todoistAdding && test.calls("add").length >= 1))
          break
        test.check(test.calls("add").length === 1, "Enter during an add is ignored")
        test.check(JSON.stringify(test.calls("add")[0].request) === JSON.stringify({
          text: "call the dentist slow #Home @phone p2",
          reply: "task"
        }), "the request is the text as typed, with the short reply")
        test.check(view.query === "" && view.placeholder === test.said("Add another task…", "Legg til en oppgave til…"), "the field empties for the next task")
        test.check(test.card().state === "added" && test.card().title === "call the dentist slow p2", "the card shows Todoist's task: " + JSON.stringify(test.card()))
        test.check(view.selectedRow && view.selectedRow.itemId === "todoist:card" && view.actionsForSelected()[0].id === "todoist-open-last", "the card is the task: Enter or Ctrl+O opens it")
        test.check(test.rowIds().indexOf("todoist:open-task:t1") < 0, "no separate Open in Todoist row")
        test.check(test.rowIds().indexOf("todoist:recent:t1") >= 0, "the task is under Added from here")
        if (test.waitFor(test.shellCalls().indexOf("foamy.todoist refresh") >= 0))
          break
        test.check(test.calls("notify").length === 0, "no notification while the launcher is open")
        test.capture("added", function () {
          key(Qt.Key_O, Qt.ControlModifier)
        })
        break
      case 7:
        if (test.waitFor(test.shellCalls().indexOf("foamy.todoist openTask t1") >= 0))
          break
        test.check(!menu.opened, "Ctrl+O opens the task in Todoist and closes")
        menu.open('{"menu":"root"}')
        break
      case 8:
        test.check(view.inputView, "reopened, the launcher is still in the input")
        view.setQuery("plant")
        break
      case 9:
        if (test.waitFor(view.nthTask(3) >= 0))
          break
        var found = test.sections().filter(function (section) {
          return section.id === "todoist-tasks"
        })[0]
        test.check(!!found && found.title === "Tasks" && view.t(found.title) === test.said("Tasks", "Oppgaver"), "typing shows the Tasks section")
        test.check(found.rows.map(function (r) {
          return r.id + "|" + r.typeLabelValues[0]
        }).join() === "todoist:task:k1|1,todoist:task:k2|2,todoist:task:k3|3", "the matching tasks in names' order, Ctrl 1–3: " + JSON.stringify(found.rows))
        test.check(found.rows[0].title === "Water the plants" && found.rows[0].subtitle === "Home · 21 Nov" && view.t(found.rows[0].typeLabel, found.rows[0].typeLabelValues) === "Ctrl 1", "a row: the text, project and date, its key")
        test.check(test.rowIds().indexOf("todoist:recent:t1") < 0, "with text, the results take the place of Added from here")
        test.check(view.nthTask(4) < 0, "Renew passport does not match")
        test.check(view.selectedRow && view.selectedRow.itemId === "todoist:card" && view.actionsForSelected()[0].id === "todoist-add", "the card stays selected: Enter adds")
        var offered = backend.callSync("rootSearch.getActions", {
          id: "todoist:task:k2",
          query: view.query,
          cursor: view.cursorPos,
          hideSuggestions: ""
        }).data
        test.check(offered[0].id === "todoist-add" && offered.some(function (a) {
          return a.id === "open" && a.shortcut === "Ctrl 2"
        }), "Ctrl+K on a result: Enter adds, Open in Todoist is Ctrl 2")
        test.capture("search", function () {
          key(Qt.Key_2, Qt.ControlModifier)
          test.check(view.selectedRow && view.selectedRow.itemId === "todoist:task:k2", "Ctrl+2 picks the second task, not the card")
        })
        break
      case 10:
        if (test.waitFor(test.shellCalls().indexOf("foamy.todoist openTask k2") >= 0))
          break
        test.check(test.calls("add").length === 1, "opening a task adds nothing")
        if (test.waitFor(!menu.opened))
          break
        menu.open('{"menu":"root"}')
        break
      case 11:
        test.check(view.inputView, "reopened, the launcher is still in the input")
        view.setQuery("buy unknown milk")
        key(Qt.Key_Return)
        break
      case 12:
        if (test.waitFor(!backend.todoistAdding && !!test.todoist.result))
          break
        test.check(test.todoist.result.kind === "unknown" && view.query === "buy unknown milk", "an unknown outcome keeps the text")
        test.check(test.card().state === "unknown" && test.rowIds().indexOf("todoist:open-inbox") >= 0, "and offers the Inbox")
        test.capture("unknown", function () {
          key(Qt.Key_Return)
        })
        break
      case 13:
        if (test.waitFor(test.calls("add").length >= 2))
          break
        test.check(test.todoist.confirming && test.calls("add").length === 2 && !backend.todoistAdding, "the next Enter only asks again")
        key(Qt.Key_Return)
        test.check(backend.todoistAdding, "a second Enter adds")
        break
      case 14:
        if (test.waitFor(!backend.todoistAdding && test.calls("add").length >= 3))
          break
        test.check(test.calls("add").length === 3, "the confirmed add ran")
        view.setQuery("call signedout")
        key(Qt.Key_Return)
        break
      case 15:
        if (test.waitFor(!backend.todoistAdding && !!test.todoist.result && test.todoist.result.kind === "signedOut"))
          break
        test.check(test.todoist.availability === "signedOut" && test.card().state === "signedOut" && view.query === "call signedout", "signed out keeps the text")
        test.check(test.rowIds().indexOf("todoist:open-app") >= 0, "and offers Foamy Todoist")
        test.check(test.calls("notify").length === 0, "still no notification while open")
        test.capture("signed-out", function () {
          test.slowNames(true)
        })
        break
      case 16:
        if (test.waitFor(flag.done))
          break
        // Leave, enter again (names takes 1.5 s now), leave at once.
        key(Qt.Key_Escape)
        key(Qt.Key_Escape)
        test.check(view.atRoot, "Esc clears the text, then leaves the input")
        view.setQuery("td")
        key(Qt.Key_Tab)
        test.check(view.inputView, "entered again")
        key(Qt.Key_Backspace)
        test.check(view.atRoot, "Backspace on an empty field leaves")
        test.since = Date.now()
        break
      case 17:
        if (test.waitFor(Date.now() - test.since > 2500 && test.calls("names").length >= 3))
          break
        test.check(test.calls("names").length >= 3 && test.todoist.availability === "signedOut", "a names reply for a visit that ended is dropped")
        test.slowNames(false)
        backend.callSync("rootSearch.performAction", {
          id: "setting:todoistCloseOnAdd",
          action: "open"
        })
        break
      case 18:
        if (test.waitFor(flag.done && backend.settingsEntry.todoistCloseOnAdd === true))
          break
        view.setQuery("td")
        key(Qt.Key_Tab)
        break
      case 19:
        if (test.waitFor(test.todoist.availability === "ready"))
          break
        view.setQuery("close slow test")
        key(Qt.Key_Return)
        test.check(!menu.opened && backend.todoistAdding, "with todoistCloseOnAdd, Enter adds and closes")
        break
      case 20:
        if (test.waitFor(!backend.todoistAdding && test.calls("notify").length === 1))
          break
        var notified = test.calls("notify")[0].request
        test.check(notified.kind === "added" && notified.title === test.said("Added to Todoist", "Lagt til i Todoist") && notified.open_label === test.said("Open in Todoist", "Åpne i Todoist"), "closed, the add is notified, translated: " + JSON.stringify(notified))
        test.check(notified.task && notified.task.id === "t2" && notified.task.content === "close slow test" && notified.task.project === "Inbox" && notified.task.due === "20 Nov", "with the task Todoist made")
        test.check(view.query === "", "the field emptied while closed")
        menu.open('{"menu":"root"}')
        view.setQuery("esc slow")
        key(Qt.Key_Return, Qt.ShiftModifier)
        test.check(menu.opened && backend.todoistAdding, "Shift+Enter does the other: adds and stays")
        key(Qt.Key_Escape)
        test.check(!menu.opened && backend.todoistAdding, "Esc during an add closes the launcher; the add goes on")
        break
      case 21:
        if (test.waitFor(!backend.todoistAdding && test.calls("notify").length === 2 && test.calls("add").length >= 6))
          break
        test.check(test.calls("notify")[1].request.kind === "added" && test.calls("notify")[1].request.task.content === "esc slow", "Esc during an add: notified once it answers")
        test.check(test.calls("notify").length === 2 && test.calls("add").length === 6, "one notification per add, only while closed")
        console.log("FOAMY RESULT " + test.checks + " checks")
        console.log("FOAMY DONE")
        Qt.quit()
      }
    }
  }
}
