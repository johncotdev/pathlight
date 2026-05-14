use std::cmp::Reverse;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use jwalk::{Parallelism, WalkDir};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const MAX_CHILDREN_PER_NODE: usize = 72;
const MAX_TOP_FILES_PER_DIR: usize = 18;
const OVERVIEW_DEPTH: usize = 4;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Clone)]
struct RootChildSummary {
    name: String,
    path: PathBuf,
    parent: PathBuf,
    kind: NodeKind,
    total_size: u64,
    file_count: u64,
    dir_count: u64,
    error_count: u64,
    deferred_count: u64,
    scan_state: ScanStateDto,
    has_pending_children: bool,
}

#[derive(Clone, Default)]
pub struct ScanControl {
    active_scan_id: Arc<AtomicU64>,
    priority_path: Arc<Mutex<Option<PathBuf>>>,
}

impl ScanControl {
    pub fn begin(&self, scan_id: u64) {
        self.active_scan_id.store(scan_id, Ordering::Relaxed);
        self.prioritize(scan_id, None);
    }

    pub fn prioritize(&self, scan_id: u64, path: Option<PathBuf>) {
        if self.is_active(scan_id) {
            if let Ok(mut priority_path) = self.priority_path.lock() {
                *priority_path = path;
            }
        }
    }

    pub fn cancel(&self, scan_id: u64) -> bool {
        if scan_id == 0 {
            return false;
        }

        let cancelled = self
            .active_scan_id
            .compare_exchange(scan_id, 0, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok();

        if cancelled {
            if let Ok(mut priority_path) = self.priority_path.lock() {
                *priority_path = None;
            }
        }

        cancelled
    }

    fn is_active(&self, scan_id: u64) -> bool {
        self.active_scan_id.load(Ordering::Relaxed) == scan_id
    }

    fn priority_path(&self, scan_id: u64) -> Option<PathBuf> {
        if !self.is_active(scan_id) {
            return None;
        }
        self.priority_path.lock().ok().and_then(|path| path.clone())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ScanState {
    Complete,
    Partial,
    Deferred,
}

#[derive(Clone, Default)]
struct DirNode {
    name: String,
    path: PathBuf,
    direct_size: u64,
    total_size: u64,
    direct_file_count: u64,
    file_count: u64,
    dir_count: u64,
    error_count: u64,
    deferred_count: u64,
    children: Vec<PathBuf>,
    top_files: Vec<FileLeaf>,
    scan_state: ScanState,
}

#[derive(Clone)]
struct FileLeaf {
    name: String,
    path: PathBuf,
    size: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    scan_id: u64,
    entries: u64,
    files: u64,
    directories: u64,
    bytes: u64,
    deferred: u64,
    elapsed_ms: u128,
    current_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    scan_id: u64,
    root: ScanNode,
    elapsed_ms: u128,
    entries: u64,
    errors: u64,
    deferred: u64,
    mode: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanNode {
    name: String,
    path: String,
    kind: NodeKind,
    total_size: u64,
    self_size: u64,
    file_count: u64,
    dir_count: u64,
    error_count: u64,
    deferred_count: u64,
    scan_state: ScanStateDto,
    synthetic: bool,
    children: Vec<ScanNode>,
}

#[derive(Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Directory,
    File,
    Other,
}

#[derive(Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScanStateDto {
    Complete,
    Partial,
    Deferred,
}

#[derive(Default)]
struct RunningTotals {
    entries: u64,
    files: u64,
    directories: u64,
    bytes: u64,
    errors: u64,
    deferred: u64,
}

#[derive(Default, Clone, Copy)]
struct Stats {
    total_size: u64,
    file_count: u64,
    dir_count: u64,
    error_count: u64,
    deferred_count: u64,
    partial: bool,
}

pub fn scan_path(
    input: PathBuf,
    app: AppHandle,
    scan_id: u64,
    control: ScanControl,
) -> Result<ScanResult, String> {
    let started = Instant::now();
    let root = normalize_root(input)?;
    scan_root_overview(&root, &app, started, scan_id, &control)?;

    let mut table = ScanTable::new(root.clone());
    let mut totals = RunningTotals::default();
    let mut last_emit = Instant::now();

    platform_scan(
        &root,
        &mut table,
        &mut totals,
        &app,
        started,
        &mut last_emit,
        scan_id,
        &control,
    )?;

    compute_stats(&root, &mut table.nodes);
    let root_node =
        build_scan_node(&root, &table.nodes, false).ok_or("Unable to build scan result")?;

    let result = ScanResult {
        scan_id,
        root: root_node,
        elapsed_ms: started.elapsed().as_millis(),
        entries: totals.entries,
        errors: totals.errors,
        deferred: totals.deferred,
        mode: "complete",
    };

    let _ = app.emit("scan-complete", &result);
    Ok(result)
}

struct ScanTable {
    nodes: HashMap<PathBuf, DirNode>,
}

impl ScanTable {
    fn new(root: PathBuf) -> Self {
        let mut nodes = HashMap::new();
        ensure_dir(&mut nodes, root);
        Self { nodes }
    }
}

fn normalize_root(input: PathBuf) -> Result<PathBuf, String> {
    if !input.exists() {
        return Err(format!("Path does not exist: {}", input.display()));
    }
    std::fs::canonicalize(&input)
        .map_err(|err| format!("Unable to open {}: {err}", input.display()))
}

fn scan_root_overview(
    root: &Path,
    app: &AppHandle,
    started: Instant,
    scan_id: u64,
    control: &ScanControl,
) -> Result<Vec<RootChildSummary>, String> {
    let mut summaries = HashMap::new();
    seed_root_children(root, &mut summaries);

    let mut totals = RunningTotals::default();
    let mut last_emit = Instant::now();
    let filter_control = control.clone();
    let walker = WalkDir::new(root)
        .skip_hidden(false)
        .follow_links(false)
        .parallelism(Parallelism::RayonNewPool(overview_scan_threads()))
        .process_read_dir(move |_depth, _parent, _state, children| {
            if !filter_control.is_active(scan_id) {
                children.clear();
                return;
            }

            for child in children.iter_mut() {
                let Ok(entry) = child else {
                    continue;
                };
                if entry.file_type().is_dir() && entry.path_is_symlink() {
                    entry.read_children_path = None;
                }
            }
        });

    for entry in walker {
        if !control.is_active(scan_id) {
            return Err("Scan superseded".to_string());
        }

        match entry {
            Ok(entry) => {
                let path = entry.path();
                totals.entries += 1;

                if path == root {
                    if entry.file_type().is_dir() {
                        totals.directories += 1;
                    }
                    if entry.read_children_error.is_some() {
                        totals.errors += 1;
                    }
                    maybe_emit_progress(app, &totals, started, &path, &mut last_emit, scan_id);
                    continue;
                }

                let Some(overview_paths) = overview_paths(root, &path) else {
                    maybe_emit_progress(app, &totals, started, &path, &mut last_emit, scan_id);
                    continue;
                };

                if entry.file_type().is_dir() {
                    totals.directories += 1;
                    let is_visible_leaf = overview_paths
                        .last()
                        .map(|(_, summary_path)| summary_path == &path)
                        .unwrap_or(false);

                    for (_, summary_path) in &overview_paths {
                        let summary = ensure_root_child_summary(
                            root,
                            &mut summaries,
                            summary_path.clone(),
                            NodeKind::Directory,
                        );
                        summary.dir_count = summary.dir_count.saturating_add(1);
                    }

                    if !is_visible_leaf {
                        if let Some((_, summary_path)) = overview_paths.last() {
                            let summary = ensure_root_child_summary(
                                root,
                                &mut summaries,
                                summary_path.clone(),
                                NodeKind::Directory,
                            );
                            summary.has_pending_children = true;
                            mark_summary_partial(summary);
                        }
                    }

                    if entry.path_is_symlink() {
                        let summary = ensure_overview_target(root, &mut summaries, &overview_paths);
                        summary.deferred_count = summary.deferred_count.saturating_add(1);
                        summary.scan_state = ScanStateDto::Deferred;
                        totals.deferred = totals.deferred.saturating_add(1);
                    } else if entry.read_children_path.is_none() {
                        let summary = ensure_overview_target(root, &mut summaries, &overview_paths);
                        summary.deferred_count = summary.deferred_count.saturating_add(1);
                        mark_summary_partial(summary);
                        totals.deferred = totals.deferred.saturating_add(1);
                    }

                    if entry.read_children_error.is_some() {
                        let summary = ensure_overview_target(root, &mut summaries, &overview_paths);
                        summary.error_count = summary.error_count.saturating_add(1);
                        mark_summary_partial(summary);
                        totals.errors = totals.errors.saturating_add(1);
                    }
                } else if entry.file_type().is_file() {
                    let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
                    totals.files += 1;
                    totals.bytes = totals.bytes.saturating_add(size);

                    let is_visible_file = overview_paths
                        .last()
                        .map(|(_, summary_path)| summary_path == &path)
                        .unwrap_or(false);

                    for (index, (_, summary_path)) in overview_paths.iter().enumerate() {
                        let kind = if index == overview_paths.len() - 1 && is_visible_file {
                            NodeKind::File
                        } else {
                            NodeKind::Directory
                        };
                        let summary = ensure_root_child_summary(
                            root,
                            &mut summaries,
                            summary_path.clone(),
                            kind,
                        );
                        summary.total_size = summary.total_size.saturating_add(size);
                        summary.file_count = summary.file_count.saturating_add(1);
                    }

                    if !is_visible_file {
                        if let Some((_, summary_path)) = overview_paths.last() {
                            let summary = ensure_root_child_summary(
                                root,
                                &mut summaries,
                                summary_path.clone(),
                                NodeKind::Directory,
                            );
                            summary.has_pending_children = true;
                            mark_summary_partial(summary);
                        }
                    }
                } else {
                    if let Some((_, summary_path)) = overview_paths.last() {
                        ensure_root_child_summary(
                            root,
                            &mut summaries,
                            summary_path.clone(),
                            NodeKind::Other,
                        );
                    }
                }

                maybe_emit_progress(app, &totals, started, &path, &mut last_emit, scan_id);
            }
            Err(error) => {
                totals.errors = totals.errors.saturating_add(1);
                let error_path = error
                    .path()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| root.to_path_buf());
                if let Some(overview_paths) = overview_paths(root, &error_path) {
                    let summary = ensure_overview_target(root, &mut summaries, &overview_paths);
                    summary.error_count = summary.error_count.saturating_add(1);
                    mark_summary_partial(summary);
                }
                maybe_emit_progress(app, &totals, started, &error_path, &mut last_emit, scan_id);
            }
        }
    }

    let mut children: Vec<RootChildSummary> = summaries.into_values().collect();
    sort_root_summaries(&mut children);

    let result =
        build_root_overview_result(root, &children, &totals, started, scan_id, "root-overview");
    let _ = app.emit("scan-tree", &result);
    Ok(children)
}

fn seed_root_children(root: &Path, summaries: &mut HashMap<PathBuf, RootChildSummary>) {
    let Ok(children) = std::fs::read_dir(root) else {
        return;
    };

    for child in children.flatten() {
        let path = child.path();
        let kind = child
            .file_type()
            .map(|file_type| {
                if file_type.is_dir() {
                    NodeKind::Directory
                } else if file_type.is_file() {
                    NodeKind::File
                } else {
                    NodeKind::Other
                }
            })
            .unwrap_or(NodeKind::Other);
        ensure_root_child_summary(root, summaries, path, kind);
    }
}

fn ensure_root_child_summary<'a>(
    root: &Path,
    summaries: &'a mut HashMap<PathBuf, RootChildSummary>,
    path: PathBuf,
    kind: NodeKind,
) -> &'a mut RootChildSummary {
    let parent = if overview_depth(root, &path).unwrap_or(1) <= 1 {
        root.to_path_buf()
    } else {
        path.parent().unwrap_or(root).to_path_buf()
    };
    let summary = summaries
        .entry(path.clone())
        .or_insert_with(|| RootChildSummary {
            name: display_name(&path),
            path,
            parent,
            kind,
            total_size: 0,
            file_count: 0,
            dir_count: 0,
            error_count: 0,
            deferred_count: 0,
            scan_state: ScanStateDto::Complete,
            has_pending_children: false,
        });

    if summary.kind == NodeKind::Other && kind != NodeKind::Other {
        summary.kind = kind;
    }

    summary
}

fn ensure_overview_target<'a>(
    root: &Path,
    summaries: &'a mut HashMap<PathBuf, RootChildSummary>,
    overview_paths: &[(usize, PathBuf)],
) -> &'a mut RootChildSummary {
    let (_, path) = overview_paths
        .last()
        .expect("overview paths should contain at least one path");
    ensure_root_child_summary(root, summaries, path.clone(), NodeKind::Directory)
}

fn mark_summary_partial(summary: &mut RootChildSummary) {
    if summary.scan_state == ScanStateDto::Complete {
        summary.scan_state = ScanStateDto::Partial;
    }
}

fn overview_depth(root: &Path, path: &Path) -> Option<usize> {
    let relative = path.strip_prefix(root).ok()?;
    let depth = relative.components().count();
    (depth > 0).then_some(depth)
}

fn overview_paths(root: &Path, path: &Path) -> Option<Vec<(usize, PathBuf)>> {
    let relative = path.strip_prefix(root).ok()?;
    let components: Vec<_> = relative.components().collect();
    if components.is_empty() {
        return None;
    }

    let max_depth = components.len().min(OVERVIEW_DEPTH);
    let mut paths = Vec::with_capacity(max_depth);
    let mut current = root.to_path_buf();
    for (index, component) in components.into_iter().take(max_depth).enumerate() {
        current.push(component.as_os_str());
        paths.push((index + 1, current.clone()));
    }
    Some(paths)
}

fn sort_root_summaries(children: &mut [RootChildSummary]) {
    children.sort_by(|a, b| {
        b.total_size
            .cmp(&a.total_size)
            .then_with(|| a.name.cmp(&b.name))
    });
}

#[cfg(windows)]
fn platform_scan(
    root: &Path,
    table: &mut ScanTable,
    totals: &mut RunningTotals,
    app: &AppHandle,
    started: Instant,
    last_emit: &mut Instant,
    scan_id: u64,
    control: &ScanControl,
) -> Result<(), String> {
    parallel_scan(
        root, table, totals, app, started, last_emit, scan_id, control,
    )
}

fn ensure_dir(nodes: &mut HashMap<PathBuf, DirNode>, path: PathBuf) {
    nodes.entry(path.clone()).or_insert_with(|| DirNode {
        name: display_name(&path),
        path,
        scan_state: ScanState::Complete,
        ..Default::default()
    });
}

fn add_child_dir(nodes: &mut HashMap<PathBuf, DirNode>, parent: &Path, child: PathBuf) {
    ensure_dir(nodes, child.clone());
    if let Some(parent_node) = nodes.get_mut(parent) {
        if !parent_node
            .children
            .iter()
            .any(|existing| existing == &child)
        {
            parent_node.children.push(child);
        }
    }
}

fn add_file(nodes: &mut HashMap<PathBuf, DirNode>, parent: &Path, path: PathBuf, size: u64) {
    let parent = parent.to_path_buf();
    ensure_dir(nodes, parent.clone());
    if let Some(node) = nodes.get_mut(&parent) {
        node.direct_size = node.direct_size.saturating_add(size);
        node.direct_file_count = node.direct_file_count.saturating_add(1);
        push_top_file(
            &mut node.top_files,
            FileLeaf {
                name: display_name(&path),
                path,
                size,
            },
        );
    }
}

fn push_top_file(files: &mut Vec<FileLeaf>, file: FileLeaf) {
    if file.size == 0 {
        return;
    }
    files.push(file);
    files.sort_by_key(|leaf| Reverse(leaf.size));
    files.truncate(MAX_TOP_FILES_PER_DIR);
}

fn mark_deferred(nodes: &mut HashMap<PathBuf, DirNode>, path: &Path) {
    ensure_dir(nodes, path.to_path_buf());
    if let Some(node) = nodes.get_mut(path) {
        node.scan_state = ScanState::Deferred;
        node.deferred_count = node.deferred_count.saturating_add(1);
    }
}

fn mark_partial(nodes: &mut HashMap<PathBuf, DirNode>, path: &Path) {
    ensure_dir(nodes, path.to_path_buf());
    if let Some(node) = nodes.get_mut(path) {
        node.scan_state = ScanState::Partial;
        node.deferred_count = node.deferred_count.saturating_add(1);
    }
}

fn compute_stats(path: &Path, nodes: &mut HashMap<PathBuf, DirNode>) -> Stats {
    let Some(node) = nodes.get(path) else {
        return Stats::default();
    };

    let children = node.children.clone();
    let direct_size = node.direct_size;
    let direct_file_count = node.direct_file_count;
    let own_errors = node.error_count;
    let own_deferred = node.deferred_count;
    let own_partial = node.scan_state != ScanState::Complete;

    let mut stats = Stats {
        total_size: direct_size,
        file_count: direct_file_count,
        dir_count: 1,
        error_count: own_errors,
        deferred_count: own_deferred,
        partial: own_partial,
    };

    for child in children {
        let child_stats = compute_stats(&child, nodes);
        stats.total_size = stats.total_size.saturating_add(child_stats.total_size);
        stats.file_count = stats.file_count.saturating_add(child_stats.file_count);
        stats.dir_count = stats.dir_count.saturating_add(child_stats.dir_count);
        stats.error_count = stats.error_count.saturating_add(child_stats.error_count);
        stats.deferred_count = stats
            .deferred_count
            .saturating_add(child_stats.deferred_count);
        stats.partial |= child_stats.partial;
    }

    if let Some(node) = nodes.get_mut(path) {
        node.total_size = stats.total_size;
        node.file_count = stats.file_count;
        node.dir_count = stats.dir_count;
        node.error_count = stats.error_count;
        node.deferred_count = stats.deferred_count;
        if stats.partial && node.scan_state == ScanState::Complete {
            node.scan_state = ScanState::Partial;
        }
    }

    stats
}

fn build_scan_node(
    path: &Path,
    nodes: &HashMap<PathBuf, DirNode>,
    synthetic: bool,
) -> Option<ScanNode> {
    let node = nodes.get(path)?;
    let mut children: Vec<ScanNode> = node
        .children
        .iter()
        .filter_map(|child| build_scan_node(child, nodes, false))
        .filter(|child| child.total_size > 0 || child.scan_state != ScanStateDto::Complete)
        .collect();

    children.extend(node.top_files.iter().map(file_to_scan_node));
    children.sort_by(|a, b| {
        b.total_size
            .cmp(&a.total_size)
            .then_with(|| a.name.cmp(&b.name))
    });

    if children.len() > MAX_CHILDREN_PER_NODE {
        let remaining = children.split_off(MAX_CHILDREN_PER_NODE - 1);
        let other = remaining.into_iter().fold(
            ScanNode {
                name: "Other".to_string(),
                path: format!("{}::other", display_path(&node.path)),
                kind: NodeKind::Other,
                total_size: 0,
                self_size: 0,
                file_count: 0,
                dir_count: 0,
                error_count: 0,
                deferred_count: 0,
                scan_state: ScanStateDto::Complete,
                synthetic: true,
                children: Vec::new(),
            },
            |mut acc, child| {
                acc.total_size = acc.total_size.saturating_add(child.total_size);
                acc.self_size = acc.self_size.saturating_add(child.self_size);
                acc.file_count = acc.file_count.saturating_add(child.file_count);
                acc.dir_count = acc.dir_count.saturating_add(child.dir_count);
                acc.error_count = acc.error_count.saturating_add(child.error_count);
                acc.deferred_count = acc.deferred_count.saturating_add(child.deferred_count);
                if child.scan_state != ScanStateDto::Complete {
                    acc.scan_state = ScanStateDto::Partial;
                }
                acc
            },
        );
        children.push(other);
    }

    Some(ScanNode {
        name: node.name.clone(),
        path: display_path(&node.path),
        kind: NodeKind::Directory,
        total_size: node.total_size,
        self_size: node.direct_size,
        file_count: node.file_count,
        dir_count: node.dir_count,
        error_count: node.error_count,
        deferred_count: node.deferred_count,
        scan_state: to_scan_state_dto(node.scan_state),
        synthetic,
        children,
    })
}

fn build_root_overview_result(
    root: &Path,
    children: &[RootChildSummary],
    totals: &RunningTotals,
    started: Instant,
    scan_id: u64,
    mode: &'static str,
) -> ScanResult {
    ScanResult {
        scan_id,
        root: root_overview_node(root, children),
        elapsed_ms: started.elapsed().as_millis(),
        entries: totals.entries,
        errors: totals.errors,
        deferred: totals.deferred,
        mode,
    }
}

fn root_overview_node(root: &Path, summaries: &[RootChildSummary]) -> ScanNode {
    let mut by_parent: HashMap<PathBuf, Vec<RootChildSummary>> = HashMap::new();
    for summary in summaries {
        by_parent
            .entry(summary.parent.clone())
            .or_default()
            .push(summary.clone());
    }

    let child_nodes = overview_child_nodes(root, &by_parent);
    let total_size = child_nodes
        .iter()
        .fold(0_u64, |sum, child| sum.saturating_add(child.total_size));
    let self_size = child_nodes
        .iter()
        .filter(|child| child.kind == NodeKind::File)
        .fold(0_u64, |sum, child| sum.saturating_add(child.total_size));
    let file_count = child_nodes
        .iter()
        .fold(0_u64, |sum, child| sum.saturating_add(child.file_count));
    let dir_count = child_nodes
        .iter()
        .fold(1_u64, |sum, child| sum.saturating_add(child.dir_count));
    let error_count = child_nodes
        .iter()
        .fold(0_u64, |sum, child| sum.saturating_add(child.error_count));
    let deferred_count = child_nodes
        .iter()
        .fold(0_u64, |sum, child| sum.saturating_add(child.deferred_count));
    let scan_state = if child_nodes
        .iter()
        .any(|child| child.scan_state != ScanStateDto::Complete)
    {
        ScanStateDto::Partial
    } else {
        ScanStateDto::Complete
    };

    ScanNode {
        name: display_name(root),
        path: display_path(root),
        kind: NodeKind::Directory,
        total_size,
        self_size,
        file_count,
        dir_count,
        error_count,
        deferred_count,
        scan_state,
        synthetic: false,
        children: child_nodes,
    }
}

fn overview_child_nodes(
    parent: &Path,
    by_parent: &HashMap<PathBuf, Vec<RootChildSummary>>,
) -> Vec<ScanNode> {
    let mut summaries = by_parent.get(parent).cloned().unwrap_or_default();
    sort_root_summaries(&mut summaries);

    let mut children: Vec<ScanNode> = summaries
        .into_iter()
        .map(|summary| {
            let mut node = root_child_summary_to_node(&summary);
            if summary.kind == NodeKind::Directory {
                node.children = overview_child_nodes(&summary.path, by_parent);
                if node.scan_state == ScanStateDto::Complete
                    && node
                        .children
                        .iter()
                        .any(|child| child.scan_state != ScanStateDto::Complete)
                {
                    node.scan_state = ScanStateDto::Partial;
                }
            }
            node
        })
        .collect();

    cap_scan_children(&mut children);
    children
}

fn root_child_summary_to_node(summary: &RootChildSummary) -> ScanNode {
    let scan_state = if summary.has_pending_children && summary.scan_state == ScanStateDto::Complete
    {
        ScanStateDto::Partial
    } else {
        summary.scan_state
    };

    ScanNode {
        name: summary.name.clone(),
        path: display_path(&summary.path),
        kind: summary.kind,
        total_size: summary.total_size,
        self_size: if summary.kind == NodeKind::File {
            summary.total_size
        } else {
            0
        },
        file_count: summary.file_count,
        dir_count: summary.dir_count,
        error_count: summary.error_count,
        deferred_count: summary.deferred_count,
        scan_state,
        synthetic: false,
        children: Vec::new(),
    }
}

fn cap_scan_children(children: &mut Vec<ScanNode>) {
    if children.len() <= MAX_CHILDREN_PER_NODE {
        return;
    }

    let remaining = children.split_off(MAX_CHILDREN_PER_NODE - 1);
    let other = remaining.into_iter().fold(
        ScanNode {
            name: "Other".to_string(),
            path: "::overview-other".to_string(),
            kind: NodeKind::Other,
            total_size: 0,
            self_size: 0,
            file_count: 0,
            dir_count: 0,
            error_count: 0,
            deferred_count: 0,
            scan_state: ScanStateDto::Complete,
            synthetic: true,
            children: Vec::new(),
        },
        |mut acc, child| {
            acc.total_size = acc.total_size.saturating_add(child.total_size);
            acc.self_size = acc.self_size.saturating_add(child.self_size);
            acc.file_count = acc.file_count.saturating_add(child.file_count);
            acc.dir_count = acc.dir_count.saturating_add(child.dir_count);
            acc.error_count = acc.error_count.saturating_add(child.error_count);
            acc.deferred_count = acc.deferred_count.saturating_add(child.deferred_count);
            if child.scan_state != ScanStateDto::Complete {
                acc.scan_state = ScanStateDto::Partial;
            }
            acc
        },
    );
    children.push(other);
}

fn file_to_scan_node(file: &FileLeaf) -> ScanNode {
    ScanNode {
        name: file.name.clone(),
        path: display_path(&file.path),
        kind: NodeKind::File,
        total_size: file.size,
        self_size: file.size,
        file_count: 1,
        dir_count: 0,
        error_count: 0,
        deferred_count: 0,
        scan_state: ScanStateDto::Complete,
        synthetic: false,
        children: Vec::new(),
    }
}

fn maybe_emit_progress(
    app: &AppHandle,
    totals: &RunningTotals,
    started: Instant,
    current_path: &Path,
    last_emit: &mut Instant,
    scan_id: u64,
) {
    if last_emit.elapsed() < PROGRESS_INTERVAL {
        return;
    }

    *last_emit = Instant::now();
    let _ = app.emit(
        "scan-progress",
        ScanProgress {
            scan_id,
            entries: totals.entries,
            files: totals.files,
            directories: totals.directories,
            bytes: totals.bytes,
            deferred: totals.deferred,
            elapsed_ms: started.elapsed().as_millis(),
            current_path: display_path(current_path),
        },
    );
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| display_path(path))
}

fn display_path(path: &Path) -> String {
    clean_windows_path(&path.display().to_string())
}

#[cfg(windows)]
fn clean_windows_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

#[cfg(not(windows))]
fn clean_windows_path(path: &str) -> String {
    path.to_string()
}

fn to_scan_state_dto(state: ScanState) -> ScanStateDto {
    match state {
        ScanState::Complete => ScanStateDto::Complete,
        ScanState::Partial => ScanStateDto::Partial,
        ScanState::Deferred => ScanStateDto::Deferred,
    }
}

impl Default for ScanState {
    fn default() -> Self {
        Self::Complete
    }
}

fn parallel_scan(
    root: &Path,
    table: &mut ScanTable,
    totals: &mut RunningTotals,
    app: &AppHandle,
    started: Instant,
    last_emit: &mut Instant,
    scan_id: u64,
    control: &ScanControl,
) -> Result<(), String> {
    let filter_control = control.clone();
    let walker = WalkDir::new(root)
        .skip_hidden(false)
        .follow_links(false)
        .parallelism(Parallelism::RayonNewPool(detail_scan_threads()))
        .process_read_dir(move |_depth, _parent, _state, children| {
            if !filter_control.is_active(scan_id) {
                children.clear();
                return;
            }

            if let Some(priority_path) = filter_control.priority_path(scan_id) {
                children.sort_by_key(|child| {
                    child
                        .as_ref()
                        .ok()
                        .map(|entry| !is_priority_related(&entry.path(), &priority_path))
                        .unwrap_or(true)
                });
            }

            for child in children.iter_mut() {
                let Ok(entry) = child else {
                    continue;
                };
                if entry.file_type().is_dir() && entry.path_is_symlink() {
                    entry.read_children_path = None;
                }
            }
        });

    for entry in walker {
        if !control.is_active(scan_id) {
            return Err("Scan superseded".to_string());
        }

        match entry {
            Ok(entry) => {
                let path = entry.path();
                totals.entries += 1;

                if entry.file_type().is_dir() {
                    totals.directories += 1;
                    ensure_dir(&mut table.nodes, path.clone());

                    if path != root {
                        if let Some(parent) = path.parent() {
                            if !is_git_loose_object_dir(root, parent, &path) {
                                add_child_dir(&mut table.nodes, parent, path.clone());
                            }
                            if entry.path_is_symlink() {
                                mark_deferred(&mut table.nodes, &path);
                                totals.deferred += 1;
                            } else if entry.read_children_path.is_none() {
                                mark_partial(&mut table.nodes, &path);
                                totals.deferred += 1;
                            }
                        }
                    }

                    if entry.read_children_error.is_some() {
                        totals.errors += 1;
                        if let Some(node) = table.nodes.get_mut(&path) {
                            node.error_count += 1;
                        }
                    }
                } else if entry.file_type().is_file() {
                    let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
                    totals.files += 1;
                    totals.bytes = totals.bytes.saturating_add(size);
                    if let Some(parent) = path.parent() {
                        let storage_parent = display_parent(root, parent);
                        add_file(&mut table.nodes, &storage_parent, path.clone(), size);
                    }
                }

                maybe_emit_progress(app, totals, started, &path, last_emit, scan_id);
            }
            Err(error) => {
                totals.errors += 1;
                let error_path = error
                    .path()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| root.to_path_buf());
                let parent = error_path.parent().unwrap_or(root);
                if let Some(node) = table.nodes.get_mut(parent) {
                    node.error_count += 1;
                } else if let Some(node) = table.nodes.get_mut(root) {
                    node.error_count += 1;
                }
                maybe_emit_progress(app, totals, started, &error_path, last_emit, scan_id);
            }
        }
    }

    Ok(())
}

fn available_threads() -> usize {
    std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(8)
}

fn overview_scan_threads() -> usize {
    let cores = available_threads();
    cores.saturating_mul(2).clamp(4, 16)
}

fn detail_scan_threads() -> usize {
    let cores = available_threads();
    cores.saturating_sub(1).clamp(2, 8)
}

fn display_parent(root: &Path, parent: &Path) -> PathBuf {
    let Some(grandparent) = parent.parent() else {
        return parent.to_path_buf();
    };

    if is_git_loose_object_dir(root, grandparent, parent) {
        grandparent.to_path_buf()
    } else {
        parent.to_path_buf()
    }
}

fn is_priority_related(path: &Path, priority_path: &Path) -> bool {
    path.starts_with(priority_path) || priority_path.starts_with(path)
}

fn is_git_loose_object_dir(root: &Path, parent: &Path, child: &Path) -> bool {
    let Some(name) = child.file_name().and_then(|name| name.to_str()) else {
        return false;
    };

    if name.len() != 2 || !name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return false;
    }

    let Ok(relative) = parent.strip_prefix(root) else {
        return false;
    };

    let mut components = relative
        .components()
        .filter_map(|component| component.as_os_str().to_str());
    matches!(
        (components.next(), components.next(), components.next()),
        (Some(".git"), Some("objects"), None)
    )
}
