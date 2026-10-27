use super::*;
use apk_domain::{Error, Executor, Operation};
use async_trait::async_trait;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

struct Fixture {
    id: &'static str,
    version: &'static str,
    required: Option<&'static str>,
}
#[async_trait]
impl Executor for Fixture {
    fn operations(&self) -> Vec<Operation> {
        vec![Operation {
            id: self.id.into(),
            title: "服务夹具".into(),
            input_schema: json!({"type":"object"}),
            execution: None,
        }]
    }
    fn services(&self) -> ServiceAccess {
        ServiceAccess {
            provided: vec![ProvidedService {
                service: ServiceRef {
                    id: self.id.into(),
                    version: self.version.into(),
                },
                contract: ServiceContract {
                    input_schema: json!({"type":"object"}),
                    output_schema: json!({"type":"object"}),
                },
                operation: self.id.into(),
            }],
            required: self
                .required
                .map(|id| RequiredService {
                    service: ServiceRef {
                        id: id.into(),
                        version: "1.0".into(),
                    },
                    operations: vec![self.id.into()],
                    sessions: vec![],
                })
                .into_iter()
                .collect(),
        }
    }
    async fn execute(
        &self,
        _: &str,
        value: Value,
        _: CancellationToken,
    ) -> apk_domain::Result<Value> {
        Ok(value)
    }
}

#[test]
fn catalog_exact_string_matching_entry_scoped_dependencies_and_output_validation() {
    let registry = crate::registry::Registry::new(vec![
        Arc::new(Fixture {
            id: "demo.one",
            version: "1.0",
            required: Some("missing"),
        }),
        Arc::new(Fixture {
            id: "demo.two",
            version: "1",
            required: None,
        }),
    ])
    .unwrap();
    let catalog = registry.services().unwrap();
    assert_eq!(catalog.len(), 2);
    assert!(!catalog[0].available);
    assert!(catalog[1].available);
    assert!(
        registry
            .service(
                &ServiceRef {
                    id: "demo.two".into(),
                    version: "1.0".into()
                },
                None
            )
            .is_err()
    );
    let (provided, target) = registry
        .service(
            &ServiceRef {
                id: "demo.two".into(),
                version: "1".into(),
            },
            None,
        )
        .unwrap();
    super::nested::validate_output(&target, &provided.service, &json!({})).unwrap();
    assert!(super::nested::validate_output(&target, &provided.service, &json!(7)).is_err());
    assert!(
        registry
            .check_required(target.executor.as_ref(), "demo.two", false)
            .is_ok()
    );
}

#[test]
fn cycles_invalid_versions_and_conflicting_service_providers_are_rejected() {
    let registry = crate::registry::Registry::new(vec![
        Arc::new(Fixture {
            id: "demo.one",
            version: "1.0",
            required: Some("demo.two"),
        }),
        Arc::new(Fixture {
            id: "demo.two",
            version: "1.0",
            required: Some("demo.one"),
        }),
    ])
    .unwrap();
    assert!(
        registry
            .services()
            .unwrap()
            .iter()
            .all(|service| !service.available)
    );
    for version in ["", "  "] {
        assert!(
            validate(&Fixture {
                id: "demo",
                version,
                required: None
            })
            .is_err()
        );
    }
    assert!(matches!(
        registry.service(
            &ServiceRef {
                id: "demo.one".into(),
                version: "1.0".into()
            },
            None
        ),
        Err(Error::Conflict(_))
    ));
}
