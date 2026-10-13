use crate::correlation::Correlation;
use deviceforge_observability::LogContext;
use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    model::*,
    service::{RequestContext, SubscriptionContext},
};
use std::{future::Future, time::Instant};
use tracing::Instrument;

#[derive(Clone)]
pub(crate) struct Observed<S>(pub S);
trait Metadata {
    fn metadata(&mut self) -> Option<&mut Option<MetaObject>>;
}
macro_rules! metadata {
    ($($kind:ty),*) => { $(impl Metadata for $kind { fn metadata(&mut self) -> Option<&mut Option<MetaObject>> { Some(&mut self.meta) } })* };
}
metadata!(InitializeResult, DiscoverResult, ListToolsResult);
impl Metadata for CallToolResponse {
    fn metadata(&mut self) -> Option<&mut Option<MetaObject>> {
        match self {
            Self::Complete(r) => Some(&mut r.meta),
            Self::InputRequired(r) => Some(&mut r.meta),
            Self::Task(r) => Some(&mut r.meta),
            _ => None,
        }
    }
}
struct Invocation {
    log: LogContext,
    span: tracing::Span,
}
impl Invocation {
    fn new(context: &RequestContext<RoleServer>, method: &'static str) -> Self {
        let correlation = context
            .extensions
            .get::<axum::http::request::Parts>()
            .and_then(|p| p.extensions.get::<Correlation>());
        let log = correlation.map(|c| c.context.clone()).unwrap_or_default();
        let parent = correlation
            .map(|c| c.span.clone())
            .unwrap_or_else(tracing::Span::current);
        let span = tracing::info_span!(parent: parent, "MCP调用", log_id = %log.log_id, method);
        Self { log, span }
    }
    async fn run<T: Metadata>(
        &self,
        future: impl Future<Output = Result<T, ErrorData>>,
    ) -> Result<T, ErrorData> {
        self.log
            .scope(
                async {
                    let started = Instant::now();
                    tracing::info!("MCP 调用开始");
                    let mut result = future.await;
                    match &mut result {
                        Ok(value) => {
                            value
                                .metadata()
                                .ok_or_else(|| {
                                    ErrorData::internal_error("MCP 响应类型尚未定义关联适配", None)
                                })?
                                .get_or_insert_with(|| MetaObject(Default::default()))
                                .0
                                .insert(
                                    "deviceforge/log_id".into(),
                                    serde_json::json!(self.log.log_id),
                                );
                        }
                        Err(error) => {
                            let mut data =
                                error.data.take().unwrap_or_else(|| serde_json::json!({}));
                            if !data.is_object() {
                                data = serde_json::json!({"details":data});
                            }
                            data["log_id"] = serde_json::json!(self.log.log_id);
                            error.data = Some(data);
                        }
                    }
                    tracing::info!(
                        success = result.is_ok(),
                        elapsed_us = started.elapsed().as_micros() as u64,
                        "MCP 调用结束"
                    );
                    result
                }
                .instrument(self.span.clone()),
            )
            .await
    }
}
impl<S: ServerHandler> ServerHandler for Observed<S> {
    fn get_info(&self) -> ServerConfig {
        self.0.get_info()
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.0.get_tool(name)
    }
    fn accepted_subscription_filter(
        &self,
        requested: &SubscriptionFilter,
    ) -> Option<SubscriptionFilter> {
        self.0.accepted_subscription_filter(requested)
    }
    async fn listen(&self, context: SubscriptionContext) -> Result<(), ErrorData> {
        let invocation = Invocation::new(context.request_context(), "subscriptions/listen");
        invocation
            .log
            .scope(
                async {
                    tracing::info!("MCP 工具目录订阅开始");
                    let mut result = self.0.listen(context).await;
                    if let Err(error) = &mut result {
                        let mut data = error.data.take().unwrap_or_else(|| serde_json::json!({}));
                        if !data.is_object() {
                            data = serde_json::json!({"details":data});
                        }
                        data["log_id"] = serde_json::json!(invocation.log.log_id);
                        error.data = Some(data);
                    }
                    tracing::info!(success = result.is_ok(), "MCP 工具目录订阅结束");
                    result
                }
                .instrument(invocation.span.clone()),
            )
            .await
    }
    fn supported_protocol_versions(&self) -> std::borrow::Cow<'static, [ProtocolVersion]> {
        self.0.supported_protocol_versions()
    }
    async fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<InitializeResult, ErrorData> {
        Invocation::new(&context, "initialize")
            .run(self.0.initialize(request, context))
            .await
    }
    async fn discover(
        &self,
        context: RequestContext<RoleServer>,
    ) -> Result<DiscoverResult, ErrorData> {
        Invocation::new(&context, "server/discover")
            .run(self.0.discover(context))
            .await
    }
    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Invocation::new(&context, "tools/list")
            .run(self.0.list_tools(request, context))
            .await
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        Invocation::new(&context, "tools/call")
            .run(self.0.call_tool(request, context))
            .await
    }
}
