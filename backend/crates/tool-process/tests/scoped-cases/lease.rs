use super::os::ProcessObservation;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

pub struct Lease {
    observations: Arc<Mutex<Vec<ProcessObservation>>>,
    dropped: Option<oneshot::Sender<Value>>,
}

impl Lease {
    pub fn new(
        observations: Arc<Mutex<Vec<ProcessObservation>>>,
    ) -> (Arc<Self>, oneshot::Receiver<Value>) {
        let (sender, receiver) = oneshot::channel();
        (
            Arc::new(Self {
                observations,
                dropped: Some(sender),
            }),
            receiver,
        )
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let observations = self.observations.lock().expect("租约释放点的稳定OS句柄");
        let exited =
            !observations.is_empty() && observations.iter().all(ProcessObservation::exited);
        let value = json!({"all_exited_at_actual_drop":exited,"observed_count":observations.len(),
            "exits": if exited { observations.iter().map(ProcessObservation::exit_record).collect::<Vec<_>>() } else { Vec::new() }});
        if let Some(sender) = self.dropped.take() {
            let _ = sender.send(value);
        }
    }
}
