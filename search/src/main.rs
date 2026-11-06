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
