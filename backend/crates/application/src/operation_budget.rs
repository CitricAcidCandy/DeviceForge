//! 注册时固化普通预算，准入时计算唯一截止点；不读取业务输入或平台名称。
use crate::registry::Registered;
use apk_domain::{
    Error, Operation, OperationExecution, OperationExecutionSource, Result,
    devices::DeviceProviderDefinition, operation_execution::DEFAULT_TOTAL_TIMEOUT_MS,
};
use std::time::Duration;

pub(crate) fn registered(
    mut operation: Operation,
    provider: Option<&DeviceProviderDefinition>,
) -> Result<Operation> {
    if let Some(execution) = &operation.execution {
        execution.validate()?;
    }
    let special = provider.is_some_and(|provider| {
        provider.discover_operation == operation.id
            || provider
                .capabilities
                .iter()
                .any(|capability| capability.operation == operation.id)
    });
    if special {
        if operation.execution.is_some() {
            return Err(Error::Invalid("设备贡献不能重复声明普通执行预算".into()));
        }
    } else if operation.execution.is_none() {
        operation.execution = Some(OperationExecution {
            api_version: 1,
            total_timeout_ms: DEFAULT_TOTAL_TIMEOUT_MS,
            source: OperationExecutionSource::Default,
        });
    }
    Ok(operation)
}

pub(crate) fn deadline(
    registered: &Registered,
    admitted_at: tokio::time::Instant,
    special: Option<tokio::time::Instant>,
    inherited: Option<tokio::time::Instant>,
) -> Option<tokio::time::Instant> {
    let own = special.or_else(|| {
        registered
            .operation
            .execution
            .as_ref()
            .map(|execution| admitted_at + Duration::from_millis(execution.total_timeout_ms))
    });
    match (own, inherited) {
        (Some(own), Some(parent)) => Some(own.min(parent)),
        (own, parent) => own.or(parent),
    }
}

pub(crate) fn check(
    deadline: Option<tokio::time::Instant>,
    cancel: Option<&tokio_util::sync::CancellationToken>,
) -> Result<()> {
    if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
        Err(Error::Timeout)
    } else if cancel.is_some_and(tokio_util::sync::CancellationToken::is_cancelled) {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apk_domain::{Executor, devices::DeviceProviderDefinition};
    use async_trait::async_trait;
    use serde_json::{Value, json};
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    struct Echo;
    fn operation(execution: Option<OperationExecution>) -> Operation {
        Operation {
            id: "ordinary.echo".into(),
            title: "普通回显".into(),
            input_schema: json!({"type":"object"}),
            execution,
        }
    }
    #[async_trait]
    impl Executor for Echo {
        fn operations(&self) -> Vec<Operation> {
            vec![operation(None)]
        }
        fn device_provider(&self) -> Option<DeviceProviderDefinition> {
            None
        }
        async fn execute(&self, _: &str, input: Value, _: CancellationToken) -> Result<Value> {
            Ok(input)
        }
    }

    #[test]
    fn ordinary_registration_exposes_effective_default_and_preserves_declared() {
        let registered = registered(operation(None), None).unwrap();
        let effective = registered.execution.unwrap();
        assert_eq!(effective.total_timeout_ms, DEFAULT_TOTAL_TIMEOUT_MS);
        assert_eq!(effective.source, OperationExecutionSource::Default);
        let declared = OperationExecution {
            api_version: 1,
            total_timeout_ms: 120_000,
            source: OperationExecutionSource::Declared,
        };
        assert_eq!(
            super::registered(operation(Some(declared)), None)
                .unwrap()
                .execution,
            Some(declared)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn ordinary_deadline_uses_admission_and_parent_only_tightens() {
        let registry = crate::registry::Registry::new(vec![Arc::new(Echo)]).unwrap();
        let registered = registry.find("ordinary.echo").unwrap();
        let admitted = tokio::time::Instant::now();
        let own = admitted + Duration::from_secs(60);
        tokio::time::advance(Duration::from_secs(20)).await;
        assert_eq!(deadline(&registered, admitted, None, None), Some(own));
        let parent = admitted + Duration::from_secs(30);
        assert_eq!(
            deadline(&registered, admitted, None, Some(parent)),
            Some(parent)
        );
        assert_eq!(
            deadline(
                &registered,
                admitted,
                None,
                Some(own + Duration::from_secs(1))
            ),
            Some(own)
        );
        let special = admitted + Duration::from_secs(120);
        assert_eq!(
            deadline(&registered, admitted, Some(special), None),
            Some(special)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn expired_budget_wins_diagnosis_without_changing_terminal_store_rules() {
        let cancel = CancellationToken::new();
        let due = tokio::time::Instant::now();
        cancel.cancel();
        assert!(matches!(
            check(Some(due), Some(&cancel)),
            Err(Error::Timeout)
        ));
        assert!(matches!(check(None, Some(&cancel)), Err(Error::Cancelled)));
    }

    #[tokio::test(start_paused = true)]
    async fn registered_submission_inherits_parent_without_extending_its_own_budget() {
        struct Recorder(std::sync::Mutex<Vec<apk_domain::ExecutionContext>>);
        #[async_trait]
        impl Executor for Recorder {
            fn operations(&self) -> Vec<Operation> {
                vec![operation(None)]
            }
            async fn execute(&self, _: &str, _: Value, _: CancellationToken) -> Result<Value> {
                panic!("实际提交入口必须传播执行上下文");
            }
            async fn execute_with_context(
                &self,
                _: &str,
                input: Value,
                _: CancellationToken,
                context: apk_domain::ExecutionContext,
            ) -> Result<Value> {
                self.0.lock().unwrap().push(context);
                Ok(input)
            }
        }
        for parent_seconds in [30, 90] {
            let probe = Arc::new(Recorder(std::sync::Mutex::new(vec![])));
            let app = crate::Application::new(
                Arc::new(apk_infrastructure::store::SqliteStore::open(":memory:").unwrap()),
                vec![probe.clone()],
                1,
                4,
            )
            .unwrap();
            let admitted = tokio::time::Instant::now();
            let job = app
                .submit_registered_until(
                    "ordinary.echo",
                    json!({}),
                    app.registry.find("ordinary.echo").unwrap(),
                    None,
                    Some(admitted + Duration::from_secs(parent_seconds)),
                )
                .unwrap();
            let watchdog = std::time::Instant::now();
            while !app.get(&job.id).unwrap().status.is_terminal() {
                assert!(
                    watchdog.elapsed() < Duration::from_secs(2),
                    "实际提交未收敛"
                );
                tokio::task::yield_now().await;
            }
            let received = probe.0.lock().unwrap()[0].deadline.unwrap();
            assert_eq!(
                tokio::time::Instant::from_std(received),
                admitted + Duration::from_secs(parent_seconds.min(60))
            );
            assert_eq!(
                app.get(&job.id).unwrap().status,
                apk_domain::JobStatus::Succeeded
            );
            app.shutdown().await.unwrap();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn expired_parent_at_registered_submission_creates_no_job() {
        let app = crate::Application::new(
            Arc::new(apk_infrastructure::store::SqliteStore::open(":memory:").unwrap()),
            vec![Arc::new(Echo)],
            1,
            4,
        )
        .unwrap();
        assert!(matches!(
            app.submit_registered_until(
                "ordinary.echo",
                json!({}),
                app.registry.find("ordinary.echo").unwrap(),
                None,
                Some(tokio::time::Instant::now()),
            ),
            Err(Error::Timeout)
        ));
        assert!(app.list(16).unwrap().is_empty());
        app.shutdown().await.unwrap();
    }
}
