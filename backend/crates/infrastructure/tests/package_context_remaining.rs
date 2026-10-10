// 四个公开包端口的独立黑盒验收；原 package_context 输入保持冻结。
#[path = "fixtures/package_context_remaining/deadlines.rs"]
mod deadlines;
#[path = "fixtures/package_context_remaining/mod.rs"]
mod fixture;
#[path = "fixtures/package_context_remaining/outputs.rs"]
mod outputs;
