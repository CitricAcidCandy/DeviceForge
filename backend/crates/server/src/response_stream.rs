use axum::{
    body::{Body, Bytes},
    response::Response,
};
use futures_util::{Stream, StreamExt};
use std::{
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Instant,
};

#[derive(Clone)]
pub(crate) struct RequestPermit {
    pub _permit: Arc<tokio::sync::OwnedSemaphorePermit>,
}
struct Tracked {
    source: Pin<Box<dyn Stream<Item = Result<Bytes, axum::Error>> + Send>>,
    span: tracing::Span,
    started: Instant,
    bytes: u64,
    completed: bool,
    _permit: Option<RequestPermit>,
}
impl Stream for Tracked {
    type Item = Result<Bytes, axum::Error>;
    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let result = self.source.poll_next_unpin(context);
        match &result {
            Poll::Ready(Some(Ok(bytes))) => {
                self.bytes = self.bytes.saturating_add(bytes.len() as u64)
            }
            Poll::Ready(Some(Err(_))) => {
                self.completed = true;
                self._permit.take();
                tracing::warn!(parent: &self.span, response_bytes = self.bytes, "响应流发生错误");
            }
            Poll::Ready(None) => {
                if !self.completed {
                    self.completed = true;
                    self._permit.take();
                    tracing::info!(parent: &self.span, response_bytes = self.bytes, elapsed_us = self.started.elapsed().as_micros() as u64, "响应流已结束");
                }
            }
            _ => {}
        }
        result
    }
}
impl Drop for Tracked {
    fn drop(&mut self) {
        if !self.completed {
            tracing::warn!(parent: &self.span, response_bytes = self.bytes, "响应流被提前关闭");
        }
    }
}
pub(crate) fn track(response: Response, span: tracing::Span, started: Instant) -> Response {
    let (mut parts, body) = response.into_parts();
    let permit = parts.extensions.remove::<RequestPermit>();
    if parts.status.is_informational()
        || parts.status == axum::http::StatusCode::NO_CONTENT
        || parts.status == axum::http::StatusCode::NOT_MODIFIED
    {
        // 升级与无正文响应不要求 HTTP 层再次拉取 EOF，建立后即完成。
        drop(permit);
        tracing::info!(parent: &span, response_bytes = 0, elapsed_us = started.elapsed().as_micros() as u64, "响应流已结束");
        return Response::from_parts(parts, body);
    }
    Response::from_parts(
        parts,
        Body::from_stream(Tracked {
            source: Box::pin(body.into_data_stream()),
            span,
            started,
            bytes: 0,
            completed: false,
            _permit: permit,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Semaphore;

    #[tokio::test]
    async fn upgrade_and_empty_responses_release_slot_without_polling_body() {
        let slots = Arc::new(Semaphore::new(1));
        for status in [
            axum::http::StatusCode::SWITCHING_PROTOCOLS,
            axum::http::StatusCode::NO_CONTENT,
            axum::http::StatusCode::NOT_MODIFIED,
        ] {
            let mut response = Response::new(Body::empty());
            *response.status_mut() = status;
            response.extensions_mut().insert(RequestPermit {
                _permit: Arc::new(slots.clone().acquire_owned().await.unwrap()),
            });
            let response = track(response, tracing::Span::none(), Instant::now());
            // 客户端不会为这些响应拉取正文；HTTP 许可必须在连接仍存在时归还。
            assert_eq!(
                slots.available_permits(),
                1,
                "状态 {status} 不应保留普通请求许可"
            );
            drop(response);
        }
    }

    async fn guarded(body: Body, slots: &Arc<Semaphore>) -> Body {
        let mut response = Response::new(body);
        response.extensions_mut().insert(RequestPermit {
            _permit: Arc::new(slots.clone().acquire_owned().await.unwrap()),
        });
        track(response, tracing::Span::none(), Instant::now()).into_body()
    }

    #[tokio::test]
    async fn completion_error_and_disconnect_release_request_slot() {
        let slots = Arc::new(Semaphore::new(1));
        let body = guarded(Body::from("内容"), &slots).await;
        assert_eq!(slots.available_permits(), 0);
        let mut stream = body.into_data_stream();
        assert!(stream.next().await.unwrap().is_ok());
        assert!(stream.next().await.is_none());
        assert_eq!(slots.available_permits(), 1);

        let body = guarded(
            Body::from_stream(futures_util::stream::pending::<Result<Bytes, std::io::Error>>()),
            &slots,
        )
        .await;
        assert_eq!(slots.available_permits(), 0);
        drop(body);
        assert_eq!(slots.available_permits(), 1);

        let body = guarded(
            Body::from_stream(futures_util::stream::once(async {
                Err::<Bytes, _>(std::io::Error::other("模拟流错误"))
            })),
            &slots,
        )
        .await;
        assert!(body.into_data_stream().next().await.unwrap().is_err());
        assert_eq!(slots.available_permits(), 1);
    }
}
