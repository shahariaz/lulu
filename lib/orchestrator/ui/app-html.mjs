/**
 * Render the Claude-Zen Software Delivery Web Application HTML.
 * Served on /delivery and /orchestrator.
 */
export function renderDeliveryAppHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude-Zen | AI Software Delivery Platform</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --accent: #58a6ff;
      --accent-hover: #79c0ff;
      --success: #3fb950;
      --warning: #d29922;
      --danger: #f85149;
      --purple: #bc8cff;
      --font-mono: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      height: 100vh;
      overflow: hidden;
    }
    .sidebar {
      width: 260px;
      background: var(--card-bg);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
    }
    .brand {
      padding: 16px;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 1px;
      display: flex;
      align-items: center;
      gap: 10px;
      border-bottom: 1px solid var(--border);
    }
    .brand span { color: var(--accent); }
    .nav {
      flex: 1;
      padding: 12px 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .nav-item {
      padding: 10px 14px;
      border-radius: 6px;
      color: var(--text);
      text-decoration: none;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .nav-item:hover { background: rgba(255,255,255,0.05); }
    .nav-item.active { background: rgba(88, 166, 255, 0.15); color: var(--accent); font-weight: 600; }
    .main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .header {
      height: 56px;
      border-bottom: 1px solid var(--border);
      padding: 0 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--card-bg);
    }
    .header-title { font-size: 15px; font-weight: 600; }
    .content {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .card-title {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .btn {
      padding: 7px 14px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.05);
      color: var(--text);
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn:hover { background: rgba(255,255,255,0.1); }
    .btn-primary { background: #238636; border-color: #2ea043; color: #fff; }
    .btn-primary:hover { background: #2ea043; }
    .btn-danger { background: rgba(248,81,73,0.15); border-color: var(--danger); color: var(--danger); }
    .btn-sm { padding: 4px 10px; font-size: 12px; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 600;
      border-radius: 12px;
      border: 1px solid var(--border);
    }
    .badge-ready { border-color: var(--accent); color: var(--accent); }
    .badge-progress { border-color: var(--warning); color: var(--warning); }
    .badge-done { border-color: var(--success); color: var(--success); }
    .badge-blocked { border-color: var(--danger); color: var(--danger); }
    .badge-review { border-color: var(--purple); color: var(--purple); }
    .board {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
      margin-top: 16px;
    }
    .column {
      background: rgba(255,255,255,0.02);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 400px;
    }
    .column-header {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      display: flex;
      justify-content: space-between;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }
    .task-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      cursor: pointer;
      transition: transform 0.1s, border-color 0.1s;
    }
    .task-card:hover { border-color: var(--accent); transform: translateY(-1px); }
    .task-title { font-size: 13px; font-weight: 600; }
    .task-desc { font-size: 12px; color: var(--text-muted); }
    .task-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      color: var(--text-muted);
    }
    .mono { font-family: var(--font-mono); }
    .diff-view {
      background: #090d13;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
      font-family: var(--font-mono);
      font-size: 12px;
      overflow-x: auto;
      white-space: pre;
      line-height: 1.5;
    }
    .form-group { margin-bottom: 14px; }
    .form-group label { display: block; font-size: 12px; font-weight: 500; margin-bottom: 6px; color: var(--text-muted); }
    .form-control {
      width: 100%;
      padding: 8px 12px;
      background: rgba(0,0,0,0.2);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      font-size: 13px;
    }
    .form-control:focus { outline: none; border-color: var(--accent); }
  </style>
</head>
<body>
  <aside class="sidebar">
    <div class="brand">
      <span>ZEN</span> DELIVERY
    </div>
    <nav class="nav">
      <div class="nav-item active" onclick="switchTab('board')">📋 Delivery Board</div>
      <div class="nav-item" onclick="switchTab('scoper')">💬 Scoper & Baselines</div>
      <div class="nav-item" onclick="switchTab('projects')">📁 Repository Manager</div>
      <div class="nav-item" onclick="switchTab('audit')">📜 Audit & Telemetry</div>
    </nav>
  </aside>

  <main class="main">
    <header class="header">
      <div class="header-title" id="page-title">Delivery Board & Task DAG</div>
      <div style="display: flex; gap: 8px;">
        <button class="btn btn-sm" onclick="refreshData()">Refresh</button>
        <button class="btn btn-sm btn-primary" onclick="openImportModal()">Import Repository</button>
      </div>
    </header>

    <div class="content" id="view-content">
      <!-- Dynamic View Injected Here -->
    </div>
  </main>

  <script>
    let currentTab = 'board';
    let activeProject = null;
    let activeMilestone = null;
    let tasks = [];

    async function fetchJson(url, options = {}) {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      return data;
    }

    async function loadInitialData() {
      try {
        const { projects } = await fetchJson('/api/orchestrator/projects');
        if (projects.length > 0) {
          activeProject = projects[0];
          document.getElementById('page-title').innerText = 'Project: ' + activeProject.name;
        }
        renderView();
      } catch (err) {
        console.error('Failed to load initial data:', err);
      }
    }

    function switchTab(tab) {
      currentTab = tab;
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
      event.target.classList.add('active');
      renderView();
    }

    function renderView() {
      const container = document.getElementById('view-content');
      if (currentTab === 'board') {
        renderBoardView(container);
      } else if (currentTab === 'scoper') {
        renderScoperView(container);
      } else if (currentTab === 'projects') {
        renderProjectsView(container);
      } else if (currentTab === 'audit') {
        renderAuditView(container);
      }
    }

    function renderBoardView(container) {
      container.innerHTML = \`
        <div class="card">
          <div class="card-title">
            <span>Milestone 1: Core Vertical Slice</span>
            <span class="badge badge-ready">Sequential Execution (1 Writer)</span>
          </div>
          <p style="font-size: 13px; color: var(--text-muted);">
            Tasks transition through verifiable gates: Backlog &rarr; Ready &rarr; In Progress &rarr; Automated Checks &rarr; Code Review &rarr; QA &rarr; Done.
          </p>
        </div>

        <div class="board">
          <div class="column" id="col-backlog"><div class="column-header">Backlog <span>0</span></div></div>
          <div class="column" id="col-ready"><div class="column-header">Ready <span>0</span></div></div>
          <div class="column" id="col-progress"><div class="column-header">In Progress <span>0</span></div></div>
          <div class="column" id="col-checks"><div class="column-header">Checks <span>0</span></div></div>
          <div class="column" id="col-review"><div class="column-header">Code Review <span>0</span></div></div>
          <div class="column" id="col-qa"><div class="column-header">QA (Accept) <span>0</span></div></div>
          <div class="column" id="col-done"><div class="column-header">Done <span>0</span></div></div>
        </div>
      \`;
    }

    function renderScoperView(container) {
      container.innerHTML = \`
        <div class="card">
          <div class="card-title">Conversational Feature Scoper & PRD Architect</div>
          <div class="form-group">
            <label>Feature Title</label>
            <input class="form-control" id="feat-title" placeholder="e.g. User Authentication & Profile API">
          </div>
          <div class="form-group">
            <label>Scoping Prompt</label>
            <textarea class="form-control" id="feat-prompt" rows="4" placeholder="Describe the feature requirements, targets, and constraints..."></textarea>
          </div>
          <button class="btn btn-primary" onclick="startScoping()">Start Scoping Session</button>
        </div>
      \`;
    }

    function renderProjectsView(container) {
      container.innerHTML = \`
        <div class="card">
          <div class="card-title">Import Local Repository</div>
          <div class="form-group">
            <label>Filesystem Path</label>
            <input class="form-control mono" id="repo-path-input" placeholder="/Users/username/projects/my-app">
          </div>
          <button class="btn btn-primary" onclick="importRepo()">Connect Repository</button>
        </div>
      \`;
    }

    function renderAuditView(container) {
      container.innerHTML = \`
        <div class="card">
          <div class="card-title">Orchestrator Audit & Telemetry Log</div>
          <p style="font-size: 13px; color: var(--text-muted);">Immutable audit events from SQLite control plane.</p>
        </div>
      \`;
    }

    function refreshData() {
      loadInitialData();
    }

    window.onload = loadInitialData;
  </script>
</body>
</html>`;
}
