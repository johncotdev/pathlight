mod scanner;

use std::path::{Path, PathBuf};
use std::process::Command;

use scanner::{ScanControl, ScanResult};
use tauri::{AppHandle, State};

#[tauri::command]
async fn scan_path(
    app: AppHandle,
    control: State<'_, ScanControl>,
    path: String,
    scan_id: u64,
) -> Result<ScanResult, String> {
    let control = control.inner().clone();
    control.begin(scan_id);

    tauri::async_runtime::spawn_blocking(move || {
        scanner::scan_path(PathBuf::from(path), app, scan_id, control)
    })
    .await
    .map_err(|err| format!("Scan task failed: {err}"))?
}

#[tauri::command]
async fn prioritize_path(
    control: State<'_, ScanControl>,
    path: String,
    scan_id: u64,
) -> Result<(), String> {
    let path = PathBuf::from(path);
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    control.inner().prioritize(scan_id, Some(path));
    Ok(())
}

#[tauri::command]
async fn cancel_scan(control: State<'_, ScanControl>, scan_id: u64) -> Result<bool, String> {
    Ok(control.inner().cancel(scan_id))
}

#[tauri::command]
async fn recycle_paths(paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        trash::delete_all(&paths).map_err(|err| format!("Unable to move item to trash: {err}"))
    })
    .await
    .map_err(|err| format!("Recycle task failed: {err}"))?
}

#[tauri::command]
async fn open_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        let path = std::fs::canonicalize(&path).unwrap_or(path);
        open_in_file_manager(&path)
    })
    .await
    .map_err(|err| format!("Open task failed: {err}"))?
}

#[cfg(windows)]
fn open_in_file_manager(path: &Path) -> Result<(), String> {
    let mut command = Command::new("explorer");
    if path.is_file() {
        command.arg(format!("/select,{}", path.display()));
    } else {
        command.arg(path);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Unable to open File Explorer: {err}"))
}

#[cfg(target_os = "macos")]
fn open_in_file_manager(path: &Path) -> Result<(), String> {
    let mut command = Command::new("open");
    if path.is_file() {
        command.arg("-R").arg(path);
    } else {
        command.arg(path);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Unable to open Finder: {err}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_in_file_manager(path: &Path) -> Result<(), String> {
    let target = if path.is_file() {
        path.parent().unwrap_or(path)
    } else {
        path
    };
    Command::new("xdg-open")
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Unable to open file manager: {err}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ScanControl::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_path,
            prioritize_path,
            cancel_scan,
            recycle_paths,
            open_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pathlight");
}
