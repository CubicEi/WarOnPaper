use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct ManagerChild(Mutex<Option<Child>>);

#[derive(Clone, Copy, Debug)]
enum LaunchMode {
  Host,
  Join,
}

struct LaunchConfig {
  mode: LaunchMode,
  join_host: Option<String>,
  port: u16,
}

fn parse_launch_config() -> LaunchConfig {
  let args: Vec<String> = std::env::args().collect();
  let mut mode = LaunchMode::Host;
  let mut join_host: Option<String> = None;
  let mut i = 1usize;
  while i < args.len() {
    match args[i].as_str() {
      "--host" => {
        mode = LaunchMode::Host;
        i += 1;
      }
      "--join" => {
        mode = LaunchMode::Join;
        if i + 1 < args.len() {
          join_host = Some(args[i + 1].clone());
          i += 2;
        } else {
          i += 1;
        }
      }
      _ => i += 1,
    }
  }
  let port = std::env::var("PORT")
    .ok()
    .and_then(|p| p.parse().ok())
    .unwrap_or(4358);
  LaunchConfig {
    mode,
    join_host,
    port,
  }
}

fn manager_data_dir() -> PathBuf {
  if let Ok(dir) = std::env::var("WOP_MANAGER_DATA") {
    if !dir.trim().is_empty() {
      return PathBuf::from(dir);
    }
  }
  let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
  PathBuf::from(appdata).join("WarOnPaper").join("data")
}

fn runtime_root(app: &AppHandle) -> PathBuf {
  if let Ok(res) = app.path().resource_dir() {
    let bundled = res.join("runtime");
    if bundled.join("manager").join("dist").join("index.js").exists() {
      return bundled;
    }
  }
  PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .join("..")
    .join("runtime")
}

fn node_executable(runtime: &Path) -> PathBuf {
  let win = runtime.join("node").join("node.exe");
  if win.exists() {
    return win;
  }
  let unix = runtime.join("node").join("node");
  if unix.exists() {
    return unix;
  }
  PathBuf::from("node")
}

fn normalize_join_target(raw: &str, default_port: u16) -> String {
  let trimmed = raw.trim().trim_end_matches('/');
  if trimmed.is_empty() {
    return format!("127.0.0.1:{}", default_port);
  }
  if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
    return trimmed.to_string();
  }
  if trimmed.contains(':') {
    return format!("http://{}/", trimmed);
  }
  format!("http://{}:{}/", trimmed, default_port)
}

fn health_ok(port: u16) -> bool {
  let addr = format!("127.0.0.1:{}", port);
  let mut stream = match TcpStream::connect_timeout(
    &addr.parse().expect("addr"),
    Duration::from_secs(1),
  ) {
    Ok(s) => s,
    Err(_) => return false,
  };
  let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
  let req = format!(
    "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
  );
  if stream.write_all(req.as_bytes()).is_err() {
    return false;
  }
  let mut buf = [0u8; 512];
  let n = stream.read(&mut buf).unwrap_or(0);
  let text = String::from_utf8_lossy(&buf[..n]);
  text.contains("200") && text.contains("ok")
}

fn wait_for_health(port: u16) -> Result<(), String> {
  for _ in 0..120 {
    if health_ok(port) {
      return Ok(());
    }
    std::thread::sleep(Duration::from_millis(500));
  }
  Err(format!(
    "manager did not become healthy on http://127.0.0.1:{}/health",
    port
  ))
}

fn spawn_manager(
  _app: &AppHandle,
  runtime: &Path,
  port: u16,
) -> Result<Child, String> {
  let node = node_executable(runtime);
  let entry = runtime.join("manager").join("dist").join("index.js");
  let cwd = runtime.join("manager");
  if !entry.exists() {
    return Err(format!(
      "manager entry missing at {} — run npm run stage in desktop/",
      entry.display()
    ));
  }

  let data_dir = manager_data_dir();
  std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

  let mut cmd = Command::new(&node);
  cmd.arg(&entry)
    .current_dir(&cwd)
    .env("PORT", port.to_string())
    .env("WOP_BIND", "0.0.0.0")
    .env("WOP_MANAGER_DATA", &data_dir);

  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }

  cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

  let child = cmd.spawn().map_err(|e| {
    format!(
      "failed to spawn manager ({} {}): {e}",
      node.display(),
      entry.display()
    )
  })?;

  log::info!(
    "spawned manager pid={} port={} data={}",
    child.id(),
    port,
    data_dir.display()
  );
  Ok(child)
}

fn kill_manager_child(state: &ManagerChild) {
  let mut guard = state.0.lock().expect("manager lock");
  if let Some(mut child) = guard.take() {
    let _ = child.kill();
    let _ = child.wait();
    log::info!("manager process stopped");
  }
}

fn open_main_window(app: &AppHandle, url: &str) -> Result<(), String> {
  let parsed: url::Url = url
    .parse()
    .map_err(|e: url::ParseError| e.to_string())?;
  let webview_url = WebviewUrl::External(parsed);

  if let Some(win) = app.get_webview_window("main") {
    let _ = win.close();
  }

  WebviewWindowBuilder::new(app, "main", webview_url)
    .title("纸上谈兵")
    .inner_size(1280.0, 800.0)
    .resizable(true)
    .build()
    .map_err(|e| e.to_string())?;
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let launch = parse_launch_config();

  let builder = tauri::Builder::default()
    .manage(ManagerChild(Mutex::new(None)))
    .setup(move |app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let url = match launch.mode {
        LaunchMode::Host => {
          let runtime = runtime_root(app.handle());
          let child = spawn_manager(app.handle(), &runtime, launch.port)?;
          app.state::<ManagerChild>()
            .0
            .lock()
            .expect("manager lock")
            .replace(child);
          wait_for_health(launch.port)?;
          format!("http://127.0.0.1:{}/", launch.port)
        }
        LaunchMode::Join => {
          let target = launch
            .join_host
            .as_deref()
            .unwrap_or("127.0.0.1");
          normalize_join_target(target, launch.port)
        }
      };

      open_main_window(app.handle(), &url)?;
      Ok(())
    });

  builder
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if matches!(event, RunEvent::Exit) {
        if let Some(state) = app.try_state::<ManagerChild>() {
          kill_manager_child(state.inner());
        }
      }
    });
}
