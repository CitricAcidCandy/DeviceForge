use crate::{
    bridge::{cli, native, transport, worker},
    cleanup::Cleanup,
    config::Config,
    model::{PROFILE, PROVIDER, SDK_VERSION, TurnInput, TurnResult},
    resources::Resources,
    stream::output::Writer,
    supervision::Launch,
};
use apk_plugin_sdk::cooperative::CleanupOutcome;
use deviceforge_plugin_runtime::InvocationContext;
use serde_json::Value;
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use tokio::sync::{Mutex, mpsc, oneshot};

pub struct Call {
    pub input: TurnInput,
    pub output_schema: Option<Value>,
    pub writer: Option<Writer>,
}

pub struct Success {
    pub result: TurnResult,
    pub raw_text: String,
}

pub struct Report {
    pub outcome: Result<Success, String>,
    pub cleanup: CleanupOutcome,
}

async fn failed(
    resources: &Arc<Resources>,
    cleanup: &Cleanup,
    error: String,
    scopes_complete: bool,
) -> Report {
    let complete = if scopes_complete {
        match cleanup.until() {
            Ok(until) => resources.cleanup(until).await.is_ok(),
            Err(_) => false,
        }
    } else {
        false
    };
    Report {
        outcome: Err(error),
        cleanup: if complete {
            CleanupOutcome::Complete
        } else {
            CleanupOutcome::Failed
        },
    }
}

fn launch(
    config: &Config,
    worker_path: PathBuf,
    identity: &transport::Identity,
    worker_port: u16,
    proxy_port: u16,
    temporary: &std::path::Path,
) -> Launch {
    let mut environment = BTreeMap::from([
        ("DF_SDK_PROFILE".into(), PROFILE.into()),
        ("DF_SDK_CALL_ID".into(), identity.call_id.clone()),
        ("DF_SDK_NONCE".into(), identity.nonce.clone()),
        ("DF_SDK_WORKER_PORT".into(), worker_port.to_string()),
        ("DF_SDK_PROXY_PORT".into(), proxy_port.to_string()),
        ("TEMP".into(), temporary.to_string_lossy().into_owned()),
        ("TMP".into(), temporary.to_string_lossy().into_owned()),
    ]);
    if let Ok(root) = std::env::var("SystemRoot") {
        environment.insert("SystemRoot".into(), root);
    }
    Launch {
        format_version: 1,
        call_id: identity.call_id.clone(),
        nonce: identity.nonce.clone(),
        node: config.node_executable.clone(),
        worker: worker_path,
        environment,
    }
}

pub async fn run(
    config: Arc<Config>,
    context: InvocationContext,
    worker_path: PathBuf,
    call: Call,
) -> Report {
    let project_root = match config.project(&call.input.project_id) {
        Ok(root) => root.to_owned(),
        Err(error) => {
            return Report {
                outcome: Err(error),
                cleanup: CleanupOutcome::Complete,
            };
        }
    };
    let resources = Resources::new(
        config.clone(),
        call.input.project_id.clone(),
        project_root.clone(),
    );
    let cleanup = Arc::new(Cleanup::default());
    let prepared = async {
        context.check().map_err(|error| error.to_string())?;
        if let Some(thread) = &call.input.thread_id {
            resources.resume(&context, thread.clone()).await?;
        }
        let temporary = resources.temporary(&context).await?;
        let worker_listener = transport::listen().await?;
        let proxy_listener = transport::listen().await?;
        let worker_port = worker_listener
            .local_addr()
            .map_err(|_| "SDK worker本机端口不可用")?
            .port();
        let proxy_port = proxy_listener
            .local_addr()
            .map_err(|_| "SDK代理本机端口不可用")?
            .port();
        let proxy = std::env::current_exe().map_err(|_| "SDK私有代理入口不可用")?;
        context.check().map_err(|error| error.to_string())?;
        Ok::<_, String>((
            temporary,
            worker_listener,
            proxy_listener,
            worker_port,
            proxy_port,
            proxy,
        ))
    }
    .await;
    let (temporary, worker_listener, proxy_listener, worker_port, proxy_port, proxy) =
        match prepared {
            Ok(prepared) => prepared,
            Err(error) => return failed(&resources, &cleanup, error, true).await,
        };
    let identity = transport::Identity::create();
    let stop = context.cancellation().child_token();
    let control = Arc::new(Mutex::new(None));
    let (ready_sender, ready_receiver) = oneshot::channel();
    let (raw_sender, raw_receiver) = mpsc::channel(32);
    let native_launch = launch(
        &config,
        worker_path,
        &identity,
        worker_port,
        proxy_port,
        &temporary,
    );
    let worker_work = worker::Work {
        config: config.clone(),
        input: call.input.clone(),
        project_root: project_root.clone(),
        temporary: temporary.clone(),
        proxy,
        output_schema: call.output_schema.clone(),
        resources: resources.clone(),
        writer: call.writer,
        control: control.clone(),
    };
    let cli_work = cli::Work {
        config: config.clone(),
        input: call.input.clone(),
        project_root,
        temporary,
        output_schema: call.output_schema,
        resources: resources.clone(),
        raw: raw_sender,
    };
    let worker_future = async {
        let outcome = worker::run(
            worker_listener,
            identity.clone(),
            worker_work,
            context.clone(),
            ready_receiver,
            raw_receiver,
        )
        .await;
        if outcome.is_err() {
            let _ = cleanup.until();
            stop.cancel();
        }
        outcome
    };
    let cli_future = async {
        let report = cli::run(
            proxy_listener,
            identity.clone(),
            cli_work,
            context.clone(),
            stop.clone(),
            cleanup.clone(),
        )
        .await;
        if report.outcome.is_err() {
            let _ = cleanup.until();
            stop.cancel();
        }
        report
    };
    let native_future = async {
        let report = native::run(
            native_launch,
            context.clone(),
            stop.clone(),
            cleanup.clone(),
            resources.clone(),
            control,
            ready_sender,
        )
        .await;
        if report.outcome.is_err() {
            let _ = cleanup.until();
            stop.cancel();
        }
        report
    };
    let work = async { tokio::join!(worker_future, cli_future, native_future) };
    tokio::pin!(work);
    let mut updates = cleanup.subscribe();
    let mut stopping = false;
    let reports = loop {
        let until = match cleanup.current() {
            Ok(Some(until)) => until,
            Ok(None) => context.deadline(),
            Err(error) => return failed(&resources, &cleanup, error, false).await,
        };
        tokio::select! {
            biased;
            reports = &mut work => break reports,
            _ = context.cancellation().cancelled_owned(), if !stopping => {
                stopping = true;
                let _ = cleanup.until();
                stop.cancel();
            }
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(until)) => {
                if cleanup.current().ok().flatten().is_some() {
                    stop.cancel();
                    return failed(&resources, &cleanup, "SDK协调器完整资源结束未确认".into(), false).await;
                }
                stopping = true;
                let _ = cleanup.until();
                stop.cancel();
            }
            _ = updates.changed() => {}
        }
    };
    let (worker, cli, native) = reports;
    let scopes_complete = cli.scope_complete && native.scope_complete;
    let mut success = match worker {
        Ok(success) => success,
        Err(error) => return failed(&resources, &cleanup, error, scopes_complete).await,
    };
    if let Err(error) = cli.outcome.and(native.outcome) {
        return failed(&resources, &cleanup, error, scopes_complete).await;
    }
    if !scopes_complete {
        return failed(
            &resources,
            &cleanup,
            "SDK完整资源范围没有成功退出资格".into(),
            false,
        )
        .await;
    }
    if let Err(error) = context.check() {
        return failed(&resources, &cleanup, error.to_string(), true).await;
    }
    let until = match cleanup.until() {
        Ok(until) => until,
        Err(error) => return failed(&resources, &cleanup, error, false).await,
    };
    let turns = match resources.commit(&context, until).await {
        Ok(turns) => turns,
        Err(error) => return failed(&resources, &cleanup, error, true).await,
    };
    let result = TurnResult {
        provider: PROVIDER,
        sdk_version: SDK_VERSION,
        project_id: call.input.project_id,
        thread_id: success.thread_id,
        text: success.public_text,
        turns: turns.to_string(),
        resource_scope: "sdk_worker_proxy_and_cli",
    };
    let qualification =
        crate::qualification::record(config, context.clone(), &result, until, resources.clone())
            .await;
    if let Err(error) = qualification.outcome {
        return Report {
            outcome: Err(error),
            cleanup: if qualification.worker_complete {
                CleanupOutcome::Complete
            } else {
                CleanupOutcome::Failed
            },
        };
    }
    if let Some(writer) = &mut success.writer
        && let Err(error) = writer.send(&context, &success.final_event).await
    {
        return Report {
            outcome: Err(error),
            cleanup: CleanupOutcome::Complete,
        };
    }
    Report {
        outcome: Ok(Success {
            result,
            raw_text: success.text,
        }),
        cleanup: CleanupOutcome::Complete,
    }
}
