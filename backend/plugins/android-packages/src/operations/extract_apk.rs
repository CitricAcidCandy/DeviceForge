use super::{common, input::ExtractInput};
use crate::{Error, Result, session::Session};
use deviceforge_plugin_runtime::Output;
use serde_json::json;

pub(super) async fn run(session: &Session, input: ExtractInput) -> Result<Output> {
    let path = session.input.path.clone();
    let destination = session.root.join("extracted.apk");
    let entry = input.entry.clone();
    session
        .work(move |control| {
            let mut archive = common::archive(&path, control)?;
            let selected = archive.select_exact(&entry, control)?;
            let mut output = common::create(&destination, control)?;
            selected.copy_to(&mut output, common::LIMIT, control)?;
            control.check()?;
            output
                .sync_all()
                .map_err(|_| Error::Io("同步提取产物失败"))?;
            control.check()?;
            Ok(())
        })
        .await?;
    let artifact = session.publish("extracted.apk").await?;
    Ok(Output {
        value: json!({"entry":input.entry}),
        artifacts: vec![artifact],
    })
}
