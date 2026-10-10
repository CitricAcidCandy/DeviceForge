// 独立公开端口回归；不访问私有 worker 池或旧模块 tests.rs。
#[path = "fixtures/package_context/deadlines.rs"]
mod deadlines;
#[path = "fixtures/package_context/mod.rs"]
mod fixture;
#[path = "fixtures/package_context/outputs.rs"]
mod outputs;
