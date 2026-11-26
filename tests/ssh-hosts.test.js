// The SSH scope's host list: foamy-menu-search ssh-hosts over fixture homes,
// run as the launcher runs it. Each case is one rule of ssh_config(5) and the
// exact bytes expected.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync, spawnSync } = require("node:child_process")
const helper = require("./search-helper.js")
const Scopes = require("../core/Scopes.js")
const FoamyNative = require("../kit/node-loader.cjs").load("FoamyNative")
const I18n = require("../kit/node-loader.cjs").load("FoamyI18nText")
const en = require("../i18n/en.json")
const no = require("../i18n/no.json")

const root = path.join(__dirname, "..")
const skip = helper.skip && "no bundled search helper for this CPU"
const isRoot = typeof process.getuid === "function" && process.getuid() === 0

// A fixture home: files (text; @HOME@ is the home path) and their sizes
// (padded with a hole of zeros), dirs, symlinks (path -> target, both
// relative to the home), FIFOs and file modes.
function makeHome(fixture) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "foamy-ssh-hosts-"))
  fs.mkdirSync(path.join(home, ".ssh"), { mode: 0o700 })
  const at = (rel) => path.join(home, rel)
  for (const dir of fixture.dirs || []) fs.mkdirSync(at(dir), { recursive: true })
  for (const [rel, text] of Object.entries(fixture.files || {})) {
    fs.mkdirSync(path.dirname(at(rel)), { recursive: true })
    fs.writeFileSync(at(rel), text.replaceAll("@HOME@", home), { mode: 0o600 })
  }
  for (const [rel, size] of Object.entries(fixture.sizes || {})) fs.truncateSync(at(rel), size)
  for (const [rel, target] of Object.entries(fixture.links || {})) {
    fs.mkdirSync(path.dirname(at(rel)), { recursive: true })
    fs.symlinkSync(at(target), at(rel))
  }
  for (const rel of fixture.fifos || []) execFileSync("mkfifo", [at(rel)])
  for (const [rel, mode] of Object.entries(fixture.modes || {})) fs.chmodSync(at(rel), mode)
  return home
}

function env(home, fixture) {
  const out = { HOME: home, PATH: process.env.PATH }
  if (fixture.config) out.FOAMY_SSH_CONFIG = path.join(home, fixture.config)
  return out
}

function runRust(home, fixture, argv) {
  const [program, ...args] = argv || [...helper.argv, "ssh-hosts"]
  return execFileSync(program, args, { env: env(home, fixture), encoding: "utf8", timeout: 10000 })
}

const lines = (...rows) => rows.map((row) => row.join("\t") + "\n").join("")

const CASES = [
  {
    name: "nested Includes, globs, cycles, absolute and ~/ paths, missing files",
    files: {
      ".ssh/config": [
        "# Main config",
        "Include conf.d/*.conf",
        "Host web prod-web",
        "  HostName 10.0.0.4",
        "  User deploy",
        "  Port 2222",
        "Host *.internal !bastion",
        "  User nobody",
        "Host dup",
        "  HostName first",
        "Host dup",
        "  HostName second",
        "Include ~/extra/*.conf",
        "Include @HOME@/abs.conf",
        "Include missing.conf ~/missing/* /nonexistent/*.conf",
        "Include config",
        ""
      ].join("\n"),
      // Includes inside a block, a cycle back to the main config and one to itself.
      ".ssh/conf.d/a.conf": "Host db\n  Hostname db.internal\n  Port 22\nInclude @HOME@/.ssh/config\nInclude nested/*\n",
      ".ssh/conf.d/b.conf": "Host cache\n  HostName 10.0.0.9\n",
      ".ssh/conf.d/.hidden.conf": "Host hidden\n",
      ".ssh/conf.d/notes.txt": "Host notes\n",
      ".ssh/nested/one": "Host deep\n  User root\nInclude conf.d/a.conf\nInclude nested/one\n",
      "extra/x.conf": "Host extra\n  User me\n",
      "abs.conf": "Host abs\n  Port 2022\n"
    },
    dirs: [".ssh/conf.d/dir.conf"],
    out: lines(
      ["abs", "abs", "abs:2022"], ["cache", "cache", "10.0.0.9"], ["db", "db", "db.internal"],
      ["deep", "deep", "root@deep"], ["dup", "dup", "first"], ["extra", "extra", "me@extra"],
      ["prod-web", "prod-web", "deploy@10.0.0.4:2222"], ["web", "web", "deploy@10.0.0.4:2222"])
  },
  {
    name: "comments, Host with several names, Match blocks, mixed-case keys, ` = ` and quoted values",
    files: {
      ".ssh/config": [
        "# comment",
        "   # indented comment",
        "",
        "Host alpha beta \"gamma\"",
        "  HOSTNAME = alpha.example",
        "  user = \"ops\"",
        "  pOrT 2200",
        "Match host alpha",
        "  User wrong",
        "  HostName wrong",
        "Host beta",
        "  HostName ignored-second",
        "Host  delta",
        "\tHostname\t\"delta.example\"",
        "Match all",
        "  User nobody",
        "Host epsilon",
        "\tUser\tadmin",
        ""
      ].join("\n")
    },
    out: lines(
      ["alpha", "alpha", "ops@alpha.example:2200"], ["beta", "beta", "ops@alpha.example:2200"],
      ["delta", "delta", "delta.example"], ["epsilon", "epsilon", "admin@epsilon"],
      ["gamma", "gamma", "ops@alpha.example:2200"])
  },
  {
    name: "user and port without HostName; port 22 is not shown; sorting ignores case",
    files: {
      ".ssh/config": "Host u\n  User me\nHost p\n  Port 2200\nHost up\n  User me\n  Port 2200\nHost std\n  Port 22\nHost empty\nHost Zed zed _under B\n"
    },
    out: lines(
      ["B", "B", ""], ["empty", "empty", ""], ["p", "p", "p:2200"], ["std", "std", ""], ["u", "u", "me@u"],
      ["up", "up", "me@up:2200"], ["Zed", "Zed", ""], ["zed", "zed", ""], ["_under", "_under", ""])
  },
  {
    name: "glob brackets, classes, directory globs and byte order between included files",
    files: {
      ".ssh/config": "Include conf.d/[ab]?.conf conf.d/[!x]*.cfg conf.d/[[:digit:]]*-*.conf */hosts\n",
      ".ssh/conf.d/a1.conf": "Host a1\n",
      ".ssh/conf.d/b22.conf": "Host b22\n",
      ".ssh/conf.d/c1.conf": "Host c1\n",
      ".ssh/conf.d/y.cfg": "Host ycfg\n",
      ".ssh/conf.d/x.cfg": "Host xcfg\n",
      ".ssh/conf.d/10-a.conf": "Host shared\n  HostName from-10\n",
      ".ssh/conf.d/20-b.conf": "Host shared\n  HostName from-20\n  User from-20\n",
      ".ssh/team-b/hosts": "Host teamb\n  User b\n",
      ".ssh/team-a/hosts": "Host teamb\n  User a\nHost teama\n"
    },
    out: lines(["a1", "a1", ""], ["shared", "shared", "from-20@from-10"], ["teama", "teama", ""],
      ["teamb", "teamb", "a@teamb"], ["ycfg", "ycfg", ""])
  },
  {
    name: "unreadable, FIFO and directory Includes are skipped without blocking",
    files: {
      ".ssh/config": "Include locked.conf fifo conf.d missing.conf\nHost ok\n  HostName ok.example\n",
      ".ssh/locked.conf": "Host locked\n",
      ".ssh/conf.d/inner": "Host inner\n"
    },
    fifos: [".ssh/fifo"],
    modes: { ".ssh/locked.conf": 0o000 },
    unreadable: true,
    out: lines(["ok", "ok", "ok.example"])
  },
  { name: "an unreadable config prints nothing", files: { ".ssh/config": "Host x\n" }, modes: { ".ssh/config": 0o000 }, unreadable: true, out: "" },
  { name: "no config prints nothing", out: "" },
  { name: "a directory as the config prints nothing", dirs: [".ssh/config"], out: "" },
  {
    name: "FOAMY_SSH_CONFIG overrides the path; relative Includes stay in ~/.ssh",
    config: "elsewhere/my_config",
    files: {
      "elsewhere/my_config": "Include conf.d/x\nHost other\n  User o\n",
      ".ssh/config": "Host ignored\n",
      ".ssh/conf.d/x": "Host fromx\n"
    },
    out: lines(["fromx", "fromx", ""], ["other", "other", "o@other"])
  },
  {
    name: "a symlinked config and symlinked Includes are read through the link",
    files: {
      "dotfiles/ssh/config": "Include linked.conf dangling\nHost dotfile\n  HostName dot.example\n",
      "dotfiles/ssh/inc.conf": "Host viainclude\n"
    },
    links: { ".ssh/config": "dotfiles/ssh/config", ".ssh/linked.conf": "dotfiles/ssh/inc.conf", ".ssh/dangling": "nowhere" },
    out: lines(["dotfile", "dotfile", "dot.example"], ["viainclude", "viainclude", ""])
  },
  {
    name: "CRLF settings",
    files: { ".ssh/config": "Host crlf\r\n  HostName crlf.example\r\n  Port 2200\r\n" },
    out: lines(["crlf", "crlf", "crlf.example:2200"])
  },
  // Rules a plain line reader gets wrong.
  {
    name: "`Key=value` without spaces",
    why: "ssh splits the keyword at whitespace or one `=`",
    files: { ".ssh/config": "Host=eqhost\nHostName=10.0.0.1\nHost plain\nUser=me\n" },
    out: lines(["eqhost", "eqhost", "10.0.0.1"], ["plain", "plain", "me@plain"])
  },
  {
    name: "trailing comments",
    why: "ssh ends a line at an argument starting with `#`",
    files: { ".ssh/config": "Host web # the web server\n  HostName 10.0.0.4 # primary\n" },
    out: lines(["web", "web", "10.0.0.4"])
  },
  {
    name: "single quotes, quotes inside a word and escapes",
    why: "ssh's argv_split handles both quote kinds anywhere in a word and `\\` escapes. Names that hold whitespace are not hosts",
    files: { ".ssh/config": "Host 'single' \"two words\" esc\\ aped\n  User 'admin'\n  HostName \"a\"b\n" },
    out: lines(["single", "single", "admin@ab"])
  },
  {
    name: "Include is read where it stands",
    why: "ssh reads an included file at the Include line, so its values come first",
    files: {
      ".ssh/config": "Include first.conf\nHost db\n  HostName from-main\n",
      ".ssh/first.conf": "Host db\n  HostName from-include\n  User inc\n"
    },
    out: lines(["db", "db", "inc@from-include"])
  },
  {
    name: "an included file continues the including Host block",
    why: "ssh applies an included file's lines before its own first Host to the block the Include is in",
    files: {
      ".ssh/config": "Host web\n  Include web-settings.conf\n  User after\n",
      ".ssh/web-settings.conf": "HostName 10.0.0.4\nUser inside\n"
    },
    out: lines(["web", "web", "inside@10.0.0.4"])
  },
  {
    name: "the including Host block resumes after an Include that starts its own Host",
    why: "ssh restores the including block after it reads an included file",
    files: {
      ".ssh/config": "Host web\n  Include common.conf\n  HostName web.example\n",
      ".ssh/common.conf": "Host bastion\n  User jump\n"
    },
    out: lines(["bastion", "bastion", "jump@bastion"], ["web", "web", "web.example"])
  },
  {
    name: "CRLF Include lines",
    why: "ssh strips trailing whitespace, \\r included, before splitting",
    files: { ".ssh/config": "Include extra.conf\r\nHost main\r\n", ".ssh/extra.conf": "Host extra\r\n" },
    out: lines(["extra", "extra", ""], ["main", "main", ""])
  },
  {
    name: "a keyword without a value, and extra values",
    why: "ssh rejects `User` with no argument and takes one argument",
    files: { ".ssh/config": "Host web\n  User\n  User deploy\n  HostName a b\n" },
    out: lines(["web", "web", "deploy@a"])
  },
  {
    name: "a tab inside a quoted value",
    why: "quotes keep the tab, which would add an icon column to the line, so the subtitle is left empty",
    files: { ".ssh/config": "Host web\n  HostName \"10.0.0.4\t/usr/share/pixmaps/x.png\"\n  User deploy\nHost db\n  HostName db.example\n" },
    out: lines(["db", "db", "db.example"], ["web", "web", ""])
  }
]

for (const fixture of CASES) {
  const why = skip || (fixture.unreadable && isRoot && "root reads unreadable files")
  test(`ssh-hosts: ${fixture.name}`, { skip: why }, () => {
    const home = makeHome(fixture)
    try {
      assert.equal(runRust(home, fixture), fixture.out, fixture.why)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
}

// `count` entries named prefix0, prefix1, …, each holding `text`.
const numbered = (prefix, count, text = "") => Object.fromEntries(Array.from({ length: count }, (_, i) => [prefix + i, text]))

// A config past one of the helper's totals would list only part of its
// hosts. The helper fails instead (exit 1, nothing on stdout, the reason on
// stderr), so the SSH scope keeps the hosts it had (tests/scope-source.test.js)
// and shows why, in the user's language. Where each bound lies is tested in
// search/src/ssh_hosts.rs.
const PAST_A_TOTAL = [
  ["files", { files: { ".ssh/config": "Include many/*\n", ...numbered(".ssh/many/", 256) } },
    "the SSH config and its Includes are more than 256 files"],
  // Eight files of 1 MiB and the config.
  ["bytes", { files: { ".ssh/config": "Include part?\n", ...numbered(".ssh/part", 8) }, sizes: numbered(".ssh/part", 8, 1024 * 1024) },
    "the SSH config and its Includes hold more than 8 MiB"],
  ["Include arguments", { files: { ".ssh/config": "Include nothing-here\n".repeat(4097) } },
    "the SSH config has more than 4096 Include arguments"],
  ["directory entries", { files: { ".ssh/config": "Include many/x*\n", ...numbered(".ssh/many/", 16385) } },
    "the SSH config's Include patterns look at more than 16384 directory entries"],
  ["hosts", { files: { ".ssh/config": "Host " + Object.keys(numbered("h", 10001)).join(" ") + "\n" } },
    "the SSH config names more than 10000 hosts"]
]

for (const [bound, fixture, reason] of PAST_A_TOTAL) {
  test(`ssh-hosts: a config past the ${bound} total fails with the reason, in the user's language`, { skip }, () => {
    const home = makeHome(fixture)
    try {
      const [program, ...args] = [...helper.argv, "ssh-hosts"]
      const run = spawnSync(program, args, { env: env(home, fixture), encoding: "utf8", timeout: 10000 })
      assert.equal(run.error, undefined)
      assert.deepEqual([run.status, run.stdout], [1, ""], "no list, and an error exit")
      const line = "foamy-menu-search: ssh-hosts: " + reason + "; not listing part of the hosts"
      assert.deepEqual(Scopes.exitFailure(run.status, run.stderr), [line, []])
      assert.ok(Object.hasOwn(en, line), "the reason has a catalog entry")
      assert.notEqual(I18n.translator(no, en).t(line), line, "the reason is translated")
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
}

// Up to the helper's hosts total (one more fails, above) the scope keeps
// every host it lists: its own item cap must not cut the list short.
test("ssh-hosts: a config at the hosts total is listed whole in the scope", { skip }, () => {
  const ssh = Scopes.merge(Scopes.BUILTINS, []).scopes.find((s) => s.id === "ssh")
  const names = Object.keys(numbered("h", 10000))
  const fixture = { files: { ".ssh/config": "Host " + names.join(" ") + "\n" } }
  const home = makeHome(fixture)
  try {
    const values = new Set(Scopes.parseOutput(runRust(home, fixture), Scopes.maxItems(ssh)).map((item) => item.value))
    assert.equal(values.size, names.length, "every host is an item")
    assert.ok(names.every((name) => values.has(name)), "every host is an item")
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test("the SSH scope runs the bundled helper's ssh-hosts, as FoamyNative launches it", { skip }, () => {
  const ssh = Scopes.merge(Scopes.BUILTINS, []).scopes.find((s) => s.id === "ssh")
  const argv = Scopes.fill(ssh.source.command, "", root)
  assert.deepEqual(argv, Array.from(FoamyNative.command(root, "foamy-menu-search", ["ssh-hosts"])))
  assert.ok(Scopes.isNativeCommand(argv))
  const fixture = CASES[0]
  const home = makeHome(fixture)
  try {
    const out = runRust(home, fixture, helper.required ? undefined : argv)
    assert.equal(out, fixture.out)
    assert.deepEqual(Scopes.parseOutput(out).slice(0, 2), [
      { title: "abs", value: "abs", subtitle: "abs:2022" },
      { title: "cache", value: "cache", subtitle: "10.0.0.9" }
    ])
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test("ssh-hosts rejects other arguments without the exits FoamyNative reserves", { skip }, () => {
  const [program, ...args] = [...helper.argv, "ssh-hosts", "extra"]
  let status = 0
  try { execFileSync(program, args, { stdio: "pipe" }) } catch (error) { status = error.status }
  assert.equal(status, 2)
  assert.ok(!FoamyNative.unavailable(status))
})
