//! 临时诊断脚本 2：reqwest 直连 yuzapi，矩阵测试找出 curl 与 reqwest 的关键差异。
//! 用后即删。

use reqwest::Client;

const URL: &str = "https://yuzapi.fun/v1/chat/completions";
const KEY: &str = "sk-67c4f886a1e773dd5c826348d91c196abbc6d994e6e9281077363f439c232a38";
const BODY: &str = r#"{"model":"gpt-5.6-luna","messages":[{"role":"user","content":"hi"}]}"#;

async fn probe(name: &str, tls_native: bool, h1_only: bool, gzip: bool, ua: Option<&str>) {
  let mut b = Client::builder();
  b = if tls_native { b.use_native_tls() } else { b.use_rustls_tls() };
  if h1_only {
    b = b.http1_only();
  }
  b = b.gzip(gzip);
  if let Some(ua) = ua {
    b = b.user_agent(ua);
  }
  let client = b.build().expect("构建失败");

  let mut req = client
    .post(URL)
    .header("Authorization", format!("Bearer {KEY}"))
    .header("Content-Type", "application/json")
    .body(BODY.to_string());
  if !gzip {
    req = req.header("Accept-Encoding", "identity");
  }

  match req.send().await {
    Ok(res) => {
      let status = res.status();
      let ct = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("?")
        .to_string();
      let is_json = ct.starts_with("application/json");
      println!("{name}: status={status} ct={ct} => {}", if is_json { "JSON(成功)" } else { "HTML(被风控)" });
    }
    Err(e) => println!("{name}: 请求错误 {e}"),
  }
}

#[tokio::main]
async fn main() {
  probe("A rustls +h2 +gzip(=genai默认)", false, false, true, None).await;
  probe("B native +h1 -gzip(最接近curl)", true, true, false, None).await;
  probe("C native +h1 -gzip +UA-curl", true, true, false, Some("curl/8.9.1")).await;
  probe("D native +h2 -gzip", true, false, false, None).await;
  probe("E native +h1 +gzip", true, true, true, None).await;
  probe("F rustls +h1 -gzip", false, true, false, None).await;
}
