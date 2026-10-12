//! 只记录管道握手，不捕获或回放实际桌面事件。
use std::{fs, io::{self, BufRead}};
fn main() {
    fs::write("started", std::process::id().to_string()).unwrap();
    if std::env::args().nth(1).as_deref() == Some("early") { return; }
    let mut line = String::new();
    io::stdin().lock().read_line(&mut line).unwrap();
    if line != "exit\n" { std::process::exit(2); }
    fs::write("saved", "stdin_exit").unwrap();
}
