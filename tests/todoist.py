#!/usr/bin/env python3
"""The Todoist input (td + Tab), offscreen, against a fake Foamy Todoist.

  tests/todoist.py [--shots DIR]

Runs the adopted launcher (tests/launcher.py's adopt()) on the Omarchy shell
tests/runtime.py picks, in the kit harness's temporary HOME/XDG directories,
with tests/qml/TodoistRuntime.qml driving it. Foamy Todoist is a stand-in
installed where Omarchy puts plugins ($HOME/.config/omarchy/plugins/
foamy.todoist): its manifest and a fake foamy-todoist-helper that speaks
contract 1 (names, add with reply "task", notify), decides each add's reply
from the text and records every request. `omarchy-shell` is a stand-in that
records its arguments. Nothing reaches Todoist, the desktop's shell or a
notification server: the fake helper's notify only records the request.
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys

PLUGIN = Path(__file__).resolve().parents[1]
KIT = Path(os.environ.get("FOAMY_KIT", Path.home() / "GitHub/Personal/foamy-kit"))
if not os.environ.get("FOAMY_HOST_45"):
    _root = os.environ.get("OMARCHY_TEST_ROOT")
    os.environ["FOAMY_HOST_45"] = str(Path(_root) / "shell") if _root else "/usr/share/omarchy/shell"
sys.path.insert(0, str(KIT / "preview"))
import harness


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, PLUGIN / "tests" / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


stock_runtime = load("stock_runtime", "runtime.py")
launcher = load("launcher_runtime", "launcher.py")

# Contract 1's names reply: a few projects, a section and labels.
NAMES = {
    "ok": True,
    "contract": 1,
    "state": "signed_in",
    "inbox_project_id": "inbox1",
    "projects": [
        {"id": "inbox1", "name": "Inbox", "parent_id": None, "child_order": 0, "inbox": True, "shared": False},
        {"id": "home1", "name": "Home", "parent_id": None, "child_order": 1, "inbox": False, "shared": False},
        {"id": "lab1", "name": "Homelab", "parent_id": None, "child_order": 2, "inbox": False, "shared": False},
    ],
    "sections": [{"id": "s1", "project_id": "home1", "name": "Garden", "section_order": 1}],
    "labels": ["phone", "errands"],
    "collaborators": [],
    "project_collaborators": {},
    "truncated": False,
}

# The fake helper: the reply follows the add's text ("unknown" → the request
# may have gone out, "signedout" → signed out, "slow" → answers after 1.5 s);
# names waits 1.5 s while the file slow-names exists. Every call is a JSON
# line in $FOAMY_TODOIST_FAKE_LOG.
HELPER = r"""#!/usr/bin/python3 -I
import json, os, re, sys, time
command = sys.argv[1] if len(sys.argv) > 1 else ""
raw = sys.stdin.read()
request = json.loads(raw) if raw.strip() else None
state = os.environ["FOAMY_TODOIST_FAKE_STATE"]
with open(os.environ["FOAMY_TODOIST_FAKE_LOG"], "a") as log:
    log.write(json.dumps({"command": command, "request": request}) + "\n")
def reply(value):
    print(json.dumps(value))
    sys.exit(0)
if command == "names":
    if os.path.exists(os.path.join(state, "slow-names")):
        time.sleep(1.5)
    reply(NAMES)
if command == "notify":
    reply({"ok": True, "contract": 1})
if command != "add" or not request or request.get("reply") != "task":
    reply({"ok": False, "contract": 1, "code": "INVALID_ARGUMENT", "error": "The Todoist helper was called with the wrong arguments."})
text = request["text"]
if "slow" in text:
    time.sleep(1.5)
if "unknown" in text:
    reply({"ok": False, "contract": 1, "code": "UNKNOWN_OUTCOME", "error": "Todoist didn't answer. The task may have been added: check the list before adding it again."})
if "signedout" in text:
    reply({"ok": False, "contract": 1, "code": "SIGNED_OUT", "error": "Not signed in to Todoist."})
counter = os.path.join(state, "added")
count = int(open(counter).read()) + 1 if os.path.exists(counter) else 1
open(counter, "w").write(str(count))
project = re.search(r"(?:^|\s)#(\S+)", text)
labels = re.findall(r"(?:^|\s)@(\S+)", text)
content = re.sub(r"(?:^|\s)[#@]\S+", "", text).strip()
task_id = "t%d" % count
name = project.group(1) if project else "Inbox"
reply({
    "ok": True, "contract": 1, "added": task_id,
    "task": {"id": task_id, "content": content, "project_id": name.lower(), "section_id": None, "priority": 1,
             "labels": labels, "due": {"date": "2026-11-20", "is_recurring": False, "string": "20 Nov"}},
    "project": {"id": name.lower(), "name": name, "inbox": name == "Inbox"},
})
""".replace("NAMES", repr(NAMES))

# omarchy-shell: records every call; `shell summon|toggle` also go to the
# stock runtime's action log, as tests/runtime.py's stand-in does.
SHELL = """#!/bin/sh
printf '%s\\n' "$*" >> "$FOAMY_SHELL_LOG"
case "$1 $2" in
  "shell summon"|"shell toggle") printf '%s\\n' "$*" >> "$FOAMY_MENU_TEST_ACTION_LOG" ;;
esac
case "$1" in
  foamy.todoist) exit 0 ;;
esac
exit 1
"""


def run_case(host, theme, width, language, shots):
    run = harness.Run(
        host,
        (PLUGIN / "tests/qml/TodoistRuntime.qml").read_text(),
        plugin=PLUGIN,
        theme=theme,
        language=language,
        prefix="foamy-menu-todoist-",
    )
    stock_runtime.build(run)
    launcher.adopt(run)
    home = Path(run.env["HOME"])
    (home / ".config/foamy-menu").mkdir(parents=True)
    shell_config = home / ".config/omarchy/shell.json"
    shell_config.parent.mkdir(parents=True, exist_ok=True)
    entry = {"id": "foamy.menu", "width": 360, "currencyRates": False, "todoistQuickAdd": True}
    shell_config.write_text(json.dumps({"bar": {"layout": {"left": [entry]}}}))
    todoist = home / ".config/omarchy/plugins/foamy.todoist"
    for arch in ("x86_64", "aarch64"):
        (todoist / "bin" / arch).mkdir(parents=True)
        (todoist / "bin" / arch / "foamy-todoist-helper").write_text(HELPER)
        (todoist / "bin" / arch / "foamy-todoist-helper").chmod(0o755)
    (todoist / "manifest.json").write_text(
        json.dumps({"schemaVersion": 1, "id": "foamy.todoist", "name": "Foamy Todoist"})
    )
    state = run.base / "todoist-state"
    state.mkdir()
    stubs = run.base / "stubs"
    (stubs / "omarchy-shell").write_text(SHELL)
    (stubs / "omarchy").write_text(launcher.OMARCHY_STUB)
    (stubs / "omarchy").chmod(0o755)
    (stubs / "wl-copy").write_text("#!/bin/sh\ncat > /dev/null\n")
    (stubs / "wl-copy").chmod(0o755)
    run.env.update(
        {
            "FOAMY_TEST_WIDTH": str(width),
            "FOAMY_TEST_LANGUAGE": language,
            "FOAMY_TODOIST_FAKE_LOG": str(run.base / "todoist.log"),
            "FOAMY_TODOIST_FAKE_STATE": str(state),
            "FOAMY_SHELL_LOG": str(run.base / "shell.log"),
        }
    )
    (run.base / "todoist.log").write_text("")
    (run.base / "shell.log").write_text("")
    if shots:
        out = Path(shots) / f"todoist-{host}-{theme}-{width}-{language}"
        out.mkdir(parents=True, exist_ok=True)
        run.env["FOAMY_MENU_SHOTS"] = str(out)
    run.run(timeout=150)
    result = next(
        (line.split("FOAMY RESULT ", 1)[1] for line in run.log.splitlines() if "FOAMY RESULT " in line), "no result"
    )
    refused = run.host_commands()
    if refused:
        run.ok = False
        result += f"; host commands without a stand-in: {refused!r}"
    print(f"{'PASS' if run.ok else 'FAIL'} todoist {host}/{theme}/{width}/{language}: {result}")
    if not run.ok:
        print(run.log[-12000:])
        print(f"log kept at {run.base}")
    else:
        run.cleanup()
    return run.ok


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--shots")
    args = parser.parse_args()
    if not (KIT / "preview/harness.py").exists():
        print(f"SKIP: foamy-kit harness not found at {KIT} (set FOAMY_KIT)")
        return 0
    # English on the wide dark layout, Norwegian on the narrow light one.
    results = [
        run_case(stock_runtime.HOST, theme, width, language, args.shots)
        for theme, width, language in [("dark", 1280, "en"), ("light", 600, "no")]
    ]
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
