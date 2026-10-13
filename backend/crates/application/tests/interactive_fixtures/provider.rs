use super::transport::{Control, Handle};
use apk_domain::{
    Result,
    interactive::{SessionDefinition, SessionLaunch, SessionProvider, SessionRequest},
};
use serde_json::json;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio_util::sync::CancellationToken;

pub const OPERATION: &str = "plugin.test.live";

pub struct Provider {
    definitions: Vec<SessionDefinition>,
    pub controls: Mutex<Vec<Arc<Control>>>,
    pub requests: Mutex<Vec<SessionRequest>>,
    pub opens: AtomicUsize,
    pub starts: Arc<AtomicUsize>,
    pub exits: Arc<AtomicUsize>,
    pub unresolved: Arc<AtomicBool>,
    pub ready_on_open: AtomicBool,
    pub hold_cleanup: AtomicBool,
}

pub fn definition(id: &str) -> SessionDefinition {
    SessionDefinition {
        id: id.into(),
        title: "独立交互测试".into(),
        input_schema: json!({
            "type":"object", "required":["label"], "additionalProperties":false,
            "properties":{"label":{"type":"string","minLength":1}}
        }),
        execution: None,
        output_retention: Default::default(),
    }
}

impl Provider {
    pub fn new(definitions: Vec<SessionDefinition>) -> Arc<Self> {
        Arc::new(Self {
            definitions,
            controls: Mutex::new(Vec::new()),
            requests: Mutex::new(Vec::new()),
            opens: AtomicUsize::new(0),
            starts: Arc::new(AtomicUsize::new(0)),
            exits: Arc::new(AtomicUsize::new(0)),
            unresolved: Arc::new(AtomicBool::new(false)),
            ready_on_open: AtomicBool::new(true),
            hold_cleanup: AtomicBool::new(false),
        })
    }

    pub fn standard() -> Arc<Self> {
        Self::new(vec![definition(OPERATION)])
    }

    pub fn control(&self, ordinal: usize) -> Arc<Control> {
        self.controls.lock().unwrap()[ordinal].clone()
    }
}

impl SessionProvider for Provider {
    fn definitions(&self) -> Vec<SessionDefinition> {
        self.definitions.clone()
    }

    fn open(&self, request: SessionRequest, cancel: CancellationToken) -> Result<SessionLaunch> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        self.requests.lock().unwrap().push(request);
        let (control, output) = Control::new(
            cancel,
            self.ready_on_open.load(Ordering::SeqCst),
            self.hold_cleanup.load(Ordering::SeqCst),
        );
        self.controls.lock().unwrap().push(control.clone());
        let starts = self.starts.clone();
        let exits = self.exits.clone();
        let unresolved = self.unresolved.clone();
        let supervisor_control = control.clone();
        Ok(SessionLaunch {
            handle: Box::new(Handle::new(control, output)),
            supervisor: Box::pin(async move {
                starts.fetch_add(1, Ordering::SeqCst);
                supervisor_control.supervise(unresolved).await;
                exits.fetch_add(1, Ordering::SeqCst);
            }),
        })
    }

    fn has_unresolved_resources(&self) -> bool {
        self.unresolved.load(Ordering::SeqCst)
    }
}
