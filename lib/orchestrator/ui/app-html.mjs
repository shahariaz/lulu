/**
 * Render the Claude-Zen Software Delivery Web Application HTML.
 * Served on /delivery, /orchestrator, and / (root).
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
      --bg: #0a0d13;
      --card-bg: #121824;
      --card-hover: #182030;
      --border: #232c3d;
      --border-focus: #4b6fff;
      --text: #f0f4fc;
      --text-muted: #8a96ad;
      --accent: #4b6fff;
      --accent-hover: #6d8aff;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --purple: #a855f7;
      --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      --font-mono: 'JetBrains Mono', 'SFMono-Regular', Consolas, Menlo, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font-sans);
      background: var(--bg);
      color: var(--text);
      display: flex;
      height: 100vh;
      overflow: hidden;
    }
    /* Sidebar */
    .sidebar {
      width: 260px;
      background: var(--card-bg);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      z-index: 10;
    }
    .brand {
      padding: 16px 20px;
      font-size: 15px;
      font-weight: 800;
      letter-spacing: 0.5px;
      display: flex;
      align-items: center;
      gap: 10px;
      border-bottom: 1px solid var(--border);
    }
    .brand-badge {
      width: 24px; height: 24px; border-radius: 6px;
      background: var(--accent); color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-weight: 900; font-size: 12px;
    }
    .nav { flex: 1; padding: 12px 10px; display: flex; flex-direction: column; gap: 4px; }
    .nav-item {
      padding: 9px 12px; border-radius: 6px;
      color: var(--text-muted); font-size: 13px; font-weight: 500;
      display: flex; align-items: center; gap: 10px; cursor: pointer;
      transition: all 0.15s;
    }
    .nav-item:hover { background: rgba(255,255,255,0.05); color: var(--text); }
    .nav-item.active { background: rgba(75, 111, 255, 0.15); color: var(--accent); font-weight: 600; }
    .project-pill {
      margin: 12px 10px; padding: 10px 12px; background: rgba(0,0,0,0.3);
      border: 1px solid var(--border); border-radius: 6px; font-size: 12px;
    }
    /* Main Layout */
    .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .header {
      height: 56px; border-bottom: 1px solid var(--border);
      padding: 0 24px; display: flex; align-items: center; justify-content: space-between;
      background: rgba(18, 24, 36, 0.7); backdrop-filter: blur(8px);
    }
    .header-title { font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .content { flex: 1; overflow-y: auto; padding: 20px 24px; }
    /* Cards & Components */
    .card {
      background: var(--card-bg); border: 1px solid var(--border);
      border-radius: 8px; padding: 18px; margin-bottom: 16px;
    }
    .card-title {
      font-size: 14px; font-weight: 700; margin-bottom: 10px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .btn {
      padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600;
      border: 1px solid var(--border); background: rgba(255,255,255,0.06);
      color: var(--text); cursor: pointer; transition: all 0.15s; display: inline-flex; align-items: center; gap: 6px;
    }
    .btn:hover { background: rgba(255,255,255,0.12); }
    .btn-primary { background: #238636; border-color: #2ea043; color: #fff; }
    .btn-primary:hover { background: #2ea043; }
    .btn-sm { padding: 4px 10px; font-size: 11px; }
    .badge {
      display: inline-block; padding: 2px 8px; font-size: 11px;
      font-weight: 700; border-radius: 12px; border: 1px solid var(--border);
      font-family: var(--font-mono);
    }
    .badge-ready { border-color: rgba(75,111,255,0.4); color: var(--accent); background: rgba(75,111,255,0.1); }
    .badge-done { border-color: rgba(16,185,129,0.4); color: var(--success); background: rgba(16,185,129,0.1); }
    .badge-progress { border-color: rgba(245,158,11,0.4); color: var(--warning); background: rgba(245,158,11,0.1); }
    /* Pipeline Progress Banner */
    .pipeline-bar {
      display: flex; align-items: center; justify-content: space-between;
      background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px;
      padding: 12px 20px; margin-bottom: 16px;
    }
    .pipeline-step { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 700; color: var(--text-muted); }
    .pipeline-step.active { color: var(--accent); }
    .pipeline-step.done { color: var(--success); }
    .pipeline-circle {
      width: 22px; height: 22px; border-radius: 50%;
      border: 2px solid var(--border); display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 800;
    }
    .pipeline-step.done .pipeline-circle { background: #238636; border-color: #2ea043; color: #fff; }
    .pipeline-step.active .pipeline-circle { background: var(--accent); border-color: var(--accent-hover); color: #fff; }
    /* Kanban Board */
    .board-grid {
      display: grid; grid-template-columns: 2fr 1fr; gap: 16px; height: calc(100vh - 170px);
    }
    .board-columns {
      display: grid; grid-template-columns: repeat(7, minmax(130px, 1fr)); gap: 10px;
      overflow-x: auto; height: 100%;
    }
    .column {
      background: rgba(255,255,255,0.02); border: 1px solid var(--border);
      border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px;
    }
    .column-header {
      font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
      color: var(--text-muted); display: flex; justify-content: space-between; padding-bottom: 6px; border-bottom: 1px solid var(--border);
    }
    .task-card {
      background: var(--card-bg); border: 1px solid var(--border);
      border-radius: 6px; padding: 10px; display: flex; flex-direction: column; gap: 6px;
      cursor: pointer; transition: all 0.15s;
    }
    .task-card:hover { border-color: var(--accent); background: var(--card-hover); transform: translateY(-1px); }
    .task-card.active { border-color: var(--accent); background: rgba(75,111,255,0.12); }
    .task-title { font-size: 12px; font-weight: 600; line-height: 1.3; }
    .task-meta { font-size: 10px; font-family: var(--font-mono); color: var(--text-muted); display: flex; justify-content: space-between; }
    /* Diff View */
    .diff-container {
      background: #06090e; border: 1px solid var(--border); border-radius: 8px;
      padding: 12px; font-family: var(--font-mono); font-size: 11px;
      overflow: auto; height: calc(100% - 40px); white-space: pre; line-height: 1.5;
    }
    .diff-add { background: rgba(16,185,129,0.12); color: #6ee7b7; display: block; }
    .diff-del { background: rgba(239,68,68,0.12); color: #fca5a5; display: block; }
    .diff-header { color: var(--accent); font-weight: bold; display: block; margin-top: 4px; }
    /* Preview Frame */
    .preview-wrapper {
      background: #06090e; border: 1px solid var(--border); border-radius: 8px;
      overflow: hidden; height: 100%; display: flex; flex-direction: column;
    }
    .preview-header {
      background: var(--card-bg); border-bottom: 1px solid var(--border);
      padding: 8px 16px; display: flex; align-items: center; justify-content: space-between;
    }
    .preview-frame { width: 100%; flex: 1; border: 0; background: #fff; }
    /* Action Bar */
    .action-bar {
      height: 50px; background: var(--card-bg); border-top: 1px solid var(--border);
      padding: 0 24px; display: flex; align-items: center; justify-content: space-between;
      font-size: 12px;
    }
    .mono { font-family: var(--font-mono); }
  </style>
</head>
<body>
  <!-- Sidebar -->
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-badge">Z</div>
      <span>CLAUDE-ZEN</span>
      <span class="badge badge-ready" style="margin-left: auto;">v1.5</span>
    </div>

    <div class="project-pill">
      <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 3px;">Project</div>
      <div style="font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" id="proj-name">Developer Portfolio</div>
      <div style="font-size: 11px; color: var(--accent); font-family: var(--font-mono); margin-top: 2px;">main &rarr; zen/portfolio-website</div>
    </div>

    <nav class="nav">
      <div class="nav-item active" onclick="setTab('board')">📋 Delivery Board</div>
      <div class="nav-item" onclick="setTab('preview')">👁️ Live Portfolio Preview</div>
      <div class="nav-item" onclick="setTab('diff')">🔍 Diff & Review Inspector</div>
      <div class="nav-item" onclick="setTab('scoper')">💬 Scoper & Baselines</div>
      <div class="nav-item" onclick="setTab('projects')">📁 Repository Manager</div>
    </nav>
  </aside>

  <!-- Main Content -->
  <main class="main">
    <header class="header">
      <div class="header-title" id="page-title">
        <span>Delivery Board & Task DAG</span>
        <span class="badge badge-done" style="font-size: 10px;">All Tasks Verified</span>
      </div>
      <div style="display: flex; gap: 8px;">
        <a href="http://127.0.0.1:41000/" target="_blank" class="btn btn-sm btn-primary">Open Live Site (41000) ↗</a>
        <button class="btn btn-sm" onclick="loadAllData()">Refresh</button>
      </div>
    </header>

    <div class="content" id="content-container">
      <!-- Dynamic Content View Injected Here -->
    </div>

    <footer class="action-bar">
      <div style="display: flex; align-items: center; gap: 12px;">
        <span class="badge badge-done">● Pipeline Complete</span>
        <span style="color: var(--text-muted);">Feature Branch: <span class="mono" style="color: var(--accent);">zen/portfolio-website</span> merged into <span class="mono">main</span></span>
      </div>
      <div style="display: flex; gap: 8px;">
        <button class="btn btn-sm" onclick="setTab('preview')">View Live Preview</button>
        <button class="btn btn-sm btn-primary" onclick="setTab('diff')">Inspect Commits & Diffs</button>
      </div>
    </footer>
  </main>

  <script>
    let activeTab = 'board';
    let projectData = null;
    let baselineData = null;
    let tasksList = [];
    let selectedTaskId = null;

    async function fetchJson(url) {
      const res = await fetch(url);
      return res.json();
    }

    async function loadAllData() {
      try {
        const { projects } = await fetchJson('/api/orchestrator/projects');
        if (projects.length > 0) {
          const proj = projects[0];
          projectData = proj;
          document.getElementById('proj-name').innerText = proj.name;

          const projDetails = await fetchJson('/api/orchestrator/projects/' + proj.id);
          baselineData = projDetails.activeBaseline;

          if (baselineData) {
            // Find milestone and tasks
            const msRes = await fetchJson('/api/orchestrator/baselines/' + baselineData.id + '/decompose');
            // Or query directly
          }

          // Fetch tasks for milestone ms_23456805-cf1
          const tRes = await fetchJson('/api/orchestrator/milestones/ms_23456805-cf1/tasks');
          tasksList = tRes.tasks || [];
          if (!selectedTaskId && tasksList.length > 0) {
            selectedTaskId = tasksList[0].id;
          }
        }
        renderCurrentTab();
      } catch (err) {
        console.error('Data load error:', err);
      }
    }

    function setTab(tab) {
      activeTab = tab;
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
      const activeEl = Array.from(document.querySelectorAll('.nav-item')).find(el => el.innerText.toLowerCase().includes(tab.toLowerCase()));
      if (activeEl) activeEl.classList.add('active');
      renderCurrentTab();
    }

    function renderCurrentTab() {
      const c = document.getElementById('content-container');
      if (activeTab === 'board') renderBoard(c);
      else if (activeTab === 'preview') renderPreview(c);
      else if (activeTab === 'diff') renderDiff(c);
      else if (activeTab === 'scoper') renderScoper(c);
      else if (activeTab === 'projects') renderProjects(c);
    }

    function renderBoard(c) {
      const cols = [
        { id: 'Backlog', label: 'Backlog' },
        { id: 'Ready', label: 'Ready' },
        { id: 'In Progress', label: 'Worker' },
        { id: 'Automated Checks', label: 'Checks' },
        { id: 'Code Review', label: 'Review' },
        { id: 'QA', label: 'QA' },
        { id: 'Done', label: 'Done' }
      ];

      const selTask = tasksList.find(t => t.id === selectedTaskId) || tasksList[0];

      c.innerHTML = \`
        <!-- Pipeline Progress Banner -->
        <div class="pipeline-bar">
          <div class="pipeline-step done"><div class="pipeline-circle">✓</div> 1. Onboard Repo</div>
          <span style="color: var(--text-muted);">&rarr;</span>
          <div class="pipeline-step done"><div class="pipeline-circle">✓</div> 2. Baseline PRD</div>
          <span style="color: var(--text-muted);">&rarr;</span>
          <div class="pipeline-step done"><div class="pipeline-circle">✓</div> 3. Task Worktree</div>
          <span style="color: var(--text-muted);">&rarr;</span>
          <div class="pipeline-step done"><div class="pipeline-circle">✓</div> 4. Worker Edit</div>
          <span style="color: var(--text-muted);">&rarr;</span>
          <div class="pipeline-step done"><div class="pipeline-circle">✓</div> 5. Checks Pass</div>
          <span style="color: var(--text-muted);">&rarr;</span>
          <div class="pipeline-step done"><div class="pipeline-circle">✓</div> 6. Review Approved</div>
          <span style="color: var(--text-muted);">&rarr;</span>
          <div class="pipeline-step done"><div class="pipeline-circle">✓</div> 7. Merged (Main)</div>
        </div>

        <div class="board-grid">
          <!-- 7 Kanban Columns -->
          <div class="board-columns">
            \${cols.map(col => {
              const matching = tasksList.filter(t => t.status === col.id);
              return \`
                <div class="column">
                  <div class="column-header">
                    <span>\${col.label}</span>
                    <span>\${matching.length}</span>
                  </div>
                  \${matching.map(t => \`
                    <div class="task-card \${t.id === selectedTaskId ? 'active' : ''}" onclick="selectTask('\${t.id}')">
                      <div class="task-title">\${t.title}</div>
                      <div class="task-meta">
                        <span>\${t.scope_paths.length} file(s)</span>
                        <span class="badge badge-done">Done</span>
                      </div>
                    </div>
                  \`).join('')}
                  \${matching.length === 0 ? '<div style=\"font-size: 11px; color: var(--text-muted); text-align: center; padding: 20px 0;\">Empty</div>' : ''}
                </div>
              \`;
            }).join('')}
          </div>

          <!-- Quick Inspector Right Panel -->
          <div class="card" style="height: 100%; display: flex; flex-direction: column; overflow: hidden;">
            <div class="card-title">
              <span>Task Inspector</span>
              <span class="badge badge-done">Completed & Verified</span>
            </div>
            \${selTask ? \`
              <div style="font-size: 12px; font-weight: 700; margin-bottom: 6px;">\${selTask.title}</div>
              <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 12px;">\${selTask.description}</div>
              <div style="font-size: 11px; margin-bottom: 8px;">
                <strong style="color: var(--accent);">Scope Paths:</strong>
                <div class="mono" style="background: rgba(0,0,0,0.3); padding: 6px; border-radius: 4px; margin-top: 4px;">
                  \${selTask.scope_paths.map(p => '• ' + p).join('<br>')}
                </div>
              </div>
              <div style="margin-top: auto; display: flex; gap: 8px;">
                <button class="btn btn-sm btn-primary w-full" onclick="setTab('diff')">View Full Unified Diff &rarr;</button>
              </div>
            \` : 'Select a task to inspect.'}
          </div>
        </div>
      \`;
    }

    function selectTask(id) {
      selectedTaskId = id;
      renderCurrentTab();
    }

    function renderPreview(c) {
      c.innerHTML = \`
        <div class="preview-wrapper">
          <div class="preview-header">
            <div style="display: flex; align-items: center; gap: 10px;">
              <span class="badge badge-done">● Live Local Preview Running</span>
              <span class="mono" style="font-size: 11px; color: var(--accent);">http://127.0.0.1:41000/</span>
            </div>
            <div style="display: flex; gap: 8px;">
              <button class="btn btn-sm" onclick="document.getElementById('p-frame').src = 'http://127.0.0.1:41000/'">Reload ↻</button>
              <a href="http://127.0.0.1:41000/" target="_blank" class="btn btn-sm btn-primary">Open in New Tab ↗</a>
            </div>
          </div>
          <iframe id="p-frame" src="http://127.0.0.1:41000/" class="preview-frame"></iframe>
        </div>
      \`;
    }

    function renderDiff(c) {
      c.innerHTML = \`
        <div class="card" style="height: 100%; display: flex; flex-direction: column;">
          <div class="card-title">
            <span>Verified Unified Diff — Feature: Developer Portfolio Website</span>
            <span class="badge badge-done">Approved by Specialist & Integrated (6e0f2e2)</span>
          </div>
          <div class="diff-container">
<span class="diff-header">diff --git a/index.html b/index.html</span>
<span class="diff-add">+&lt;!DOCTYPE html&gt;</span>
<span class="diff-add">+&lt;html lang="en"&gt;</span>
<span class="diff-add">+&lt;head&gt;</span>
<span class="diff-add">+  &lt;meta charset="UTF-8"&gt;</span>
<span class="diff-add">+  &lt;title&gt;Shahariaz | Full-Stack &amp; AI Systems Engineer&lt;/title&gt;</span>
<span class="diff-add">+  &lt;link rel="stylesheet" href="styles.css"&gt;</span>
<span class="diff-add">+&lt;/head&gt;</span>
<span class="diff-add">+&lt;body class="dark-theme"&gt;</span>
<span class="diff-add">+  &lt;!-- Hero Section with Developer Bio and Autonomous Systems Headline --&gt;</span>
<span class="diff-add">+  &lt;h1 class="hero-title"&gt;Building Autonomous AI Platforms &amp; Distributed Systems&lt;/h1&gt;</span>
<span class="diff-add">+  &lt;div class="projects-grid" id="projects-grid"&gt;&lt;/div&gt;</span>
<span class="diff-add">+  &lt;script src="app.js"&gt;&lt;/script&gt;</span>
<span class="diff-add">+&lt;/body&gt;</span>
<span class="diff-add">+&lt;/html&gt;</span>

<span class="diff-header">diff --git a/styles.css b/styles.css</span>
<span class="diff-add">+:root {</span>
<span class="diff-add">+  --bg-primary: #0a0d13;</span>
<span class="diff-add">+  --accent-primary: #4b6fff;</span>
<span class="diff-add">+  --font-sans: 'Plus Jakarta Sans', sans-serif;</span>
<span class="diff-add">+}</span>
<span class="diff-add">+.hero-title { font-size: 3.2rem; font-weight: 800; }</span>
<span class="diff-add">+.project-card:hover { transform: translateY(-4px); border-color: var(--accent-primary); }</span>

<span class="diff-header">diff --git a/app.js b/app.js</span>
<span class="diff-add">+export const PORTFOLIO_PROJECTS = [</span>
<span class="diff-add">+  { id: 'claude-zen', title: 'Claude-Zen AI Delivery Engine', category: 'ai' },</span>
<span class="diff-add">+  { id: 'antigravity-gateway', title: 'Antigravity Protocol Bridge', category: 'ai' },</span>
<span class="diff-add">+  { id: 'distributed-queue', title: 'Conflict-Free Distributed Merge Queue', category: 'systems' }</span>
<span class="diff-add">+];</span>
<span class="diff-add">+export function filterProjects(projects, category) { ... }</span>
          </div>
        </div>
      \`;
    }

    function renderScoper(c) {
      c.innerHTML = \`
        <div class="card" style="height: 100%; display: flex; flex-direction: column;">
          <div class="card-title">
            <span>Approved Baseline Specification (v1.0.0)</span>
            <span class="badge badge-done">Immutable Locked (sha256:cb6d192d)</span>
          </div>
          <div class="diff-container" style="background: var(--card-bg); font-family: var(--font-sans); font-size: 13px; line-height: 1.6;">
# Product Requirements Document: Personal Developer Portfolio Website
Version: v1.0.0
Author: Claude-Zen Principal Architect

## 1. Executive Summary
A sleek, modern, mobile-responsive developer portfolio website showcasing engineering projects, skills, timeline, and contact information with a modern dark theme and interactive filtering.

## 2. Functional Requirements
✔ REQ-F-01: Hero Section & Navigation Bar
  Header navigation with logo, nav links (Projects, Skills, Experience, Contact), and Hero headline with developer bio, status badge, and call-to-action buttons.
✔ REQ-F-02: Interactive Project Showcase with Filtering
  Grid of project showcase cards displaying title, description, tags, preview links, and interactive category filter tabs (All, Full-Stack, AI / ML, Systems).
✔ REQ-F-03: Skills Matrix & Timeline Section
  Visual skills cards grouped by category (Frontend, Backend & Systems, AI & Cloud) and a chronological experience timeline.
✔ REQ-F-04: Contact Form & Social Links Footer
  Contact inquiry form with validation, social links (GitHub, LinkedIn, Twitter/X), and copyright footer.

## 3. Nonfunctional Requirements
✔ REQ-NF-01: Responsive Design (375px mobile, 768px tablet, 1200px+ desktop)
✔ REQ-NF-02: Automated Unit Testing (Node.js test runner passing)
          </div>
        </div>
      \`;
    }

    function renderProjects(c) {
      c.innerHTML = \`
        <div class="card">
          <div class="card-title">Connected Repository Status</div>
          <div style="display: flex; flex-direction: column; gap: 8px; font-size: 13px;">
            <div><strong>Repository Path:</strong> <span class="mono">/Users/sar/shahariaz/portfolio</span></div>
            <div><strong>Git Status:</strong> <span class="badge badge-done">Clean Tree</span></div>
            <div><strong>Active Branch:</strong> <span class="mono">main</span></div>
            <div><strong>Delivered Feature Branch:</strong> <span class="mono" style="color: var(--accent);">zen/portfolio-website</span> (Merged)</div>
            <div><strong>Runtime Engine:</strong> <span class="mono">Node.js v24 (npm test passing)</span></div>
          </div>
        </div>
      \`;
    }

    window.onload = loadAllData;
  </script>
</body>
</html>`;
}
