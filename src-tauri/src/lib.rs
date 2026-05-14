mod scanner;

use std::path::PathBuf;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ScanControl::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_path,
            prioritize_path,
            cancel_scan,
            recycle_paths
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pathlight");
}
