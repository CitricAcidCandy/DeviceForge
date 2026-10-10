//! 宿主适配器的结果来源声明；在线插件业务 JSON 不拥有声明权。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ExecutorResultFormat {
    #[default]
    Json,
    /// 外层包装和产物元数据由宿主生成，产物已在本次调用中完成发布。
    PublishedArtifacts,
}
