// The vendored Flea matcher (see PROVENANCE.md) stays byte-identical to
// upstream: rustfmt skips it, and the lints it trips (unused filesystem-search
// APIs, newer clippy style lints) are allowed here at the module boundary.
#[rustfmt::skip]
#[allow(dead_code, clippy::unnecessary_map_or)]
mod backend;
mod engine;
mod protocol;

use std::io::{self, BufWriter};
use std::process::ExitCode;

fn main() -> ExitCode {
    // The kit's release profile aborts on panic. Exit 101 instead (as
    // unwinding did), so a bug never ends in SIGABRT and a core dump;
    // NativeSearch then falls back to the built-in matcher.
    foamy_helper::process::exit_on_panic(101);
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
