use super::Session;
use crate::Result;

impl Session {
    pub(super) async fn work<T: Send + 'static>(
        &self,
        work: impl FnOnce(&dyn Fn() -> Result<()>) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.control.work(work).await
    }
}
