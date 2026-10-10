use apk_domain::{
    Error, Executor,
    artifacts::{Artifact, ArtifactStore},
};
use apk_infrastructure::{artifacts::FileArtifacts, plugins::ProcessPlugin};
use apk_plugin_sdk::Manifest;
use futures_util::{TryStreamExt, stream};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio_util::sync::CancellationToken;
fn node() -> std::path::PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|root| root.join(name))
        .find(|path| path.is_file())
        .expect("真实插件回归需要 Node")
}
#[tokio::test]
async fn real_process_discovery_protocols_one_two_three_and_bad_result() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("provider.cjs");
    // 本夹具每次启动一个真实进程，仅发协议帧，不创建外部资源。
    std::fs::write(&script,r#"const rl=require('node:readline').createInterface({input:process.stdin});
rl.once('line',line=>{
 const q=JSON.parse(line);
 const result=q.input.bad ? [{id:'same',state:'online',capabilities:[{id:'undeclared',version:1,available:true}]}] : [{id:'same',state:'online',capabilities:[]}];
 const response={protocol_version:q.protocol_version,request_id:q.request_id,result};
 process.stdout.write(JSON.stringify(q.protocol_version===3 ? {response,cleanup:'complete'} : response)+'\n');
 rl.close();
});
"#).unwrap();
    for version in [1, 2, 3] {
        let manifest:Manifest=serde_json::from_value(json!({"id":"test","version":"1","protocol_version":version,"executable":node(),"args":[script],"operations":[{"name":"discover","title":"发现","input_schema":{"type":"object"}}],"devices":{"api_version":1,"platform":"第三方测试","discover_operation":"discover","capabilities":[]}})).unwrap();
        let plugin = ProcessPlugin::new(manifest).unwrap();
        assert_eq!(
            plugin.device_provider().unwrap().discover_operation,
            "plugin.test.discover"
        );
        let output = plugin
            .execute("plugin.test.discover", json!({}), CancellationToken::new())
            .await
            .unwrap();
        if version == 1 {
            assert!(output.is_array());
        } else {
            assert!(output["result"].is_array());
            assert_eq!(output["artifacts"], json!([]));
        }
        assert!(matches!(
            plugin
                .execute(
                    "plugin.test.discover",
                    json!({"bad":true}),
                    CancellationToken::new()
                )
                .await,
            Err(Error::Dependency(_))
        ));
        assert!(!plugin.has_unresolved_resources());
    }
}

// 每次任务使用独立 Node 进程；仅处理模拟设备和宿主提供的产物副本。
const NESTED_PROVIDER: &str = r#"
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const lines=require('node:readline').createInterface({input:process.stdin});
let request, hold, responded=false;
function reply(response) {
 responded=true;
 const frame=request.protocol_version===3 ? {response,cleanup:'complete'} : response;
 process.stdout.write(JSON.stringify(frame)+'\n',()=>{if(request.protocol_version===2) process.exit(0);});
}
lines.on('line',line=>{
 const frame=JSON.parse(line);
 if(request) {
  if(frame.protocol_version!==3 || frame.request_id!==request.request_id || frame.command!=='cancel') process.exit(2);
  clearInterval(hold);
  fs.writeFileSync(process.argv[2]+'.cleaned','cancel');
  reply({protocol_version:3,request_id:request.request_id,error:'模拟取消已清理'});
  return;
 }
 request=frame;
 if(request.operation==='discover') {
  reply({protocol_version:request.protocol_version,request_id:request.request_id,
   result:[{id:'same',state:'online',capabilities:[{id:'device.copy',version:1,available:true}]}]});
  return;
 }
 const input=request.artifacts.inputs[0], bytes=fs.readFileSync(input.path);
 const digest=crypto.createHash('sha256').update(bytes).digest('hex');
 if(request.input.device_id!=='same' || input.field!=='/input/artifact_id'
  || input.artifact_id!==request.input.input.artifact_id || input.size!==bytes.length || input.sha256!==digest) process.exit(3);
 fs.writeFileSync(process.argv[2],JSON.stringify({work:process.cwd(),path:input.path,
  field:input.field,id:input.artifact_id,input_id:request.input.input.artifact_id,sha256:digest}));
 if(request.input.input.wait) {hold=setInterval(()=>{},1000);return;}
 fs.copyFileSync(input.path,path.join(request.artifacts.output_directory,'copy.png'));
 reply({protocol_version:request.protocol_version,request_id:request.request_id,
  result:{device_id:request.input.device_id,artifact_id:request.input.input.artifact_id},outputs:[{filename:'copy.png'}]});
});
// 协议 3 必须在响应后收到宿主 stdin EOF 才零退出，取消也覆盖该顺序。
lines.on('close',()=>{if(responded) process.exit(0);});
"#;

async fn nested_provider(
    version: u32,
) -> (
    tempfile::TempDir,
    Arc<FileArtifacts>,
    Artifact,
    Arc<ProcessPlugin>,
    PathBuf,
) {
    let directory = tempfile::tempdir().unwrap();
    let script = directory.path().join("nested.cjs");
    let marker = directory.path().join("paths.json");
    tokio::fs::write(&script, NESTED_PROVIDER).await.unwrap();
    let store = Arc::new(
        FileArtifacts::open(&directory.path().join("store"))
            .await
            .unwrap(),
    );
    let bytes = include_bytes!("../src/device_artifacts/fixtures/pixel.png").to_vec();
    let artifact = store
        .put(
            "source.png".into(),
            Box::pin(stream::once(async move { Ok(bytes.into()) })),
        )
        .await
        .unwrap();
    let manifest: Manifest = serde_json::from_value(json!({
        "id":"nested","version":"1","protocol_version":version,"executable":node(),"args":[script,marker],
        "artifacts":{"input_pointers":["/input/artifact_id"],"outputs":true},
        "operations":[
            {"name":"discover","title":"发现模拟设备","input_schema":{"type":"object","additionalProperties":false}},
            {"name":"copy","title":"模拟设备副本","input_schema":{"type":"object","properties":{
                "device_id":{"type":"string"},"input":{"type":"object","properties":{"artifact_id":{"type":"string"},"wait":{"type":"boolean"}},"required":["artifact_id"],"additionalProperties":false}
            },"required":["device_id","input"],"additionalProperties":false}}
        ],
        "devices":{"api_version":1,"platform":"synthetic_demo","discover_operation":"discover","capabilities":[
            {"id":"device.copy","version":1,"operation":"copy","scope":"device","access":"write"}
        ]}
    })).unwrap();
    let plugin = Arc::new(ProcessPlugin::with_artifacts(manifest, store.clone()).unwrap());
    (directory, store, artifact, plugin, marker)
}

async fn recorded_paths(marker: &Path) -> serde_json::Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(paths) = tokio::fs::read(marker)
                .await
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            {
                break paths;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("真实插件应先完成输入副本校验")
}

async fn assert_call_directories_removed(paths: &serde_json::Value) {
    let work = PathBuf::from(paths["work"].as_str().unwrap());
    let copy = PathBuf::from(paths["path"].as_str().unwrap());
    let input_directory = copy.parent().unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while work.exists() || input_directory.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("进程退出或 Future 丢弃后应清理本次副本与工作目录");
}

#[tokio::test]
async fn real_device_process_copies_nested_inputs_and_publishes_outputs_in_protocols_two_and_three()
{
    for version in [2, 3] {
        let (_directory, store, source, plugin, marker) = nested_provider(version).await;
        let definition = plugin.device_provider().unwrap();
        assert_eq!(definition.capabilities[0].operation, "plugin.nested.copy");
        let discovered = plugin
            .execute(
                "plugin.nested.discover",
                json!({}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(discovered["result"][0]["id"], "same");
        assert_eq!(discovered["artifacts"], json!([]));
        let value = plugin
            .execute(
                "plugin.nested.copy",
                json!({"device_id":"same","input":{"artifact_id":source.id}}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(value["result"]["artifact_id"], source.id);
        let artifacts: Vec<Artifact> = serde_json::from_value(value["artifacts"].clone()).unwrap();
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].sha256, source.sha256);
        assert_eq!(artifacts[0].size, source.size);
        let (_, output) = store.download(&artifacts[0].id).await.unwrap();
        let bytes = output
            .try_fold(Vec::new(), |mut bytes, chunk| async move {
                bytes.extend_from_slice(&chunk);
                Ok(bytes)
            })
            .await
            .unwrap();
        assert_eq!(
            bytes,
            include_bytes!("../src/device_artifacts/fixtures/pixel.png")
        );
        let paths = recorded_paths(&marker).await;
        assert_eq!(paths["field"], "/input/artifact_id");
        assert_eq!(paths["id"], source.id);
        assert_eq!(paths["input_id"], source.id);
        assert_eq!(paths["sha256"], source.sha256);
        assert_call_directories_removed(&paths).await;
        assert!(!plugin.has_unresolved_resources());
    }
}

#[tokio::test]
async fn real_device_process_cancel_cleans_nested_copies_and_confirms_v3_control() {
    for version in [2, 3] {
        let (_directory, store, source, plugin, marker) = nested_provider(version).await;
        let cancel = CancellationToken::new();
        let task = {
            let plugin = plugin.clone();
            let cancel = cancel.clone();
            let input = json!({"device_id":"same","input":{"artifact_id":source.id,"wait":true}});
            tokio::spawn(async move { plugin.execute("plugin.nested.copy", input, cancel).await })
        };
        let paths = recorded_paths(&marker).await;
        assert!(Path::new(paths["path"].as_str().unwrap()).is_file());
        cancel.cancel();
        let result = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(result, Err(Error::Cancelled)));
        if version == 3 {
            assert_eq!(
                tokio::fs::read(marker.with_file_name("paths.json.cleaned"))
                    .await
                    .unwrap(),
                b"cancel"
            );
        }
        assert_call_directories_removed(&paths).await;
        assert!(store.get(&source.id).await.is_ok());
        assert!(!plugin.has_unresolved_resources());
    }
}

#[tokio::test]
async fn dropping_real_device_process_future_cleans_nested_copies_but_retains_unconfirmed_resources()
 {
    for version in [2, 3] {
        let (_directory, store, source, plugin, marker) = nested_provider(version).await;
        let task = {
            let plugin = plugin.clone();
            let input = json!({"device_id":"same","input":{"artifact_id":source.id,"wait":true}});
            tokio::spawn(async move {
                plugin
                    .execute("plugin.nested.copy", input, CancellationToken::new())
                    .await
            })
        };
        let paths = recorded_paths(&marker).await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_call_directories_removed(&paths).await;
        assert!(store.get(&source.id).await.is_ok());
        assert!(plugin.has_unresolved_resources());
        assert!(!marker.with_file_name("paths.json.cleaned").exists());
    }
}
