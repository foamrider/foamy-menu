#!/usr/bin/env python3
"""Exercise the adopted launcher offscreen, with private state and stubbed commands.

Runs on Omarchy 4.5 by default (hosts as in tests/runtime.py: FOAMY_HOST_45,
OMARCHY_TEST_ROOT or the installed shell); 4.0 only with FOAMY_HOST_40."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import time

PLUGIN = Path(__file__).resolve().parents[1]
KIT = Path(os.environ.get('FOAMY_KIT', Path.home() / 'GitHub/Personal/foamy-kit'))
# Omarchy 4.5 only by default; set before the harness reads its hosts.
if not os.environ.get('FOAMY_HOST_45'):
    _root = os.environ.get('OMARCHY_TEST_ROOT')
    os.environ['FOAMY_HOST_45'] = str(Path(_root) / 'shell') if _root else '/usr/share/omarchy/shell'
sys.path.insert(0, str(KIT / 'preview'))
import harness
spec = importlib.util.spec_from_file_location('stock_runtime', PLUGIN / 'tests/runtime.py')
stock_runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stock_runtime)


def run_case(host, theme, width, language, shots, native=True):
    run = harness.Run(host, (PLUGIN / 'tests/qml/LauncherRuntime.qml').read_text(),
                      plugin=PLUGIN, theme=theme, language=language, prefix='foamy-menu-launcher-')
    stock_runtime.build(run)
    # Only window plumbing is replaced. Production logic, services and UI run unchanged.
    (run.root / 'plugin').unlink()
    local = run.root / 'plugin'
    shutil.copytree(PLUGIN, local, ignore=shutil.ignore_patterns('.git', '__pycache__'))
    if not native:
        # A CPU without a bundled helper: the built-in matcher must carry every check.
        for arch in ('x86_64', 'aarch64'):
            shutil.rmtree(local / 'bin' / arch)
    window = local / 'ui/LauncherWindow.qml'
    text, count = stock_runtime.transform_windows(window.read_text())
    assert count == 1, 'launcher window structure changed'
    window.write_text(text)
    # No compositor is present offscreen. IPC/lifecycle is tested through the actual entry point.
    launcher = local / 'Launcher.qml'
    text = launcher.read_text()
    start = text.index('  GlobalShortcut {')
    end = text.index('\n  }', start) + len('\n  }')
    launcher.write_text(text[:start] + text[end:])
    home = Path(run.env['HOME'])
    config = home / '.config/foamy-menu'
    config.mkdir(parents=True)
    cache = home / '.cache/foamy-menu'
    cache.mkdir(parents=True)
    (cache / 'currencies.json').write_text(json.dumps({
        'base': 'EUR', 'rates': {'USD': 1.1, 'NOK': 11.5}, 'date': '2026-11-05',
        'fetchedAt': time.time() * 1000}))
    shell_config = home / '.config/omarchy/shell.json'
    shell_config.parent.mkdir(parents=True, exist_ok=True)
    shell_config.write_text(json.dumps({'bar': {'layout': {'left': [
        {'id': 'foamy.menu', 'icon': '\U000f08c7', 'width': 360, 'currencyRates': False}]}}}))
    stubs = run.base / 'stubs'
    (stubs / 'wl-copy').write_text('#!/bin/sh\ncat > "$FOAMY_COPY_FILE"\n')
    (stubs / 'wl-copy').chmod(0o755)
    (stubs / 'wtype').write_text('#!/bin/sh\nexit 0\n')
    (stubs / 'wtype').chmod(0o755)
    # Scopes: the built-in SSH scope reads this config (through the bundled
    # helper's ssh-hosts); Enter runs the stub.
    ssh = home / '.ssh'
    ssh.mkdir(mode=0o700)
    (ssh / 'config').write_text('Host web\n  HostName 10.0.0.4\n  User deploy\nHost db\n  HostName db.internal\nHost *\n  ServerAliveInterval 30\n')
    scopes = config / 'scopes'
    scopes.mkdir()
    (scopes / 'bookmarks.json').write_text(json.dumps({
        'title': 'Bookmarks', 'keyword': 'bm', 'source': {'type': 'list', 'items': ['Omarchy']},
        'open': ['omarchy-launch-browser', 'https://omarchy.org/{value}']}))
    (scopes / 'off.json').write_text(json.dumps({'id': 'off', 'enabled': False, 'title': 'Off',
                                                 'source': {'type': 'list', 'items': []}, 'open': ['true']}))
    (stubs / 'omarchy-launch-tui').write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$FOAMY_LAUNCH_FILE"\n')
    (stubs / 'omarchy-launch-tui').chmod(0o755)
    (stubs / 'omarchy-launch-browser').write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$FOAMY_BROWSER_FILE"\n')
    (stubs / 'omarchy-launch-browser').chmod(0o755)
    # No shell facade offscreen, so settings save through `omarchy bar set`:
    # this stand-in writes the value into the test shell.json entry.
    (stubs / 'omarchy').write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
if args[:2] != ["bar", "set"] or len(args) < 5:
    sys.exit(1)
widget, key, raw = args[2], args[3], args[4]
value = json.loads(raw) if "--json" in args else raw
path = os.path.join(os.environ["HOME"], ".config/omarchy/shell.json")
with open(path) as f:
    config = json.load(f)
for entries in config["bar"]["layout"].values():
    for entry in entries:
        if entry.get("id") == widget:
            entry[key] = value
with open(path, "w") as f:
    json.dump(config, f)
''')
    (stubs / 'omarchy').chmod(0o755)
    # Saved searches are opt-in; this turns them on for DuckDuckGo only.
    (scopes / 'duckduckgo.json').write_text(json.dumps({'id': 'duckduckgo', 'history': True}))
    run.env.update({'FOAMY_TEST_WIDTH': str(width), 'FOAMY_COPY_FILE': str(run.base / 'copied'),
                    'FOAMY_LAUNCH_FILE': str(run.base / 'launched'), 'FOAMY_BROWSER_FILE': str(run.base / 'browsed'), 'FOAMY_TEST_LANGUAGE': language,
                    'FOAMY_TEST_NATIVE': '1' if native else '0'})
    if shots:
        out = Path(shots) / f'{host}-{theme}-{width}-{language}'
        out.mkdir(parents=True, exist_ok=True)
        run.env['FOAMY_MENU_SHOTS'] = str(out)
    run.run(timeout=45)
    result = next((line.split('FOAMY RESULT ', 1)[1] for line in run.log.splitlines()
                   if 'FOAMY RESULT ' in line), 'no result')
    # The bundled helper answers every root search; without one, NativeSearch
    # says so once and the built-in matcher takes over.
    helper_lines = [line for line in run.log.splitlines() if 'Search helper' in line]
    unavailable = "Search helper isn't available for this CPU; using the built-in matcher"
    if helper_lines if native else len(helper_lines) != 1 or unavailable not in helper_lines[0]:
        run.ok = False
        result += f'; unexpected search helper log: {helper_lines!r}'
    label = '' if native else '/no-native-helper'
    print(f'{"PASS" if run.ok else "FAIL"} launcher {host}/{theme}/{width}/{language}{label}: {result}')
    if not run.ok:
        print(run.log[-12000:])
        print(f'log kept at {run.base}')
    else:
        run.cleanup()
    return run.ok


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', choices=['4.5', '4.0', 'both'], default='4.5')
    parser.add_argument('--shots')
    args = parser.parse_args()
    hosts = stock_runtime.selected_hosts(args.host)
    # English on the wide dark layout, Norwegian (Omarchy 4.5 language) on the narrow light one.
    results = [run_case(host, theme, width, language, args.shots) for host in hosts
               for theme, width, language in [('dark', 1280, 'en'), ('light', 600, 'no')]]
    # Once per host: the same checks with no bundled helper (JS matcher fallback).
    results += [run_case(host, 'dark', 1280, 'en', None, native=False) for host in hosts]
    return 0 if all(results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
