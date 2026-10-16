# 插件配置

浏览器配置按服务地址和插件标识隔离持久化，修订值采用比较后写入，激活前校验声明版本及 JSON Schema。插件通过公开 `HostContext.configuration` 读取自身配置；需要重载的保存不会提前改变运行中插件的值。

服务器适配只消费公开 API 生成类型；页面视图使用 camelCase 字段。公共 SchemaForm 与配置对话框不读取该 feature，由页面注入配置回调。
