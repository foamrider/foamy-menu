// The SSH scope's host list: `foamy-menu-search ssh-hosts` (Rust) against the
// retired Bash script (tests/fixtures/foamy-ssh-hosts.sh) over the same
// fixture homes. Where the two agree the output must be byte-identical. Where
// the Bash script misread ssh_config(5), each case records both outputs and
// why: Rust follows ssh, and the old output is checked too, so a difference
// can't appear or disappear unnoticed.
//
// The Bash script runs with LC_ALL=C. In another locale its `sort` orders
// Include glob matches by that locale's collation; ssh's glob(3) (and Rust)
// use byte order, since ssh only sets LC_CTYPE.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const helper = require("./search-helper.js")
const FoamyNative = require("../kit/node-loader.cjs").load("FoamyNative")

const script = path.join(__dirname, "fixtures/foamy-ssh-hosts.sh")
const skip = helper.skip && "no bundled search helper for this CPU"
const isRoot = typeof process.getuid === "function" && process.getuid() === 0

// A fixture home: files (text; @HOME@ is the home path), dirs, symlinks
// (path -> target, both relative to the home), FIFOs and file modes.
function makeHome(fixture) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "foamy-ssh-hosts-"))
  fs.mkdirSync(path.join(home, ".ssh"), { mode: 0o700 })
  const at = (rel) => path.join(home, rel)
  for (const dir of fixture.dirs || []) fs.mkdirSync(at(dir), { recursive: true })
  for (const [rel, text] of Object.entries(fixture.files || {})) {
    fs.mkdirSync(path.dirname(at(rel)), { recursive: true })
    fs.writeFileSync(at(rel), text.replaceAll("@HOME@", home), { mode: 0o600 })
  }
  for (const [rel, target] of Object.entries(fixture.links || {})) {
    fs.mkdirSync(path.dirname(at(rel)), { recursive: true })
    fs.symlinkSync(at(target), at(rel))
  }
  for (const rel of fixture.fifos || []) execFileSync("mkfifo", [at(rel)])
  for (const [rel, mode] of Object.entries(fixture.modes || {})) fs.chmodSync(at(rel), mode)
  return home
}

function env(home, fixture) {
  const out = { HOME: home, PATH: process.env.PATH, LC_ALL: "C" }
  if (fixture.config) out.FOAMY_SSH_CONFIG = path.join(home, fixture.config)
  return out
}

function runBash(home, fixture) {
  return execFileSync("bash", [script], { env: env(home, fixture), encoding: "utf8", timeout: 10000 })
}

function runRust(home, fixture, argv) {
  const [program, ...args] = argv || [...helper.argv, "ssh-hosts"]
  return execFileSync(program, args, { env: env(home, fixture), encoding: "utf8", timeout: 10000 })
}

const lines = (...rows) => rows.map((row) => row.join("\t") + "\n").join("")

// Both implementations print `out`.
const SAME = [
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
  }
]

// The Bash script got these wrong; Rust follows ssh_config(5).
const DIFFERENT = [
  {
    name: "`Key=value` without spaces",
    why: "ssh splits the keyword at whitespace or one `=`; the script only at whitespace, so `Host=x` and `HostName=x` were not seen",
    files: { ".ssh/config": "Host=eqhost\nHostName=10.0.0.1\nHost plain\nUser=me\n" },
    bash: lines(["plain", "plain", ""]),
    out: lines(["eqhost", "eqhost", "10.0.0.1"], ["plain", "plain", "me@plain"])
  },
  {
    name: "trailing comments",
    why: "ssh ends a line at an argument starting with `#`; the script listed the comment's words as hosts and kept them in values",
    files: { ".ssh/config": "Host web # the web server\n  HostName 10.0.0.4 # primary\n" },
    bash: lines(["#", "#", "10.0.0.4 # primary"], ["server", "server", "10.0.0.4 # primary"], ["the", "the", "10.0.0.4 # primary"], ["web", "web", "10.0.0.4 # primary"]),
    out: lines(["web", "web", "10.0.0.4"])
  },
  {
    name: "single quotes, quotes inside a word and escapes",
    why: "ssh's argv_split handles both quote kinds anywhere in a word and `\\` escapes; the script only dropped one double quote at each end. Names that hold whitespace are not hosts",
    files: { ".ssh/config": "Host 'single' \"two words\" esc\\ aped\n  User 'admin'\n  HostName \"a\"b\n" },
    bash: lines(...["'single'", "aped", "esc\\", "two", "words"].map((h) => [h, h, "'admin'@a\"b"])),
    out: lines(["single", "single", "admin@ab"])
  },
  {
    name: "Include is read where it stands",
    why: "ssh reads an included file at the Include line, so its values come first; the script read the whole including file first",
    files: {
      ".ssh/config": "Include first.conf\nHost db\n  HostName from-main\n",
      ".ssh/first.conf": "Host db\n  HostName from-include\n  User inc\n"
    },
    bash: lines(["db", "db", "inc@from-main"]),
    out: lines(["db", "db", "inc@from-include"])
  },
  {
    name: "an included file continues the including Host block",
    why: "ssh applies an included file's lines before its own first Host to the block the Include is in; the script ignored them",
    files: {
      ".ssh/config": "Host web\n  Include web-settings.conf\n  User after\n",
      ".ssh/web-settings.conf": "HostName 10.0.0.4\nUser inside\n"
    },
    bash: lines(["web", "web", "after@web"]),
    out: lines(["web", "web", "inside@10.0.0.4"])
  },
  {
    name: "CRLF Include lines",
    why: "ssh strips trailing whitespace, \\r included, before splitting; the script kept the \\r in the Include path",
    files: { ".ssh/config": "Include extra.conf\r\nHost main\r\n", ".ssh/extra.conf": "Host extra\r\n" },
    bash: lines(["main", "main", ""]),
    out: lines(["extra", "extra", ""], ["main", "main", ""])
  },
  {
    name: "a keyword without a value, and extra values",
    why: "ssh rejects `User` with no argument (the script kept an empty first value) and takes one argument (the script kept the rest of the line)",
    files: { ".ssh/config": "Host web\n  User\n  User deploy\n  HostName a b\n" },
    bash: lines(["web", "web", "a b"]),
    out: lines(["web", "web", "deploy@a"])
  }
]

function compare(fixture, check) {
  const home = makeHome(fixture)
  try {
    check(runBash(home, fixture), runRust(home, fixture), home)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

for (const fixture of SAME) {
  const why = skip || (fixture.unreadable && isRoot && "root reads unreadable files")
  test(`ssh-hosts matches the Bash script: ${fixture.name}`, { skip: why }, () => {
    compare(fixture, (bash, rust) => {
      assert.equal(rust, bash, "byte-identical to the Bash script")
      assert.equal(rust, fixture.out)
    })
  })
}

for (const fixture of DIFFERENT) {
  test(`ssh-hosts follows ssh where the Bash script did not: ${fixture.name}`, { skip }, () => {
    assert.ok(fixture.why)
    compare(fixture, (bash, rust) => {
      assert.equal(bash, fixture.bash, "the Bash script's documented output")
      assert.equal(rust, fixture.out)
    })
  })
}

test("ssh-hosts rejects other arguments without the exits FoamyNative reserves", { skip }, () => {
  const [program, ...args] = [...helper.argv, "ssh-hosts", "extra"]
  let status = 0
  try { execFileSync(program, args, { stdio: "pipe" }) } catch (error) { status = error.status }
  assert.equal(status, 2)
  assert.ok(!FoamyNative.unavailable(status))
})
