mod probe;
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    probe::run(&args);
}