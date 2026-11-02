use serde_json::{json, Value};
use std::{env, io::{BufRead, BufReader, Write}, path::PathBuf,
          process::{Child, ChildStdin, Command, Stdio}, sync::Mutex, thread};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::{Emitter, Manager};

struct WorkerProcess { child: Child, stdin: ChildStdin }
impl Drop for WorkerProcess {
    fn drop(&mut self) { let _ = self.child.kill(); }
}
#[derive(Default)]
struct WorkerState { process: Mutex<Option<WorkerProcess>> }

fn spawn_worker(app: &tauri::AppHandle) -> Result<WorkerProcess, String> {
    let mut command;
    if cfg!(debug_assertions) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent().unwrap().parent().unwrap().to_path_buf();
        command = Command::new(env::var("PYTHON").unwrap_or_else(|_| "python".to_string()));
        command.args(["-m", "short_video_moderation.worker"]).current_dir(root);
    } else {
        let executable = app.path().resource_dir().map_err(|e| e.to_string())?
            .join("worker").join("short-video-moderation-worker.exe");
        if !executable.is_file() { return Err("安装包缺少审核引擎，请重新构建安装包。".into()); }
        command = Command::new(executable);
    }
    command.env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|e| format!("无法启动 Python 审核引擎：{e}"))?;
    let stdin = child.stdin.take().ok_or("无法打开引擎输入流")?;
    let stdout = child.stdout.take().ok_or("无法打开引擎输出流")?;
    let stderr = child.stderr.take().ok_or("无法打开引擎错误流")?;
    // Drain diagnostics without exposing raw API bodies or credentials to the UI.
    thread::spawn(move || { for _ in BufReader::new(stderr).lines() {} });
    let handle = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(payload) = serde_json::from_str::<Value>(&line) {
                let _ = handle.emit("worker-event", payload);
            }
        }
        let _ = handle.emit("worker-event", json!({"type": "worker.exited", "error": "审核引擎已退出，请重新打开应用。"}));
    });
    Ok(WorkerProcess { child, stdin })
}

#[tauri::command]
fn send_worker_command(app: tauri::AppHandle, state: tauri::State<WorkerState>, command: Value) -> Result<(), String> {
    let mut guard = state.process.lock().map_err(|_| "引擎状态不可用")?;
    let restart = match guard.as_mut() {
        Some(worker) => worker.child.try_wait().map_err(|e| e.to_string())?.is_some(),
        None => true,
    };
    if restart { *guard = Some(spawn_worker(&app)?); }
    let worker = guard.as_mut().ok_or("引擎尚未启动")?;
    let serialized = serde_json::to_string(&command).map_err(|e| e.to_string())?;
    worker.stdin.write_all(format!("{serialized}\n").as_bytes())
        .and_then(|_| worker.stdin.flush()).map_err(|e| format!("发送命令失败：{e}"))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_opener::init())
        .manage(WorkerState::default())
        .invoke_handler(tauri::generate_handler![send_worker_command])
        .run(tauri::generate_context!()).expect("Unable to run moderation desktop");
}
