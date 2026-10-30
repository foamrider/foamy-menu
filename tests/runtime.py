#!/usr/bin/env python3
"""Offscreen integration test of Foamy Menu around the host's real stock
menu, on both hosts: 4.0.6 (installed) and 4.5 (reference shell, QML only).

  tests/runtime.py [--host 4.0|4.5|both] [--shots DIR] [--plugin DIR] [--shell QML]

Uses the foamy-kit harness (FOAMY_KIT, default ~/GitHub/Personal/foamy-kit):
temp HOME/XDG/runtime dirs, offscreen Qt, no Wayland/Hyprland variables.
OMARCHY_PATH points at a stub tree whose shell/plugins/menu/Menu.qml is the
host's own file with its PanelWindow swapped for tests/qml/FakeMenuWindow.qml
(on 4.5 the swap is in Ui/OverlayWindow.qml); everything else is the host's
code. Every omarchy-* command and hyprctl on PATH is a stub: the stock menu's
guard commands fail quietly, and `omarchy-shell shell summon|toggle` calls are
recorded instead of reaching a shell. No host script or binary runs, and the
desktop's shell is never touched.

The test also checks that foamy.menu still finds the stock menu internals it
depends on (the window, its BorderSurface card, cardWidth, dmenuActive), so a
host release that changes them fails here first.
"""
import argparse
import os
from pathlib import Path
import re
import shutil
import sys

PLUGIN = Path(__file__).resolve().parents[1]
KIT = Path(os.environ.get("FOAMY_KIT", Path.home() / "GitHub/Personal/foamy-kit"))
SHELL_STUB = """#!/bin/sh
case "$1 $2" in
  "shell summon"|"shell toggle") printf '%s\\n' "$*" >> "$FOAMY_MENU_TEST_ACTION_LOG" ;;
esac
exit 1
"""


def transform_windows(text):
    """`PanelWindow {` -> `FakeMenuWindow {`; the window's own `anchors { … }`
    line -> `windowAnchors { … }`; WlrLayershell lines dropped."""
    out, window_indent, replaced = [], None, 0
    for line in text.splitlines():
        if re.match(r"^\s*WlrLayershell\.\w+\s*:", line):
            continue
        match = re.match(r"^(\s*)(.*)\bPanelWindow \{\s*$", line)
        if match:
            window_indent = len(match.group(1)) + 2
            replaced += 1
            out.append(line.replace("PanelWindow {", "FakeMenuWindow {"))
            continue
        if window_indent is not None:
            if re.match(r"^\s{%d}\}\s*$" % (window_indent - 2), line):
                window_indent = None
            elif line.startswith(" " * window_indent) and not line.startswith(" " * (window_indent + 1)):
                line = re.sub(r"^(\s*)anchors \{", r"\1windowAnchors {", line)
        out.append(line)
    return "\n".join(out) + "\n", replaced


def build(run):
    host = run.host
    (run.root / "services").symlink_to(host / "services", target_is_directory=True)
    omarchy = run.base / "omarchy"
    menu_dir = omarchy / "shell/plugins/menu"
    menu_dir.mkdir(parents=True)
    (omarchy / "shell/services").symlink_to(host / "services", target_is_directory=True)
    (omarchy / "default/omarchy").symlink_to(host.parent / "default/omarchy", target_is_directory=True)
    for path in sorted((host / "plugins/menu").iterdir()):
        if path.name != "Menu.qml":
            (menu_dir / path.name).symlink_to(path)
    menu, replaced = transform_windows((host / "plugins/menu/Menu.qml").read_text())
    (menu_dir / "Menu.qml").write_text(menu)
    # The stand-in window joins qs.Ui, which the stock menu already imports.
    ui = run.root / "Ui"
    for name in ("FakeMenuWindow.qml", "FakeMenuEdges.qml"):
        shutil.copyfile(PLUGIN / "tests/qml" / name, ui / name)
    with (ui / "qmldir").open("a") as qmldir:
        qmldir.write("FakeMenuWindow 1.0 FakeMenuWindow.qml\nFakeMenuEdges 1.0 FakeMenuEdges.qml\n")
    overlay = host / "Ui/OverlayWindow.qml"
    if overlay.exists():
        # 4.5: the menu draws in Ui/OverlayWindow (a PanelWindow).
        (ui / "OverlayWindow.qml").unlink()
        text, count = transform_windows(overlay.read_text())
        replaced += count
        (ui / "OverlayWindow.qml").write_text(text)
    if replaced == 0:
        raise SystemExit("host menu changed shape: no PanelWindow to replace")
    stubs = run.base / "stubs"
    stubs.mkdir()
    names = {"hyprctl"}
    for bin_dir in (Path("/usr/share/omarchy/bin"), host.parent / "bin"):
        if bin_dir.is_dir():
            names.update(p.name for p in bin_dir.iterdir() if p.name.startswith("omarchy"))
    names.update({"omarchy", "omarchy-shell"})
    for name in names:
        (stubs / name).write_text(SHELL_STUB if name == "omarchy-shell" else "#!/bin/sh\nexit 1\n")
        (stubs / name).chmod(0o755)
    actions = run.base / "actions.log"
    actions.write_text("")
    run.env.update({
        "PATH": f"{stubs}:{os.environ.get('PATH', '/usr/bin')}",
        "FOAMY_MENU_TEST_ACTION_LOG": str(actions),
    })


def run_host(host_name, shots, plugin, shell_path):
    sys.path.insert(0, str(KIT / "preview"))
    import harness
    extra = {
        "menu.jsonc": '{"apps":{"label":"Apps","provider":"apps"}}\n',
        "shell.json": '{"version":1,"bar":{"layout":{"left":[{"id":"foamy.menu","width":360}]}}}\n',
    }
    run = harness.Run(host_name, Path(shell_path).read_text(), plugin=plugin, extra=extra,
                      prefix=f"foamy-menu-runtime-{host_name}-")
    build(run)
    if shots:
        out = Path(shots) / host_name
        out.mkdir(parents=True, exist_ok=True)
        run.env["FOAMY_MENU_SHOTS"] = str(out)
    run.run(timeout=120)
    result = next((line.split("FOAMY RESULT ", 1)[1] for line in run.log.splitlines() if "FOAMY RESULT" in line), "no result")
    print(f"{'PASS' if run.ok else 'FAIL'} runtime {host_name}: {result}")
    for line in run.log.splitlines():
        if "FOAMY SHOT " in line:
            print("    shot " + line.split("FOAMY SHOT ", 1)[1])
    if not run.ok:
        print("\n".join("    " + line for line in (run.failures() or run.log.splitlines()[-40:])))
        print(f"    log kept at {run.base}")
        return False
    if os.environ.get("FOAMY_MENU_KEEP") == "1":
        print(f"    log kept at {run.base}")
    else:
        run.cleanup()
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="both", choices=["4.0", "4.5", "both"])
    parser.add_argument("--shots")
    parser.add_argument("--plugin", default=str(PLUGIN), help="plugin directory to load (default: this checkout)")
    parser.add_argument("--shell", default=str(PLUGIN / "tests/qml/Runtime.qml"), help="test QML to run")
    args = parser.parse_args()
    if not (KIT / "preview/harness.py").exists():
        print(f"SKIP: foamy-kit harness not found at {KIT} (set FOAMY_KIT)")
        return 0
    hosts = ["4.0", "4.5"] if args.host == "both" else [args.host]
    results = [run_host(host, args.shots, Path(args.plugin).resolve(), args.shell) for host in hosts]
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
