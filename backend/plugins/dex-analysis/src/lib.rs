mod dex;
mod error;
mod findings;
mod input;
mod models;
mod source;
mod worker;

use apk_plugin_sdk::Request;
use deviceforge_plugin_runtime::{Execution, InvocationContext};
pub(crate) use error::{Error, Result};
use serde_json::json;

pub async fn execute(request: Request, context: InvocationContext) -> Execution {
    if let Err(error) = context.check() {
        return Execution::complete(Err(error.to_string()));
    }
    let input = match input::parse(&request) {
        Ok(input) => input,
        Err(error) => return Execution::complete(Err(error.to_string())),
    };
    worker::run(context, move |control| {
        let bytes = source::read(&input.artifact, control)?;
        let analysis = dex::parse(&bytes, control)?;
        let findings = match input.rules {
            Some(rules) => Some(findings::scan(&analysis.classes, rules, control)?),
            None => None,
        };
        let mut value = json!({
            "artifact_id": input.artifact.artifact_id,
            "version": analysis.version,
            "file_size": analysis.file_size,
            "counts": analysis.counts,
            "integrity": {"artifact_sha256":true,"dex_sha1":true,"dex_adler32":true},
        });
        if let Some(findings) = findings {
            value["findings"] =
                serde_json::to_value(findings).map_err(|_| Error::Invalid("SDK结果序列化失败"))?;
        }
        control.check()?;
        Ok(value.into())
    })
    .await
}

#[cfg(test)]
mod tests;
