//! 临时诊断脚本：用与 src-tauri/src/ai.rs 完全相同的参数链路调用 genai，
//! 复现首页聊天框的报错。用后即删。
//!
//! 运行：$env:APRILIO_PROBE_KEY="sk-..."; cargo run --example ai_probe --manifest-path src-tauri/Cargo.toml

use genai::chat::{ChatMessage, ChatOptions, ChatRequest};
use genai::resolver::{AuthData, AuthResolver, Endpoint, ServiceTargetResolver};
use genai::ServiceTarget;
use genai::Client;

fn build_client(api_key: Option<&str>, base_url: Option<&str>, http1_only: bool) -> Client {
  let mut builder = Client::builder();

  if http1_only {
    let rc = reqwest::Client::builder()
      .http1_only()
      .build()
      .expect("构建 reqwest 失败");
    builder = builder.with_reqwest(rc);
  } else if std::env::var("APRILIO_PROBE_NATIVE_TLS").map(|v| v == "1").unwrap_or(false) {
    let rc = reqwest::Client::builder()
      .use_native_tls()
      .build()
      .expect("构建 reqwest 失败");
    builder = builder.with_reqwest(rc);
  }

  if let Some(key) = api_key.map(str::trim).filter(|k| !k.is_empty()).map(String::from) {
    builder = builder.with_auth_resolver(AuthResolver::from_resolver_fn(
      move |_model_iden| Ok(Some(AuthData::from_single(key))),
    ));
  }

  if let Some(url) = base_url.map(str::trim).filter(|u| !u.is_empty()).map(String::from) {
    builder = builder.with_service_target_resolver(ServiceTargetResolver::from_resolver_fn(
      move |mut target: ServiceTarget| {
        target.endpoint = Endpoint::from_owned(url);
        Ok(target)
      },
    ));
  }

  builder.build()
}

fn main() {
  let key = std::env::var("APRILIO_PROBE_KEY").expect("缺少 APRILIO_PROBE_KEY 环境变量");
  let base_url = std::env::var("APRILIO_PROBE_BASE_URL").unwrap_or_else(|_| "https://yuzapi.fun/v1".into());
  let model = std::env::var("APRILIO_PROBE_MODEL").unwrap_or_else(|_| "openai::gpt-5.6-luna".into());

  let http1 = std::env::var("APRILIO_PROBE_HTTP1").map(|v| v == "1").unwrap_or(false);
  println!("== 用 base_url={base_url} model={model} http1_only={http1} 复现 ==");

  let client = build_client(Some(&key), Some(&base_url), http1);
  let req = ChatRequest::new(vec![ChatMessage::user("你好")]);
  let opts = ChatOptions::default().with_temperature(0.7);

  tauri::async_runtime::block_on(async {
    match client.exec_chat(&model, req, Some(&opts)).await {
      Ok(res) => println!("成功: {}", res.into_first_text().unwrap_or_default()),
      Err(err) => {
        println!("失败，错误类型链：");
        let mut source: Option<&dyn std::error::Error> = Some(&err);
        while let Some(e) = source {
          println!("  - {e}");
          source = e.source();
        }
        println!("Display: {err:#}");
        println!("Debug: {err:?}");
      }
    }
  });
}
