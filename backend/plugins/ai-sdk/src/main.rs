fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments
        .first()
        .is_some_and(|argument| argument == "--sdk-supervisor")
    {
        if let Err(error) = deviceforge_ai_sdk_plugin::supervision::serve() {
            eprintln!("SDK监督失败: {error}");
            std::process::exit(1);
        }
        return;
    }
    if arguments
        .first()
        .is_some_and(|argument| argument == "--sdk-sentinel")
    {
        if deviceforge_ai_sdk_plugin::supervision::sentinel().is_err() {
            std::process::exit(1);
        }
        return;
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => std::process::exit(1),
    };
    let code = runtime.block_on(run(arguments));
    drop(runtime);
    if code != 0 {
        std::process::exit(code);
    }
}

async fn run(arguments: Vec<String>) -> i32 {
    if arguments.first().is_some_and(|argument| argument == "exec") {
        return deviceforge_ai_sdk_plugin::bridge::proxy::serve(arguments)
            .await
            .unwrap_or(1);
    }
    let deployment = match deviceforge_ai_sdk_plugin::deployment::Deployment::current(&arguments) {
        Ok(deployment) => deployment,
        Err(_) => return 1,
    };
    if deviceforge_ai_sdk_plugin::entry::serve_io_with_deployment(
        tokio::io::stdin(),
        tokio::io::stdout(),
        deployment,
    )
    .await
    .is_err()
    {
        return 1;
    }
    0
}
