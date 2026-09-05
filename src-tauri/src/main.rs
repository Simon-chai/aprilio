// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  let args: Vec<String> = std::env::args().collect();
  // `aprilio mcp serve` —— 以 MCP server 模式运行（stdio，不开端口），
  // 供外部 Agent 客户端（Goose / Claude Desktop 等）接入，见 src-tauri/src/mcp_server.rs。
  // 不会启动 GUI；进程占用 stdio 直到客户端断开。
  if args.get(1).map(String::as_str) == Some("mcp") && args.get(2).map(String::as_str) == Some("serve") {
    std::process::exit(app_lib::mcp_server::run_blocking());
  }
  app_lib::run();
}
