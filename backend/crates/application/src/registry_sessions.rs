use crate::{registration, registry::Owner};
use apk_domain::{
    Error, Operation, OperationExecution, OperationExecutionSource, Result, interactive::*,
};
use std::{collections::BTreeMap, sync::Arc};

pub(crate) struct RegisteredSession {
    pub definition: SessionDefinition,
    pub provider: Arc<dyn SessionProvider>,
    pub validator: jsonschema::Validator,
    pub owner: Arc<Owner>,
}

pub(crate) fn prepare(
    provider: Option<&Arc<dyn SessionProvider>>,
    owner: &Arc<Owner>,
    definitions: Vec<SessionDefinition>,
) -> Result<BTreeMap<String, Arc<RegisteredSession>>> {
    let mut sessions = BTreeMap::new();
    if let Some(provider) = provider {
        for mut definition in definitions {
            definition.validate(&owner.info().id)?;
            if definition.execution.is_none() {
                definition.execution = Some(OperationExecution {
                    api_version: 1,
                    total_timeout_ms: apk_domain::operation_execution::DEFAULT_TOTAL_TIMEOUT_MS,
                    source: OperationExecutionSource::Default,
                });
            }
            let validator = registration::compile(&Operation {
                id: definition.id.clone(),
                title: definition.title.clone(),
                input_schema: definition.input_schema.clone(),
                execution: definition.execution,
            })?;
            let id = definition.id.clone();
            if sessions
                .insert(
                    id,
                    Arc::new(RegisteredSession {
                        definition,
                        provider: provider.clone(),
                        validator,
                        owner: owner.clone(),
                    }),
                )
                .is_some()
            {
                return Err(Error::Conflict("会话贡献重复注册".into()));
            }
            if sessions.len() > 4096 {
                return Err(Error::TooLarge);
            }
        }
    }
    Ok(sessions)
}

impl crate::registry::Registry {
    pub(crate) fn contributions_snapshot(&self) -> (u64, Vec<Operation>, Vec<SessionDefinition>) {
        let snapshot = self
            .0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (
            snapshot.revision,
            snapshot
                .entries
                .values()
                .map(|entry| entry.operation.clone())
                .collect(),
            snapshot
                .sessions
                .values()
                .map(|entry| entry.definition.clone())
                .collect(),
        )
    }

    pub(crate) fn session_definitions(&self) -> (u64, Vec<SessionDefinition>) {
        let snapshot = self
            .0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (
            snapshot.revision,
            snapshot
                .sessions
                .values()
                .map(|entry| entry.definition.clone())
                .collect(),
        )
    }

    pub(crate) fn session(&self, operation: &str) -> Result<Arc<RegisteredSession>> {
        self.0
            .read()
            .map_err(|_| Error::Storage("会话注册表读取异常".into()))?
            .sessions
            .get(operation)
            .cloned()
            .ok_or_else(|| Error::NotFound("会话贡献未注册".into()))
    }

    pub(crate) fn current_session(&self, entry: &Arc<RegisteredSession>) -> Result<bool> {
        Ok(self
            .0
            .read()
            .map_err(|_| Error::Storage("会话注册表资格异常".into()))?
            .sessions
            .get(&entry.definition.id)
            .is_some_and(|current| Arc::ptr_eq(current, entry)))
    }
}
