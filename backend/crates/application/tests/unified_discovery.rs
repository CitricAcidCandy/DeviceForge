//! 统一发现的公开应用集成；受控端口不代表真实进程或 HTTP 原子性。
#[path = "unified_discovery_fixtures/mod.rs"]
mod fixtures;

#[path = "unified_discovery_fixtures/admission.rs"]
mod admission;
#[path = "unified_discovery_fixtures/deadlines.rs"]
mod deadlines;
#[path = "unified_discovery_fixtures/lifecycle.rs"]
mod lifecycle;
#[path = "unified_discovery_fixtures/publication.rs"]
mod publication;
