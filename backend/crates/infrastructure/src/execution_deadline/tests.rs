use super::*;
use std::{cell::Cell, time::Duration};

#[tokio::test]
async fn expired_and_cancelled_prechecks_do_not_poll_the_work() {
    for expired in [false, true] {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let deadline = if expired {
            Instant::now() - Duration::from_secs(1)
        } else {
            Instant::now() + Duration::from_secs(60)
        };
        let polled = Cell::new(false);
        let result = run(&cancel, Some(deadline), async {
            polled.set(true);
            Ok(())
        })
        .await;
        assert!(!polled.get(), "到期或取消前检必须阻止首次副作用");
        if expired {
            assert!(matches!(result, Err(Error::Timeout)));
        } else {
            assert!(matches!(result, Err(Error::Cancelled)));
        }
    }
}

#[tokio::test(start_paused = true)]
async fn waiting_uses_the_absolute_deadline_without_a_new_stage_budget() {
    let cancel = CancellationToken::new();
    let deadline = Instant::now() + Duration::from_millis(700);
    let result = run(&cancel, Some(deadline), pending::<Result<()>>()).await;
    assert!(matches!(result, Err(Error::Timeout)));
    assert!(Instant::now() >= deadline);
}

#[tokio::test(start_paused = true)]
async fn cancellation_observed_before_deadline_remains_cancelled() {
    let cancel = CancellationToken::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    let result = run(&cancel, Some(deadline), async {
        cancel.cancel();
        pending::<Result<()>>().await
    })
    .await;
    assert!(matches!(result, Err(Error::Cancelled)));
    assert!(Instant::now() < deadline);
}

#[tokio::test]
async fn expiry_reclassification_never_replaces_unconfirmed_cleanup() {
    let deadline = Some(Instant::now() - Duration::from_secs(1));
    assert!(matches!(
        classify(Error::Cancelled, deadline),
        Error::Timeout
    ));
    assert!(matches!(
        classify(Error::CleanupFailed, deadline),
        Error::CleanupFailed
    ));
    assert!(matches!(classify(Error::Cancelled, None), Error::Cancelled));
    assert!(matches!(
        classify(
            Error::Cancelled,
            Some(Instant::now() + Duration::from_secs(60))
        ),
        Error::Cancelled
    ));
}
