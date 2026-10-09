use serde_json::{Value, json};

fn schema<T: schemars::JsonSchema>() -> Value {
    let mut settings = schemars::generate::SchemaSettings::draft2020_12();
    settings.inline_subschemas = true;
    serde_json::to_value(settings.into_generator().into_root_schema_for::<T>())
        .expect("公开类型必须可序列化为模式")
}
fn response(description: &str, schema: Value) -> Value {
    json!({"description":description,"content":{"application/json":{"schema":schema}}})
}
fn endpoint(description: &str, success: &str, output_schema: Value) -> Value {
    json!({"summary":description,"responses":{
        success: response("成功", output_schema),
        "400":response("输入无效", schema::<crate::Failure>()),
        "401":response("鉴权失败", schema::<crate::Failure>()),
        "404":response("资源不存在", schema::<crate::Failure>()),
        "409":response("状态冲突或队列已满", schema::<crate::Failure>()),
        "429":response("请求过于频繁", schema::<crate::Failure>()),
        "500":response("服务异常", schema::<crate::Failure>())
    }})
}
pub fn document() -> Value {
    let mut submit = endpoint("提交操作任务", "202", schema::<apk_domain::Job>());
    submit["requestBody"] = json!({"required":true,"content":{"application/json":{"schema":schema::<crate::Submit>()}}});
    submit["responses"]["413"] = response("请求超过 256 KiB", schema::<crate::Failure>());
    submit["responses"]["415"] = response("请求媒体类型无效", schema::<crate::Failure>());
    let id = json!({"name":"id","in":"path","required":true,"schema":{"type":"string"}});
    let mut jobs = endpoint("最近任务列表", "200", schema::<Vec<apk_domain::Job>>());
    jobs["parameters"] = json!([{"name":"limit","in":"query","schema":{"type":"integer","minimum":1,"maximum":200,"default":50}}]);
    let mut events = endpoint(
        "按游标读取任务事件",
        "200",
        schema::<Vec<apk_domain::JobEvent>>(),
    );
    events["parameters"] =
        json!([{"name":"after","in":"query","schema":{"type":"integer","minimum":0,"default":0}}]);
    let mut upload = endpoint(
        "流式上传产物",
        "201",
        schema::<apk_domain::artifacts::Artifact>(),
    );
    upload["parameters"] = json!([{"name":"filename","in":"query","required":true,"schema":{"type":"string","minLength":1,"maxLength":180},"description":"不含路径的文件名，UTF-8 最多 180 字节"}]);
    upload["requestBody"] = json!({"required":true,"content":{"application/octet-stream":{"schema":{"type":"string","format":"binary"}}}});
    upload["responses"]["413"] = response("产物超过类型大小或结构上限", schema::<crate::Failure>());
    upload["responses"]["415"] = response("上传媒体类型错误", schema::<crate::Failure>());
    upload["responses"]["503"] = response("产物存储尚未配置", schema::<crate::Failure>());
    let mut entries = endpoint(
        "分页预览 ZIP 容器条目",
        "200",
        schema::<apk_domain::artifacts::ArchivePage>(),
    );
    entries["parameters"] = json!([
        {"name":"offset","in":"query","schema":{"type":"integer","minimum":0,"default":0}},
        {"name":"limit","in":"query","schema":{"type":"integer","minimum":1,"maximum":200,"default":50}}
    ]);
    let download = json!({"summary":"流式下载产物","responses":{
        "200":{"description":"产物内容，强制附件下载","content":{
            "application/zip":{"schema":{"type":"string","format":"binary"}},
            "image/png":{"schema":{"type":"string","format":"binary"}},
            "application/json":{"schema":{"type":"string","format":"binary"}},
            "application/msgpack":{"schema":{"type":"string","format":"binary"}}
        }},
        "400":response("ID 无效",schema::<crate::Failure>()),
        "401":response("鉴权失败",schema::<crate::Failure>()),
        "404":response("产物不存在",schema::<crate::Failure>()),
        "409":response("下载并发已满",schema::<crate::Failure>()),
        "429":response("请求过于频繁",schema::<crate::Failure>()),
        "500":response("产物存储异常",schema::<crate::Failure>()),
        "503":response("存储未配置",schema::<crate::Failure>())
    }});
    let mut document = json!({
        "openapi":"3.1.0", "info":{"title":"DeviceForge 公开服务接口","version":env!("CARGO_PKG_VERSION")},
        "security":[{}, {"bearerAuth":[]}],
        "components":{
            "securitySchemes":{"bearerAuth":{"type":"http","scheme":"bearer"}},
            "schemas":{
                "PackageManifest":schema::<apk_domain::packages::PackageManifest>(),
                "PackageSignature":schema::<apk_domain::packages::PackageSignature>(),
                "ExtractedSplits":schema::<apk_domain::splits::ExtractedSplits>(),
                "ApksInstalled":schema::<apk_domain::splits::ApksInstalled>(),
                "BuiltApks":schema::<apk_domain::bundles::BuiltApks>(),
                "BuildApksRequest":schema::<apk_domain::bundles::BuildApksRequest>(),
                "ExtractedApk":schema::<apk_domain::packages::ExtractedApk>(),
                "DecodedPackage":schema::<apk_domain::reverse::DecodedPackage>(),
                "SdkScan":schema::<apk_domain::reverse::SdkScan>(),
                "PluginArtifactResult":schema::<apk_domain::PluginArtifactResult>(), "InputRequest":schema::<apk_domain::device_input::InputRequest>(), "InputReceipt":schema::<apk_domain::device_input::InputReceipt>(), "PerformanceSession":schema::<apk_domain::performance::PerformanceSession>(), "PerformancePage":schema::<apk_domain::performance::PerformancePage>(), "PerformanceSessions":schema::<apk_domain::performance::PerformanceSessions>()
            }
        },
        "paths":{
            "/api/v1/artifacts":{"post":upload},
            "/api/v1/artifacts/{id}":{"parameters":[id.clone()],"get":endpoint("读取产物元数据","200",schema::<apk_domain::artifacts::Artifact>())},
            "/api/v1/artifacts/{id}/content":{"parameters":[id.clone()],"get":download},
            "/api/v1/artifacts/{id}/entries":{"parameters":[id.clone()],"get":entries},
            "/api/v1/health":{"get":endpoint("服务状态", "200", json!({"type":"object","required":["status","api_version"],"properties":{"status":{"const":"ok"},"api_version":{"const":1}}}))},
            "/api/v1/operations":{"get":endpoint("内置与插件操作贡献", "200", schema::<Vec<apk_domain::Operation>>())},
            "/api/v1/jobs":{"get":jobs,"post":submit},
            "/api/v1/jobs/{id}":{"parameters":[id.clone()],"get":endpoint("任务详情", "200", schema::<apk_domain::Job>())},
            "/api/v1/jobs/{id}/cancel":{"parameters":[id.clone()],"post":endpoint("取消任务", "200", schema::<apk_domain::Job>())},
            "/api/v1/jobs/{id}/events":{"parameters":[id],"get":events},
            "/api/v1/openapi.json":{"get":endpoint("公开接口模式", "200", json!({"type":"object"}))}
        }
    });
    document["components"]["schemas"]["ErrorResponse"] =
        schema::<crate::responses::ErrorResponse>();
    document["components"]["schemas"]["JobResponse"] =
        schema::<crate::responses::Success<apk_domain::Job>>();
    let old_paths = document["paths"]
        .as_object()
        .expect("模式路径为对象")
        .clone();
    for (path, mut item) in old_paths {
        let new_path = path.replacen("/api/v1/", "/api/v2/", 1);
        for (method, operation) in item.as_object_mut().expect("路径描述为对象") {
            if !["get", "post"].contains(&method.as_str()) {
                continue;
            }
            if let Some(responses) = operation["responses"].as_object_mut() {
                for (status, response) in responses {
                    response["headers"]["x-deviceforge-log-id"] = json!({"description":"宿主生成的关联日志 ID","schema":{"type":"string","format":"uuid"}});
                    if status.starts_with('2')
                        && (path.ends_with("/content") || path.ends_with("/openapi.json"))
                    {
                        continue;
                    }
                    let Some(output) = response["content"]["application/json"].get_mut("schema")
                    else {
                        continue;
                    };
                    let mut data = output.take();
                    let field = if status.starts_with('2') {
                        "data"
                    } else {
                        "error"
                    };
                    if path.ends_with("/health") && field == "data" {
                        data["properties"]["api_version"]["const"] = json!(2);
                    }
                    *output = json!({"type":"object","required":["log_id",field],"properties":{"log_id":{"type":"string","format":"uuid"},field:data}});
                }
            }
        }
        document["paths"][new_path] = item;
    }
    let stats = schema::<deviceforge_observability::LogStats>();
    let mut diagnostics = endpoint("读取日志队列与写入统计", "200", stats);
    let mut shutdown = endpoint(
        "停止宿主并收敛任务与会话",
        "200",
        json!({"type":"object","required":["stopping"],"properties":{"stopping":{"type":"boolean"}}}),
    );
    for endpoint in [&mut diagnostics, &mut shutdown] {
        for (status, response) in endpoint["responses"]
            .as_object_mut()
            .expect("响应集合为对象")
        {
            let data = response["content"]["application/json"]["schema"].take();
            let field = if status.starts_with('2') {
                "data"
            } else {
                "error"
            };
            response["content"]["application/json"]["schema"] = json!({"type":"object","required":["log_id",field],"properties":{"log_id":{"type":"string","format":"uuid"},field:data}});
        }
    }
    document["paths"]["/api/v2/diagnostics/logging"] = json!({"get":diagnostics});
    document["paths"]["/api/v2/system/shutdown"] = json!({"post":shutdown});
    document["paths"]["/api/v2/plugins"] = json!({"get":v2_endpoint(endpoint("列出运行中服务器插件与代际", "200", schema::<Vec<apk_domain::plugins::PluginInfo>>()))});
    for action in ["load", "unload"] {
        let summary = if action == "load" {
            "加载已部署的服务器插件"
        } else {
            "撤销插件并取消及等待在途任务"
        };
        let mut operation = endpoint(summary, "200", schema::<apk_domain::plugins::PluginInfo>());
        operation["responses"]["503"] = response("插件管理服务未配置", schema::<crate::Failure>());
        operation["responses"]["504"] = response(
            "排空超过期限，插件保留 draining 状态",
            schema::<crate::Failure>(),
        );
        document["paths"][format!("/api/v2/plugins/{{id}}/{action}")] = json!({
            "parameters":[{"name":"id","in":"path","required":true,"schema":{"type":"string","minLength":1,"maxLength":99,"pattern":"^[a-z0-9][a-z0-9._-]*$"}}],
            "post":v2_endpoint(operation)
        });
    }
    plugin_package_paths(&mut document);
    device_paths(&mut document);
    document
}

fn device_paths(document:&mut Value) {
    use apk_domain::devices::*;
    document["paths"]["/api/v2/device-providers"]=json!({"get":v2_endpoint(endpoint("列出当前设备提供者","200",schema::<Vec<DeviceProviderInfo>>()))});
    document["paths"]["/api/v2/devices"]=json!({"get":v2_endpoint(endpoint("列出当前代明确观测目录","200",schema::<Vec<DeviceDirectory>>()))});
    let mut refresh=endpoint("显式刷新设备，失败撤销当前观测","200",schema::<DeviceDirectory>());
    refresh["parameters"]=json!([{"name":"id","in":"path","required":true,"schema":{"type":"string","maxLength":99}}]);
    refresh["requestBody"]=json!({"required":true,"content":{"application/json":{"schema":schema::<crate::device_routes::RefreshRequest>()}}});
    refresh["responses"]["502"]=response("提供者发现消息无效",schema::<crate::Failure>());
    refresh["responses"]["504"]=response("刷新等待超时",schema::<crate::Failure>());
    document["paths"]["/api/v2/device-providers/{id}/refresh"]=json!({"post":v2_endpoint(refresh)});
    let mut invoke=endpoint("按能力精确版本提交共享任务","202",schema::<apk_domain::Job>());
    invoke["requestBody"]=json!({"required":true,"content":{"application/json":{"schema":schema::<DeviceActionRequest>()}}});
    document["paths"]["/api/v2/device-actions"]=json!({"post":v2_endpoint(invoke)});
    for (name,value) in [("DeviceProviderInfo",schema::<DeviceProviderInfo>()),("DeviceDirectory",schema::<DeviceDirectory>()),("DeviceActionRequest",schema::<DeviceActionRequest>()),("ProviderInput",schema::<ProviderInput>())] {
        document["components"]["schemas"][name]=value;
    }
}

fn plugin_package_paths(document: &mut Value) {
    use apk_domain::plugin_packages::*;
    let kind = json!({"name":"kind","in":"path","required":true,"schema":schema::<PackageKind>()});
    let id =
        json!({"name":"id","in":"path","required":true,"schema":{"type":"string","maxLength":99}});
    let mut list = v2_endpoint(endpoint(
        "列出已安装便携插件包",
        "200",
        schema::<Vec<PackageInfo>>(),
    ));
    list["parameters"] = json!([kind.clone()]);
    let mut install = v2_endpoint(endpoint(
        "上传自包含 ZIP/npm TGZ，验证后原子安装，不执行脚本或自动加载",
        "201",
        schema::<PackageInfo>(),
    ));
    install["parameters"] = json!([kind.clone(),{"name":"format","in":"query","required":true,"schema":schema::<PackageFormat>()}]);
    install["requestBody"] = json!({"required":true,"content":{"application/zip":{"schema":{"type":"string","format":"binary"}},"application/gzip":{"schema":{"type":"string","format":"binary"}}}});
    install["responses"]["413"] = response(
        "包上传或结构超过上限",
        schema::<crate::responses::ErrorResponse>(),
    );
    install["responses"]["415"] = response(
        "归档媒体类型与 format 不匹配",
        schema::<crate::responses::ErrorResponse>(),
    );
    document["paths"]["/api/v2/plugin-packages/{kind}"] = json!({"get":list,"post":install});
    let mut remove = v2_endpoint(endpoint(
        "删除已卸载部署，清理未确认时拒绝",
        "200",
        schema::<PackageInfo>(),
    ));
    remove["parameters"] = json!([kind, id.clone()]);
    document["paths"]["/api/v2/plugin-packages/{kind}/{id}"] = json!({"delete":remove});
    for path in [
        "/api/v2/browser-plugins/{id}/assets/{path}",
        "/api/v2/browser-plugins/{id}/runs/{run_id}/assets/{path}",
    ] {
        let mut parameters = vec![
            id.clone(),
            json!({"name":"path","in":"path","required":true,"schema":{"type":"string","maxLength":512},"description":"包内相对资源路径"}),
        ];
        if path.contains("/runs/") {
            parameters.push(json!({"name":"run_id","in":"path","required":true,"schema":{"type":"string","minLength":1,"maxLength":100,"pattern":"^[A-Za-z0-9_-]+$"},"description":"客户端启用代次，仅改变模块 URL，不保存会话"}));
        }
        let operation = json!({"summary":"读取公开可信浏览器代码和相对资源，不含 secret","security":[],"parameters":parameters,"responses":{
            "200":{"description":"原字节内容；JSON 静态资源也不包装","headers":{"x-deviceforge-log-id":{"schema":{"type":"string","format":"uuid"}}},"content":{"text/javascript":{"schema":{"type":"string","format":"binary"}},"application/json":{"schema":{"type":"string","format":"binary"}},"application/octet-stream":{"schema":{"type":"string","format":"binary"}}}},
            "400":response("资源路径无效",schema::<crate::responses::ErrorResponse>()),"404":response("包或资源不存在",schema::<crate::responses::ErrorResponse>()),"409":response("资源读取工作池已满",schema::<crate::responses::ErrorResponse>())
        }});
        document["paths"][path] = json!({"get":operation.clone(),"head":operation});
    }
    document["components"]["schemas"]["PluginPackageInfo"] = schema::<PackageInfo>();
    document["components"]["schemas"]["PluginPackageKind"] = schema::<PackageKind>();
    document["components"]["schemas"]["PluginPackageFormat"] = schema::<PackageFormat>();
}

fn v2_endpoint(mut operation: Value) -> Value {
    for (status, response) in operation["responses"]
        .as_object_mut()
        .expect("响应集合为对象")
    {
        let data = response["content"]["application/json"]["schema"].take();
        let field = if status.starts_with('2') {
            "data"
        } else {
            "error"
        };
        response["content"]["application/json"]["schema"] = json!({"type":"object","required":["log_id",field],"properties":{"log_id":{"type":"string","format":"uuid"},field:data}});
        response["headers"]["x-deviceforge-log-id"] =
            json!({"schema":{"type":"string","format":"uuid"}});
    }
    operation
}
