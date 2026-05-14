import "./vendor/basecoat.cdn.min.css";
import "basecoat-css/all";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { createIcons, icons } from "lucide";
import "./styles.css";

type NodeKind = "directory" | "file" | "other";
type ScanState = "complete" | "partial" | "deferred";

interface ScanNode {
  name: string;
  path: string;
  kind: NodeKind;
  totalSize: number;
  selfSize: number;
  fileCount: number;
  dirCount: number;
  errorCount: number;
  deferredCount: number;
  scanState: ScanState;
  synthetic: boolean;
  children: ScanNode[];
}

interface ScanResult {
  scanId: number;
  root: ScanNode;
  elapsedMs: number;
  entries: number;
  errors: number;
  deferred: number;
  mode: string;
}

interface ScanProgress {
  scanId: number;
  entries: number;
  files: number;
  directories: number;
  bytes: number;
  deferred: number;
  elapsedMs: number;
  currentPath: string;
}

interface QueueItem {
  name: string;
  path: string;
  size: number;
}

interface DonutSegment {
  node: ScanNode;
  topPath: string;
  color: string;
  path: string;
  hoverX: number;
  hoverY: number;
  share: number;
  depth: number;
}

const app = document.querySelector<HTMLDivElement>("#app");
const ANALYSIS_WINDOW = new LogicalSize(560, 390);
const RESULT_WINDOW = new LogicalSize(1180, 760);
const DONUT_MAX_DEPTH = 4;
const DONUT_MAX_CHILDREN = 48;
document.documentElement.classList.add("dark");
document.documentElement.style.colorScheme = "dark";

let result: ScanResult | null = null;
let progress: ScanProgress | null = null;
let currentPath = "";
let isScanning = false;
let scanError = "";
let collector: QueueItem[] = [];
let activeScanRoot = "";
let scanSequence = Date.now();
let activeScanId = 0;
let isExternalDragOver = false;
let hasLiveScanResult = false;
let lastProgressPaint = 0;
let scanStartedAt = 0;
let displayedScanProgress = 0;
let progressAnimationFrame: number | null = null;
let scanPhraseTimer: number | null = null;
let scanPhraseIndex = 0;
let contextMenuCleanup: (() => void) | null = null;
let lastWindowTitle = "";
let lastInternalDragEnded = 0;
let lastExternalDrop = {
  path: "",
  at: 0,
};
let lastProgressValues = {
  path: "",
  summary: "",
};

const palette = [
  "#89b4fa",
  "#a6e3a1",
  "#f9e2af",
  "#f5c2e7",
  "#cba6f7",
  "#94e2d5",
  "#fab387",
  "#b4befe",
  "#89dceb",
  "#f38ba8",
  "#74c7ec",
  "#eba0ac",
  "#f5e0dc",
  "#f2cdcd",
];

const scanPhrases = [
  "Lighting up paths...",
  "Following the heavy trail...",
  "Finding the space hogs...",
  "Peeking into folders...",
  "Sorting the big stuff...",
  "Tracing the largest branch...",
  "Measuring the mess...",
  "Dusting off old corners...",
  "Checking the usual suspects...",
  "Mapping hidden weight...",
  "Chasing bulky folders...",
  "Weighing the directory tree...",
  "Looking for oversized guests...",
  "Untangling nested folders...",
  "Spotting forgotten caches...",
  "Drawing the space map...",
];

async function boot() {
  render();
  await listen<ScanProgress>("scan-progress", (event) => {
    if (event.payload.scanId !== activeScanId) {
      return;
    }

    progress = event.payload;
    if (isScanning) {
      updateProgressUi();
    }
  });

  await listen<ScanResult>("scan-tree", (event) => {
    if (event.payload.scanId !== activeScanId || !isScanning) {
      return;
    }

    const scanResult = event.payload;
    if (!hasLiveScanResult && scanResult.mode !== "root-overview") {
      return;
    }

    result = scanResult;
    activeScanRoot = scanResult.root.path;
    if (!currentPath || !findNode(scanResult.root, currentPath)) {
      currentPath = scanResult.root.path;
    }

    if (!hasLiveScanResult) {
      hasLiveScanResult = true;
      void resizeWindow(RESULT_WINDOW);
    }

    render();
  });

  await registerFileDrop();
}

async function registerFileDrop() {
  try {
    await getCurrentWindow().onDragDropEvent((event: any) => {
      const payload = event.payload ?? event;
      const eventType = payload.type ?? payload.event;

      if (eventType === "enter" || eventType === "over") {
        setExternalDragOver(true);
        return;
      }

      if (eventType === "leave") {
        setExternalDragOver(false);
        return;
      }

      if (eventType === "drop") {
        setExternalDragOver(false);
        handleDroppedPaths(payload.paths);
      }
    });
  } catch (error) {
    console.warn("Pathlight file drop registration failed", error);
    // Browser preview mode has no Tauri window.
  }
}

function handleDroppedPaths(paths: unknown) {
  if (!Array.isArray(paths)) {
    return;
  }

  const path = paths.find((value): value is string => typeof value === "string" && value.length > 0);
  if (!path) {
    return;
  }

  const now = performance.now();
  if (lastExternalDrop.path === path && now - lastExternalDrop.at < 1200) {
    return;
  }

  lastExternalDrop = { path, at: now };
  void startScan(path);
}

function setExternalDragOver(value: boolean) {
  if (isExternalDragOver === value) {
    return;
  }

  isExternalDragOver = value;
  document.querySelector(".entry-shell")?.classList.toggle("is-drop-over", value);
  document.querySelector(".app-shell")?.classList.toggle("is-drop-over", value);
  document.querySelector(".drop-target")?.classList.toggle("is-over", value);
}

function render() {
  if (!app) {
    return;
  }

  hideContextMenu();
  const root = result?.root ?? null;
  const current = root ? findNode(root, currentPath) ?? root : null;

  if (!root || !current) {
    void updateWindowTitle(null);
    app.innerHTML = `<main class="entry-shell ${isExternalDragOver ? "is-drop-over" : ""}">${renderEmptyState()}</main>`;
  } else {
    void updateWindowTitle(current);
    app.innerHTML = `
      <main class="app-shell has-scan ${isExternalDragOver ? "is-drop-over" : ""}">
        ${renderTopBar(root, current)}
        ${renderWorkspace(root, current)}
        ${renderCollector()}
      </main>
    `;
  }

  attachHandlers();
  queueMicrotask(() => createIcons({ icons }));
}

function renderTopBar(root: ScanNode | null, current: ScanNode | null) {
  return `
    <header class="topbar">
      ${root && current ? renderHeaderBreadcrumbs(root, current) : `<div class="topbar-path">Drop a folder or disk</div>`}
      <div class="topbar-actions">
        <button class="btn-sm-outline" data-open>
          <i data-lucide="folder-open"></i>
          Open
        </button>
        ${isScanning ? `<button class="btn-sm-outline" data-cancel><i data-lucide="circle-x"></i>Cancel</button>` : ""}
        ${root ? `<button class="btn-sm-outline" data-rescan><i data-lucide="refresh-cw"></i>Rescan</button>` : ""}
      </div>
      ${isScanning ? `<div class="topbar-progress"><span data-scan-meter style="width:${Math.max(2, displayedScanProgress)}%"></span></div>` : ""}
    </header>
  `;
}

function renderHeaderBreadcrumbs(root: ScanNode, current: ScanNode) {
  const crumbs = pathToNode(root, current.path);
  const visibleCrumbs: Array<ScanNode | "ellipsis"> =
    crumbs.length > 4 ? [crumbs[0], "ellipsis", ...crumbs.slice(-3)] : crumbs;
  return `
    <nav class="topbar-path" title="${escapeHtml(readablePath(current.path))}">
      ${visibleCrumbs
        .map((crumb) => {
          if (crumb === "ellipsis") {
            return `<span class="topbar-ellipsis">...</span>`;
          }
          const active = crumb.path === current.path;
          return `
            <button class="${active ? "active" : ""}" data-breadcrumb="${encodePath(crumb.path)}">
              ${escapeHtml(displayNodeName(crumb))}
            </button>
          `;
        })
        .join('<i data-lucide="chevron-right"></i>')}
    </nav>
  `;
}

function renderEmptyState() {
  const active = isScanning;
  return `
    <section class="empty-stage">
      <div class="drop-target ${active ? "is-active" : ""} ${isExternalDragOver ? "is-over" : ""}">
        <div class="drop-orbit">
          <i data-lucide="${active ? "loader-circle" : "hard-drive"}"></i>
        </div>
        <h1><span data-scan-phrase>${active ? scanPhrases[scanPhraseIndex] : "Drop a folder or disk"}</span></h1>
        <p
          class="scan-path"
          data-scan-path
          title="${escapeHtml(readablePath(progress?.currentPath ?? activeScanRoot))}">
          ${active ? escapeHtml(scanLocation(progress?.currentPath ?? activeScanRoot, activeScanRoot)) : ""}
        </p>
        ${
          active
            ? `<div class="scan-meter">
                <div data-scan-meter style="width:${Math.max(2, displayedScanProgress)}%"></div>
              </div>
              <div class="scan-facts" data-scan-facts>
                ${renderScanFacts()}
              </div>`
            : ""
        }
        ${scanError ? `<div class="scan-error">${escapeHtml(scanError)}</div>` : ""}
        ${
          active
            ? `<button class="btn-sm-outline entry-open" data-cancel><i data-lucide="circle-x"></i>Cancel</button>`
            : `<button class="btn-sm-outline entry-open" data-open><i data-lucide="folder-open"></i>Open Folder</button>`
        }
      </div>
    </section>
  `;
}

function renderWorkspace(root: ScanNode, current: ScanNode) {
  return `
    <section class="workspace">
      <div class="content-grid">
        <section class="visual-panel">
          ${renderDonut(current)}
        </section>
        <aside class="drill-panel">
          ${renderDrillList(current)}
        </aside>
      </div>
    </section>
  `;
}

function renderDonut(node: ScanNode) {
  const children = visibleChildren(node).slice(0, 48);
  if (!children.length) {
    return `
      <div class="empty-panel ${node.scanState !== "complete" ? "is-pending" : ""}">
        <i data-lucide="${node.scanState !== "complete" ? "loader-circle" : "file"}"></i>
        <span>${node.scanState !== "complete" ? "Pending details" : formatBytes(node.totalSize)}</span>
      </div>
    `;
  }

  const segments = buildDonutSegments(node);
  return `
    <div class="donut-map" aria-label="Disk usage map">
      <svg class="donut-svg" viewBox="0 0 100 100" role="img" aria-label="${escapeHtml(displayNodeName(node))} disk usage">
        ${segments
        .map(
          (segment) => `
            <path
              class="donut-segment ${segment.node.kind}"
              d="${segment.path}"
              style="--segment-color:${segment.color};--hover-x:${segment.hoverX.toFixed(2)}px;--hover-y:${segment.hoverY.toFixed(2)}px;--depth:${segment.depth}"
              data-drill="${encodePath(segment.node.path)}"
              data-hover-path="${encodePath(segment.node.path)}"
              data-hover-top="${encodePath(segment.topPath)}"
              data-open-path="${encodePath(segment.node.path)}"
              data-drag-path="${encodePath(segment.node.path)}"
              data-tip-name="${escapeHtml(displayNodeName(segment.node))}"
              data-tip-size="${formatNodeSize(segment.node)}"
              data-tip-share="${formatPercent(segment.share)}"
              data-tip-state="${segment.node.scanState !== "complete" ? "pending" : ""}"
            ></path>
          `,
        )
        .join("")}
      </svg>
      <div class="donut-center">
        <strong>${formatNodeSize(node)}</strong>
        <span>${escapeHtml(displayNodeName(node))}</span>
      </div>
      <div class="donut-tooltip" data-donut-tooltip></div>
    </div>
  `;
}

function renderDrillList(node: ScanNode) {
  const children = visibleChildren(node);
  if (!children.length) {
    return `
      <div class="panel-header">
        <h2>Contents</h2>
      </div>
      <div class="empty-list">${node.scanState !== "complete" ? "Details pending" : "No child items"}</div>
    `;
  }

  return `
    <div class="panel-header">
      <h2>Contents</h2>
      <span class="panel-count">${children.length} items</span>
    </div>
    <div class="item-list">
      ${children
        .slice(0, 42)
        .map((child, index) => {
          const share = node.totalSize ? child.totalSize / node.totalSize : 0;
          const color = palette[index % palette.length];
          const canQueue = !child.synthetic && child.scanState === "complete";
          return `
            <div class="item-row" data-drag-path="${encodePath(child.path)}" data-sync-path="${encodePath(child.path)}" data-open-path="${encodePath(child.path)}">
              <button class="item-main" data-drill="${encodePath(child.path)}">
                <span class="dot" style="background:${color}"></span>
                <span class="item-name">${escapeHtml(displayNodeName(child))}</span>
                <span class="item-size">${formatNodeSize(child)}${child.scanState !== "complete" ? " · pending" : ""}</span>
              </button>
              <div class="item-share" style="--row-color:${color}">
                <span style="width:${Math.max(1, share * 100)}%"></span>
              </div>
              <button class="btn-icon-outline queue-button" aria-label="Queue for Recycle Bin" data-queue="${encodePath(child.path)}" ${canQueue ? "" : "disabled"}>
                <i data-lucide="trash-2"></i>
              </button>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderCollector() {
  return `
    <footer class="collector" data-collector>
      <div class="collector-target">
        <span class="collector-orb"><i data-lucide="recycle"></i></span>
        <div class="collector-items">
          ${
            collector.length
              ? collector
                  .map(
                    (item) => `
                      <button class="collector-chip" data-remove="${encodePath(item.path)}">
                        <span>${escapeHtml(item.name)}</span>
                        <small>${formatBytes(item.size)}</small>
                        <i data-lucide="x"></i>
                      </button>
                    `,
                  )
                  .join("")
              : `<span class="collector-empty">Drag and drop files here to collect them</span>`
          }
        </div>
      </div>
      ${
        collector.length
          ? `<button class="btn-sm-destructive collector-delete" data-recycle aria-label="Move collected items to Recycle Bin">
              <i data-lucide="trash-2"></i>
            </button>`
          : ""
      }
    </footer>
  `;
}

function attachHandlers() {
  document.querySelector("[data-open]")?.addEventListener("click", () => void chooseFolder());
  document.querySelector("[data-cancel]")?.addEventListener("click", () => void cancelScan());
  document.querySelector("[data-rescan]")?.addEventListener("click", () => {
    if (result) {
      void startScan(result.root.path);
    }
  });

  document.querySelectorAll<HTMLElement>("[data-drill]").forEach((element) => {
    element.addEventListener("click", () => {
      if (performance.now() - lastInternalDragEnded < 220) {
        return;
      }
      const path = decodePath(element.dataset.drill ?? "");
      if (path && result && findNode(result.root, path)?.kind !== "file") {
        if (isScanning) {
          void prioritizePath(path);
        }
        currentPath = path;
        render();
      }
    });
  });

  document.querySelectorAll<HTMLElement>("[data-breadcrumb]").forEach((element) => {
    element.addEventListener("click", () => {
      currentPath = decodePath(element.dataset.breadcrumb ?? "");
      if (isScanning && currentPath) {
        void prioritizePath(currentPath);
      }
      render();
    });
  });

  document.querySelectorAll<HTMLElement>("[data-queue]").forEach((element) => {
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      queueNode(decodePath(element.dataset.queue ?? ""));
    });
  });

  document.querySelectorAll<HTMLElement>("[data-remove]").forEach((element) => {
    element.addEventListener("click", () => {
      const path = decodePath(element.dataset.remove ?? "");
      collector = collector.filter((item) => item.path !== path);
      render();
    });
  });

  const collectorDrop = document.querySelector<HTMLElement>("[data-collector]");
  collectorDrop?.addEventListener("dragover", (event) => {
    event.preventDefault();
    collectorDrop.classList.add("is-over");
  });
  collectorDrop?.addEventListener("dragleave", () => collectorDrop.classList.remove("is-over"));
  collectorDrop?.addEventListener("drop", (event) => {
    event.preventDefault();
    collectorDrop.classList.remove("is-over");
    const dragEvent = event as DragEvent;
    queueNode(dragEvent.dataTransfer?.getData("text/pathlight-path") ?? "");
  });

  document.querySelector("[data-recycle]")?.addEventListener("click", () => void recycleCollector());
  attachLinkedHover();
  attachContextMenus();
  attachInternalDrag();
}

async function chooseFolder() {
  const selected = await open({ directory: true, multiple: false });
  if (typeof selected === "string") {
    await startScan(selected);
  }
}

async function startScan(path: string) {
  if (isScanning && activeScanId) {
    void invoke("cancel_scan", { scanId: activeScanId });
  }

  const scanId = ++scanSequence;
  activeScanId = scanId;
  setExternalDragOver(false);
  hasLiveScanResult = false;
  await resizeWindow(ANALYSIS_WINDOW);
  isScanning = true;
  scanError = "";
  progress = null;
  result = null;
  activeScanRoot = path;
  lastProgressPaint = 0;
  scanStartedAt = performance.now();
  displayedScanProgress = 2;
  lastProgressValues = {
    path: "",
    summary: "",
  };
  currentPath = path;
  render();
  startProgressAnimation();
  startScanPhraseRotation();

  try {
    const scanResult = await invoke<ScanResult>("scan_path", { path, scanId });
    if (scanId !== activeScanId || scanResult.scanId !== scanId) {
      return;
    }

    result = scanResult;
    activeScanRoot = result.root.path;
    currentPath = findNode(result.root, currentPath)?.path ?? result.root.path;
    await finishProgressAnimation();
    await resizeWindow(RESULT_WINDOW);
  } catch (error) {
    if (scanId === activeScanId && String(error) !== "Scan superseded") {
      scanError = String(error);
    }
  } finally {
    if (scanId === activeScanId) {
      stopProgressAnimation();
      stopScanPhraseRotation();
      isScanning = false;
      progress = null;
      render();
    }
  }
}

async function cancelScan() {
  if (!isScanning || !activeScanId) {
    return;
  }

  const scanId = activeScanId;
  activeScanId = ++scanSequence;
  isScanning = false;
  progress = null;
  scanError = "";
  stopProgressAnimation();
  stopScanPhraseRotation();
  setExternalDragOver(false);

  if (result) {
    currentPath = findNode(result.root, currentPath)?.path ?? result.root.path;
  } else {
    currentPath = "";
  }

  render();

  try {
    await invoke("cancel_scan", { scanId });
  } catch (error) {
    console.warn("Pathlight cancel failed", error);
  }
}

async function prioritizePath(path: string) {
  if (!activeScanId || !path) {
    return;
  }

  try {
    await invoke("prioritize_path", { path, scanId: activeScanId });
  } catch (error) {
    console.warn("Pathlight priority update failed", error);
  }
}

async function resizeWindow(size: LogicalSize) {
  try {
    const window = getCurrentWindow();
    await window.setSize(size);
    await window.center();
  } catch (error) {
    console.warn("Pathlight window resize failed", error);
    // Browser preview mode has no Tauri window.
  }
}

async function updateWindowTitle(node: ScanNode | null) {
  const elapsedMs = progress?.elapsedMs ?? result?.elapsedMs ?? 0;
  let title = "Pathlight";

  if (node) {
    const elapsed = elapsedMs > 0 ? ` in ${formatDuration(elapsedMs)}` : "";
    title = `${displayNodeName(node)} - ${formatNodeSize(node)}${elapsed} - Pathlight`;
  } else if (isScanning && activeScanRoot) {
    title = `${scanLocation(progress?.currentPath ?? activeScanRoot, activeScanRoot)} - Analyzing - Pathlight`;
  }

  if (title === lastWindowTitle) {
    return;
  }

  lastWindowTitle = title;
  try {
    await getCurrentWindow().setTitle(title);
  } catch (error) {
    console.warn("Pathlight title update failed", error);
  }
}

function updateProgressUi() {
  if (!progress) {
    return;
  }

  const now = performance.now();
  if (now - lastProgressPaint < 950) {
    return;
  }
  lastProgressPaint = now;

  if (result) {
    const current = findNode(result.root, currentPath) ?? result.root;
    void updateWindowTitle(current);
  }

  const path = document.querySelector<HTMLElement>("[data-scan-path]");
  const pathText = scanLocation(progress.currentPath, activeScanRoot);
  if (path) {
    if (lastProgressValues.path !== pathText) {
      path.textContent = pathText;
      lastProgressValues.path = pathText;
    }
    path.title = readablePath(progress.currentPath);
  }

  const summary = formatElapsed(progress.elapsedMs);
  setProgressSlot("summary", summary);
}

async function recycleCollector() {
  if (!collector.length || !window.confirm(`Move ${collector.length} item(s) to the Recycle Bin?`)) {
    return;
  }

  const rootPath = result?.root.path ?? "";
  const paths = collector.map((item) => item.path);
  await invoke("recycle_paths", { paths });
  collector = [];
  if (rootPath) {
    await startScan(rootPath);
  } else {
    render();
  }
}

function queueNode(path: string) {
  if (!path || !result) {
    return;
  }

  const node = findNode(result.root, path);
  if (!node || node.synthetic || collector.some((item) => item.path === node.path)) {
    return;
  }

  collector = [...collector, { name: node.name, path: node.path, size: node.totalSize }];
  render();
}

function findNode(node: ScanNode, path: string): ScanNode | null {
  if (node.path === path) {
    return node;
  }
  for (const child of node.children) {
    const found = findNode(child, path);
    if (found) {
      return found;
    }
  }
  return null;
}

function pathToNode(root: ScanNode, path: string): ScanNode[] {
  const route: ScanNode[] = [];
  const walk = (node: ScanNode): boolean => {
    route.push(node);
    if (node.path === path) {
      return true;
    }
    for (const child of node.children) {
      if (walk(child)) {
        return true;
      }
    }
    route.pop();
    return false;
  };
  walk(root);
  return route;
}

function visibleChildren(node: ScanNode) {
  return node.children
    .filter((child) => child.totalSize > 0 || child.scanState !== "complete")
    .sort((a, b) => b.totalSize - a.totalSize);
}

function buildDonutSegments(node: ScanNode) {
  const segments: DonutSegment[] = [];
  const rootTotal = Math.max(1, node.totalSize);
  const innerRadius = 18.5;
  const ringWidth = 6.6;
  const ringGap = 0.9;
  let segmentCount = 0;

  const append = (
    parent: ScanNode,
    startAngle: number,
    endAngle: number,
    depth: number,
    topPath: string | null,
    branchColor: string | null,
  ) => {
    if (depth >= DONUT_MAX_DEPTH || segmentCount > 220) {
      return;
    }

    const children = visibleChildren(parent)
      .filter((child) => child.totalSize > 0)
      .slice(0, DONUT_MAX_CHILDREN);
    const total = children.reduce((sum, child) => sum + child.totalSize, 0);
    if (!children.length || total <= 0) {
      return;
    }

    let cursor = startAngle;
    children.forEach((child, index) => {
      const span = ((endAngle - startAngle) * child.totalSize) / total;
      if (span <= 0.08) {
        cursor += span;
        return;
      }

      const gap = Math.min(0.85, span * 0.18);
      const segmentStart = cursor + gap / 2;
      const segmentEnd = cursor + span - gap / 2;
      const radiusStart = innerRadius + depth * (ringWidth + ringGap);
      const radiusEnd = radiusStart + ringWidth;
      const color = branchColor ?? palette[index % palette.length];
      const midAngle = (segmentStart + segmentEnd) / 2;
      const hoverDistance = Math.max(0.9, 1.8 - depth * 0.18);
      const hoverRad = degToRad(midAngle - 90);

      if (segmentEnd > segmentStart) {
        segments.push({
          node: child,
          topPath: topPath ?? child.path,
          color,
          path: donutArcPath(50, 50, radiusStart, radiusEnd, segmentStart, segmentEnd),
          hoverX: Math.cos(hoverRad) * hoverDistance,
          hoverY: Math.sin(hoverRad) * hoverDistance,
          share: child.totalSize / rootTotal,
          depth,
        });
        segmentCount += 1;
      }

      append(child, cursor, cursor + span, depth + 1, topPath ?? child.path, color);
      cursor += span;
    });
  };

  append(node, 0, 360, 0, null, null);
  return segments;
}

function donutArcPath(cx: number, cy: number, inner: number, outer: number, start: number, end: number) {
  const adjustedEnd = Math.min(end, start + 359.4);
  const outerStart = polarPoint(cx, cy, outer, start);
  const outerEnd = polarPoint(cx, cy, outer, adjustedEnd);
  const innerEnd = polarPoint(cx, cy, inner, adjustedEnd);
  const innerStart = polarPoint(cx, cy, inner, start);
  const largeArc = adjustedEnd - start > 180 ? 1 : 0;

  return [
    `M ${outerStart.x.toFixed(3)} ${outerStart.y.toFixed(3)}`,
    `A ${outer} ${outer} 0 ${largeArc} 1 ${outerEnd.x.toFixed(3)} ${outerEnd.y.toFixed(3)}`,
    `L ${innerEnd.x.toFixed(3)} ${innerEnd.y.toFixed(3)}`,
    `A ${inner} ${inner} 0 ${largeArc} 0 ${innerStart.x.toFixed(3)} ${innerStart.y.toFixed(3)}`,
    "Z",
  ].join(" ");
}

function polarPoint(cx: number, cy: number, radius: number, angle: number) {
  const radians = degToRad(angle - 90);
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  };
}

function degToRad(angle: number) {
  return (angle * Math.PI) / 180;
}

function attachLinkedHover() {
  const tooltip = document.querySelector<HTMLElement>("[data-donut-tooltip]");
  const clear = () => {
    document.querySelectorAll(".is-linked, .is-exact").forEach((element) => {
      element.classList.remove("is-linked", "is-exact");
    });
    if (tooltip) {
      tooltip.classList.remove("is-visible");
    }
  };

  const setLinked = (path: string, topPath: string) => {
    document.querySelectorAll<HTMLElement>("[data-hover-path]").forEach((element) => {
      const elementPath = decodePath(element.dataset.hoverPath ?? "");
      const elementTop = decodePath(element.dataset.hoverTop ?? "");
      element.classList.toggle("is-linked", elementTop === topPath);
      element.classList.toggle("is-exact", elementPath === path);
    });

    document.querySelectorAll<HTMLElement>("[data-sync-path]").forEach((element) => {
      const elementPath = decodePath(element.dataset.syncPath ?? "");
      element.classList.toggle("is-linked", elementPath === topPath);
      element.classList.toggle("is-exact", elementPath === path);
    });
  };

  const moveTooltip = (event: MouseEvent) => {
    if (!tooltip) {
      return;
    }

    const host = tooltip.closest<HTMLElement>(".donut-map");
    if (!host) {
      return;
    }

    const rect = host.getBoundingClientRect();
    const x = Math.min(rect.width - 190, Math.max(12, event.clientX - rect.left + 14));
    const y = Math.min(rect.height - 82, Math.max(12, event.clientY - rect.top + 14));
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  };

  document.querySelectorAll<HTMLElement>("[data-hover-path]").forEach((element) => {
    element.addEventListener("mouseenter", (event) => {
      const path = decodePath(element.dataset.hoverPath ?? "");
      const topPath = decodePath(element.dataset.hoverTop ?? path);
      setLinked(path, topPath);
      if (tooltip) {
        const pending = element.dataset.tipState ? `<span>${escapeHtml(element.dataset.tipState)}</span>` : "";
        tooltip.innerHTML = `
          <strong>${escapeHtml(element.dataset.tipName ?? "")}</strong>
          <small>${escapeHtml(element.dataset.tipSize ?? "")} · ${escapeHtml(element.dataset.tipShare ?? "")}</small>
          ${pending}
        `;
        tooltip.classList.add("is-visible");
        moveTooltip(event as MouseEvent);
      }
    });
    element.addEventListener("mousemove", (event) => moveTooltip(event as MouseEvent));
    element.addEventListener("mouseleave", clear);
  });

  document.querySelectorAll<HTMLElement>("[data-sync-path]").forEach((element) => {
    element.addEventListener("mouseenter", () => {
      const path = decodePath(element.dataset.syncPath ?? "");
      setLinked(path, path);
    });
    element.addEventListener("mouseleave", clear);
  });
}

function attachContextMenus() {
  document.querySelectorAll<HTMLElement>("[data-open-path]").forEach((element) => {
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const path = decodePath(element.dataset.openPath ?? "");
      if (path) {
        showContextMenu(event as MouseEvent, path);
      }
    });
  });
}

function attachInternalDrag() {
  if (!result) {
    return;
  }

  const collectorTarget = document.querySelector<HTMLElement>("[data-collector]");
  if (!collectorTarget) {
    return;
  }

  document.querySelectorAll<HTMLElement>("[data-drag-path]").forEach((source) => {
    source.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest(
          "[data-queue], [data-remove], [data-recycle], [data-open], [data-rescan], [data-cancel], [data-breadcrumb], .collector-chip, .context-menu",
        )
      ) {
        return;
      }

      const path = decodePath(source.dataset.dragPath ?? "");
      const node = findNode(result!.root, path);
      if (!node || node.synthetic) {
        return;
      }

      const startX = event.clientX;
      const startY = event.clientY;
      let dragging = false;
      let isOverCollector = false;
      let ghost: HTMLElement | null = null;

      const moveGhost = (clientX: number, clientY: number) => {
        if (ghost) {
          ghost.style.transform = `translate(${clientX + 14}px, ${clientY + 12}px)`;
        }
      };

      const updateCollectorState = (clientX: number, clientY: number) => {
        const element = document.elementFromPoint(clientX, clientY);
        isOverCollector = Boolean(element?.closest("[data-collector]"));
        collectorTarget.classList.toggle("is-over", isOverCollector);
      };

      const beginDrag = (moveEvent: PointerEvent) => {
        dragging = true;
        lastInternalDragEnded = performance.now();
        hideContextMenu();
        source.classList.add("is-drag-source");
        document.body.classList.add("is-internal-dragging");
        ghost = document.createElement("div");
        ghost.className = "internal-drag-ghost";
        ghost.innerHTML = `
          <strong>${escapeHtml(displayNodeName(node))}</strong>
          <span>${formatNodeSize(node)}</span>
        `;
        document.body.appendChild(ghost);
        moveGhost(moveEvent.clientX, moveEvent.clientY);
        updateCollectorState(moveEvent.clientX, moveEvent.clientY);
      };

      const cleanup = () => {
        source.classList.remove("is-drag-source");
        document.body.classList.remove("is-internal-dragging");
        collectorTarget.classList.remove("is-over");
        ghost?.remove();
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", onPointerUp);
        document.removeEventListener("pointercancel", onPointerCancel);
      };

      const onPointerMove = (moveEvent: PointerEvent) => {
        const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
        if (!dragging && distance < 6) {
          return;
        }

        if (!dragging) {
          beginDrag(moveEvent);
        }

        moveEvent.preventDefault();
        moveGhost(moveEvent.clientX, moveEvent.clientY);
        updateCollectorState(moveEvent.clientX, moveEvent.clientY);
      };

      const onPointerUp = (upEvent: PointerEvent) => {
        if (dragging) {
          upEvent.preventDefault();
          lastInternalDragEnded = performance.now();
          updateCollectorState(upEvent.clientX, upEvent.clientY);
          if (isOverCollector) {
            queueNode(path);
          }
        }
        cleanup();
      };

      const onPointerCancel = () => {
        if (dragging) {
          lastInternalDragEnded = performance.now();
        }
        cleanup();
      };

      document.addEventListener("pointermove", onPointerMove, { passive: false });
      document.addEventListener("pointerup", onPointerUp);
      document.addEventListener("pointercancel", onPointerCancel);
    });
  });
}

function showContextMenu(event: MouseEvent, path: string) {
  hideContextMenu();

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.innerHTML = `
    <button type="button">
      <i data-lucide="folder-open"></i>
      <span>Open in ${escapeHtml(fileViewerName())}</span>
    </button>
  `;

  const button = menu.querySelector("button");
  button?.addEventListener("click", () => {
    hideContextMenu();
    void openNativePath(path);
  });

  document.body.appendChild(menu);
  createIcons({ icons });

  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const x = Math.min(window.innerWidth - width - 8, Math.max(8, event.clientX));
  const y = Math.min(window.innerHeight - height - 8, Math.max(8, event.clientY));
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const onPointerDown = (pointerEvent: PointerEvent) => {
    if (!menu.contains(pointerEvent.target as Node)) {
      hideContextMenu();
    }
  };
  const onKeyDown = (keyboardEvent: KeyboardEvent) => {
    if (keyboardEvent.key === "Escape") {
      hideContextMenu();
    }
  };

  const pointerTimer = window.setTimeout(() => document.addEventListener("pointerdown", onPointerDown), 0);
  document.addEventListener("keydown", onKeyDown);
  contextMenuCleanup = () => {
    window.clearTimeout(pointerTimer);
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("keydown", onKeyDown);
    menu.remove();
  };
}

function hideContextMenu() {
  contextMenuCleanup?.();
  contextMenuCleanup = null;
}

async function openNativePath(path: string) {
  try {
    await invoke("open_path", { path });
  } catch (error) {
    console.warn("Pathlight open path failed", error);
  }
}

function fileViewerName() {
  if (navigator.userAgent.includes("Windows")) {
    return "File Explorer";
  }
  if (navigator.userAgent.includes("Mac")) {
    return "Finder";
  }
  return "file manager";
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatPercent(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0%";
  }
  const percent = value * 100;
  return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

function formatDuration(ms: number) {
  if (ms < 1000) {
    return `${Math.max(1, Math.round(ms))} ms`;
  }

  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds >= 60) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }

  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

function formatNodeSize(node: ScanNode) {
  return formatBytes(node.totalSize);
}

function formatElapsed(ms: number) {
  return formatDuration(ms);
}

function renderScanFacts() {
  return `
    <span data-progress-slot="summary">0 ms</span>
  `;
}

function setProgressSlot(slot: keyof typeof lastProgressValues, text: string) {
  if (lastProgressValues[slot] === text) {
    return;
  }

  const element = document.querySelector<HTMLElement>(`[data-progress-slot="${slot}"]`);
  if (!element) {
    return;
  }

  element.textContent = text;
  element.classList.toggle("is-empty", text.length === 0);
  lastProgressValues[slot] = text;
}

function startProgressAnimation() {
  stopProgressAnimation();

  const animate = () => {
    if (!isScanning) {
      return;
    }

    const target = estimateScanProgress();
    displayedScanProgress += (target - displayedScanProgress) * 0.035;
    document.querySelectorAll<HTMLElement>("[data-scan-meter]").forEach((meter) => {
      meter.style.width = `${displayedScanProgress.toFixed(2)}%`;
    });

    progressAnimationFrame = window.requestAnimationFrame(animate);
  };

  progressAnimationFrame = window.requestAnimationFrame(animate);
}

function stopProgressAnimation() {
  if (progressAnimationFrame !== null) {
    window.cancelAnimationFrame(progressAnimationFrame);
    progressAnimationFrame = null;
  }
}

function startScanPhraseRotation() {
  stopScanPhraseRotation();
  scanPhraseIndex = 0;
  scanPhraseTimer = window.setInterval(() => {
    if (!isScanning) {
      return;
    }

    scanPhraseIndex = (scanPhraseIndex + 1) % scanPhrases.length;
    const phrase = document.querySelector<HTMLElement>("[data-scan-phrase]");
    if (!phrase) {
      return;
    }

    phrase.classList.add("is-fading");
    window.setTimeout(() => {
      phrase.textContent = scanPhrases[scanPhraseIndex];
      phrase.classList.remove("is-fading");
    }, 180);
  }, 6500);
}

function stopScanPhraseRotation() {
  if (scanPhraseTimer !== null) {
    window.clearInterval(scanPhraseTimer);
    scanPhraseTimer = null;
  }
}

async function finishProgressAnimation() {
  const meter = document.querySelector<HTMLElement>("[data-scan-meter]");
  if (meter) {
    displayedScanProgress = 100;
    meter.style.width = "100%";
    if (progress) {
      setProgressSlot("summary", formatElapsed(progress.elapsedMs));
    }
    await delay(120);
  }
}

function estimateScanProgress() {
  const elapsed = Math.max(0, performance.now() - scanStartedAt);
  const target = 3 + 89 * (1 - Math.exp(-elapsed / 18_000));
  return Math.min(92, Math.max(displayedScanProgress, target));
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function scanLocation(rawPath: string, rawRoot: string) {
  const path = readablePath(rawPath);
  const root = readablePath(rawRoot || rawPath);
  if (!path) {
    return "Preparing scan";
  }

  const rootName = displayPathName(root);
  const relative = relativePathParts(path, root);
  if (!relative.length) {
    return rootName;
  }

  return `${rootName} › ${relative[0]}`;
}

function readablePath(rawPath: string) {
  let value = rawPath.trim();
  if (value.startsWith("\\\\?\\UNC\\")) {
    value = `\\\\${value.slice("\\\\?\\UNC\\".length)}`;
  } else if (value.startsWith("\\\\?\\")) {
    value = value.slice("\\\\?\\".length);
  }
  if (value.includes("\\") || /^[A-Za-z]:/.test(value)) {
    return value.replaceAll("/", "\\");
  }
  return value;
}

function displayPathName(path: string) {
  const clean = readablePath(path);
  if (/^[A-Za-z]:\\?$/.test(clean)) {
    return `${clean.slice(0, 2)}\\`;
  }

  const parts = pathParts(path);
  if (!parts.length) {
    return clean || "Selected folder";
  }
  return parts[parts.length - 1] || parts[0] || clean;
}

function displayNodeName(node: ScanNode) {
  if (node.synthetic || node.kind === "other") {
    return node.name;
  }

  return displayPathName(node.path || node.name);
}

function relativePathParts(path: string, root: string) {
  const pathPartsValue = pathParts(path);
  const rootPartsValue = pathParts(root);
  let index = 0;
  while (
    index < pathPartsValue.length &&
    index < rootPartsValue.length &&
    pathPartsValue[index].toLocaleLowerCase() === rootPartsValue[index].toLocaleLowerCase()
  ) {
    index += 1;
  }
  return pathPartsValue.slice(index);
}

function pathParts(path: string) {
  const clean = readablePath(path);
  const separator = clean.includes("\\") ? "\\" : "/";
  return clean
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);
}

function encodePath(path: string) {
  return encodeURIComponent(path);
}

function decodePath(path: string) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#039;";
    }
  });
}

void boot();
