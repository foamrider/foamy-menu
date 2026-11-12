// The vendored Flea matcher (see PROVENANCE.md) stays byte-identical to
// upstream: rustfmt skips it, and the lints it trips (unused filesystem-search
// APIs, newer clippy style lints) are allowed here at the module boundary.
#[rustfmt::skip]
#[allow(dead_code, clippy::unnecessary_map_or)]
mod backend;
mod catalogs;
mod engine;
mod protocol;
mod ssh_hosts;
mod steam_games;
mod strictness;

use std::io::{self, BufWriter};
use std::process::ExitCode;

fn main() -> ExitCode {
    // The kit's release profile aborts on panic. Exit 101 instead (as
    // unwinding did), so a bug never ends in SIGABRT and a core dump;
    // NativeSearch then falls back to the built-in matcher.
    foamy_helper::process::exit_on_panic(101);
    // `foamy-menu-search` answers search requests on stdin (see protocol.rs);
    // `foamy-menu-search ssh-hosts` prints the SSH scope's hosts and exits
    // (see ssh_hosts.rs); `foamy-menu-search steam-games` prints the Steam
    // Games scope's installed games and exits (see steam_games.rs). Exit codes stay clear of 126/127, which
    // FoamyNative reserves for "no helper for this CPU".
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    match args.as_slice() {
        [] => {}
        [command] if command == "ssh-hosts" => return ssh_hosts::main(),
        [command] if command == "steam-games" => return steam_games::main(),
        _ => {
            eprintln!("usage: foamy-menu-search [ssh-hosts | steam-games]");
            return ExitCode::from(2);
        }
    }
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut output = BufWriter::new(stdout.lock());
    match protocol::run(stdin.lock(), &mut output) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("foamy-menu-search: {error}");
            ExitCode::FAILURE
        }
    }
}
