#!/usr/bin/env bash
# The retired bin/foamy-ssh-hosts (foamy-menu 2.0.0), kept unchanged below this
# note only for tests/ssh-hosts.test.js, which runs it with `bash` next to
# `foamy-menu-search ssh-hosts` and requires the same output (or a documented
# difference). Nothing in the plugin runs it.
# The built-in SSH scope's items: every concrete Host in ~/.ssh/config and the
# files it Includes, one per line as "host<TAB>host<TAB>user@hostname:port".
# Wildcard patterns (*, ?, !) are skipped; the first value of each setting
# wins, as in ssh. Prints nothing when there is no readable config.

set -u

config="${FOAMY_SSH_CONFIG:-$HOME/.ssh/config}"
declare -A visited=()

# One line per host setting found in a file: "host<TAB>key<TAB>value".
settings() {
  awk '
    BEGIN { n = 0 }
    {
      sub(/^[ \t]+/, ""); sub(/[ \t\r]+$/, "")
      if ($0 == "" || substr($0, 1, 1) == "#") next
      line = $0
      key = tolower($1)
      sub(/^[^ \t=]+[ \t]*=?[ \t]*/, "", line)
      if (key == "host") {
        n = 0
        count = split(line, names, /[ \t]+/)
        for (i = 1; i <= count; i++) {
          name = names[i]
          gsub(/^"|"$/, "", name)
          if (name == "" || name ~ /[*?!]/) continue
          hosts[++n] = name
          print name "\thost\t"
        }
      } else if (key == "match") {
        n = 0
      } else if (key == "hostname" || key == "user" || key == "port") {
        value = line
        gsub(/^"|"$/, "", value)
        for (i = 1; i <= n; i++) print hosts[i] "\t" key "\t" value
      }
    }
  ' "$1" 2>/dev/null
}

includes() {
  awk 'tolower($1) == "include" { $1 = ""; sub(/^[ \t]+/, ""); print }' "$1" 2>/dev/null
}

walk() {
  local file=$1 line raw pattern match
  local -a patterns=()
  [[ -r "$file" && -f "$file" ]] || return 0
  file=$(readlink -f -- "$file") || return 0
  [[ -z "${visited[$file]:-}" ]] || return 0
  visited[$file]=1
  settings "$file"
  while IFS= read -r line; do
    read -r -a patterns <<< "$line"
    for raw in "${patterns[@]}"; do
      pattern=${raw#\"}; pattern=${pattern%\"}
      # shellcheck disable=SC2088 # a literal ~/ prefix, expanded by hand below
      if [[ "$pattern" == "~/"* ]]; then
        pattern="$HOME/${pattern:2}"
      elif [[ "$pattern" != /* ]]; then
        pattern="$HOME/.ssh/$pattern"
      fi
      if [[ -f "$pattern" ]]; then
        walk "$pattern"
        continue
      fi
      while IFS= read -r match; do
        walk "$match"
      done < <(compgen -G "$pattern" | sort || true)
    done
  done < <(includes "$file")
}

walk "$config" | awk -F '\t' '
  {
    host = $1; key = $2
    if (!(host in seen)) { seen[host] = 1; order[++count] = host }
    if (key != "host" && !((host, key) in value)) value[host, key] = $3
  }
  END {
    for (i = 1; i <= count; i++) {
      host = order[i]
      target = ((host, "hostname") in value) ? value[host, "hostname"] : ""
      user = ((host, "user") in value) ? value[host, "user"] : ""
      port = ((host, "port") in value) ? value[host, "port"] : ""
      subtitle = target
      if (user != "") subtitle = user "@" (target != "" ? target : host)
      if (port != "" && port != "22") subtitle = (subtitle != "" ? subtitle : host) ":" port
      print host "\t" host "\t" subtitle
    }
  }
' | LC_ALL=C sort -f -t $'\t' -k1,1
