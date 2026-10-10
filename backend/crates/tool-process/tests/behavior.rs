//! 公共工具进程端口的真实进程行为测试；不依赖宿主或平台业务。

#[path = "cases/capture.rs"]
mod capture_cases;
#[path = "cases/environment.rs"]
mod environment_cases;
#[path = "cases/file_output.rs"]
mod file_output_cases;
#[path = "cases/lifecycle.rs"]
mod lifecycle_cases;
#[path = "cases/ownership.rs"]
mod ownership_cases;
mod support;
