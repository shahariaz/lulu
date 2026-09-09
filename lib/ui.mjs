export function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
  <meta http-equiv="Pragma" content="no-cache">
  <meta http-equiv="Expires" content="0">
  <title>Claude-Zen | Operations & Failover Console</title>
  <style>
    :root {
      --bg: #090d13;
      --bg-surface: #0d1117;
      --card-bg: rgba(22, 27, 34, 0.85);
      --card-bg-hover: rgba(30, 37, 46, 0.95);
      --card-border: rgba(48, 54, 61, 0.7);
      --card-border-focus: rgba(88, 166, 255, 0.5);
      --accent: #58a6ff;
      --accent-glow: rgba(88, 166, 255, 0.15);
      --text: #f0f6fc;
      --text-muted: #8b949e;
      --text-subtle: #6e7681;
      --success: #3fb950;
      --success-glow: rgba(63, 185, 80, 0.2);
      --warning: #d29922;
      --warning-glow: rgba(210, 153, 34, 0.2);
      --danger: #f85149;
      --danger-glow: rgba(248, 81, 73, 0.2);
      --purple: #bc8cff;
      --purple-glow: rgba(188, 140, 255, 0.2);
      --cyan: #39c5cf;
      --cyan-glow: rgba(57, 197, 207, 0.2);
      --green: #238636;
      --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
      --sidebar-w: 220px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: radial-gradient(circle at 15% 15%, #131b26 0%, #090d13 100%);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.5;
      font-size: 14px;
      display: flex;
    }

    /* ── Sidebar Navigation ── */
    .sidebar {
      position: fixed;
      top: 0;
      left: 0;
      width: var(--sidebar-w);
      height: 100vh;
      background: rgba(13, 17, 23, 0.97);
      border-right: 1px solid var(--card-border);
      display: flex;
      flex-direction: column;
      z-index: 40;
      overflow-y: auto;
      overscroll-behavior: contain;
    }

    .sidebar-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 18px 16px 14px;
      border-bottom: 1px solid var(--card-border);
    }

    .sidebar-logo {
      width: 34px;
      height: 34px;
      background: linear-gradient(135deg, #58a6ff 0%, #bc8cff 50%, #39c5cf 100%);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 900;
      color: #090d13;
      font-size: 18px;
      flex-shrink: 0;
      box-shadow: 0 0 14px var(--accent-glow);
    }

    .sidebar-brand-text { min-width: 0; }
    .sidebar-brand-text strong { font-size: 14px; font-weight: 700; display: block; }
    .sidebar-brand-text span { font-size: 10px; color: var(--text-muted); }

    .sidebar-nav {
      flex: 1;
      padding: 10px 8px;
    }

    .sidebar-section-label {
      font-size: 10px;
      font-weight: 700;
      color: var(--text-subtle);
      letter-spacing: .07em;
      text-transform: uppercase;
      padding: 12px 8px 6px;
    }

    .nav-item {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 8px 10px;
      border-radius: 7px;
      color: var(--text-muted);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      background: transparent;
      width: 100%;
      text-align: left;
      transition: background .15s, color .15s;
      text-decoration: none;
    }
    .nav-item:hover { background: rgba(255,255,255,.05); color: var(--text); }
    .nav-item.active { background: rgba(88,166,255,.12); color: var(--accent); }
    .nav-item .nav-icon { font-size: 15px; width: 20px; text-align: center; flex-shrink: 0; }
    .nav-badge {
      margin-left: auto;
      background: rgba(88,166,255,.18);
      color: var(--accent);
      border-radius: 10px;
      font-size: 10px;
      font-weight: 700;
      padding: 1px 6px;
      min-width: 18px;
      text-align: center;
    }
    .nav-badge.warn { background: rgba(210,153,34,.18); color: var(--warning); }
    .nav-badge.danger { background: rgba(248,81,73,.18); color: var(--danger); }

    .sidebar-footer {
      padding: 12px 8px;
      border-top: 1px solid var(--card-border);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    /* Sidebar toggle (mobile) */
    .sidebar-toggle {
      display: none;
      position: fixed;
      top: 12px;
      left: 12px;
      z-index: 60;
      background: #21262d;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 7px 10px;
      font-size: 18px;
      cursor: pointer;
      line-height: 1;
      color: var(--text);
      transition: left .22s ease, background .15s;
    }
    .sidebar-toggle.open { left: 174px; }

    .sidebar-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.55);
      z-index: 35;
    }

    /* ── Main content ── */
    .main-wrap {
      margin-left: var(--sidebar-w);
      flex: 1;
      min-width: 0;
      padding: 24px 20px 48px;
    }

    .container { max-width: 1220px; margin: 0 auto; }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 18px;
      flex-wrap: wrap;
      gap: 12px;
    }

    .page-title {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.3px;
    }
    .page-subtitle { color: var(--text-muted); font-size: 12px; margin-top: 2px; }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .gateways-status {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .gw-pill {
      display: flex;
      align-items: center;
      gap: 8px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 500;
      transition: all 0.2s;
    }
    .gw-pill:hover { border-color: var(--text-muted); }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
      animation: pulse-green 2.5s infinite;
    }
    .dot.down { background: var(--danger); box-shadow: 0 0 8px var(--danger); animation: none; }
    .dot.warn { background: var(--warning); box-shadow: 0 0 8px var(--warning); animation: none; }

    @keyframes pulse-green {
      0% { box-shadow: 0 0 0 0 var(--success-glow); }
      70% { box-shadow: 0 0 0 6px rgba(63, 185, 80, 0); }
      100% { box-shadow: 0 0 0 0 rgba(63, 185, 80, 0); }
    }

    /* Live Failover Alert Banner */
    .failover-banner {
      background: rgba(22, 27, 34, 0.95);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 12px 18px;
      margin-bottom: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .failover-banner.healthy { border-left: 4px solid var(--success); }
    .failover-banner.warning { border-left: 4px solid var(--warning); background: rgba(210, 153, 34, 0.08); }
    .failover-banner.danger { border-left: 4px solid var(--danger); background: rgba(248, 81, 73, 0.08); }

    .banner-content { display: flex; align-items: center; gap: 10px; font-size: 13px; }
    .banner-actions { display: flex; gap: 8px; align-items: center; min-width: 0; max-width: 100%; }
    .banner-title { font-weight: 600; }
    .banner-meta { color: var(--text-muted); font-size: 12px; }

    /* Top Stats Grid */
    .grid-4 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
      margin-bottom: 20px;
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 18px 20px;
      backdrop-filter: blur(10px);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
      transition: border-color 0.2s, transform 0.2s;
    }
    .card:hover { border-color: rgba(88, 166, 255, 0.35); }

    .card-title {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.6px;
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 600;
    }

    .stat-val {
      font-size: 26px;
      font-weight: 700;
      color: var(--text);
      font-family: var(--font-mono);
      letter-spacing: -0.5px;
    }

    .stat-sub {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 6px;
      display: flex;
      justify-content: space-between;
    }

    /* Section Headers */
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
      flex-wrap: wrap;
      gap: 10px;
    }

    .section-header h2 {
      font-size: 15px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .tabs {
      display: flex;
      gap: 6px;
      background: #090d13;
      padding: 4px;
      border-radius: 8px;
      border: 1px solid var(--card-border);
    }

    .tab-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 5px 12px;
      font-size: 12px;
      font-weight: 500;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .tab-btn.active {
      background: #21262d;
      color: var(--text);
      font-weight: 600;
    }
    .tab-btn:hover:not(.active) { color: var(--text); }

    /* Buttons */
    .btn {
      background: #21262d;
      color: var(--text);
      border: 1px solid var(--card-border);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
      user-select: none;
    }
    .btn:hover { background: #30363d; border-color: var(--accent); }
    .btn:active { transform: translateY(1px); }
    .btn-primary { background: #238636; border-color: rgba(240, 246, 252, 0.1); color: #fff; }
    .btn-primary:hover { background: #2ea043; border-color: #2ea043; }
    .btn-danger { background: rgba(248, 81, 73, 0.1); color: var(--danger); border-color: rgba(248, 81, 73, 0.3); }
    .btn-danger:hover { background: var(--danger); color: #fff; }
    .btn-outline { background: transparent; }
    .btn-sm { padding: 4px 8px; font-size: 11px; }

    /* Tables */
    .table-wrapper {
      width: 100%;
      overflow-x: auto;
      border-radius: 8px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      text-align: left;
    }

    th {
      padding: 10px 12px;
      color: var(--text-muted);
      border-bottom: 1px solid var(--card-border);
      font-weight: 500;
      font-size: 12px;
      background: rgba(13, 17, 23, 0.6);
      white-space: nowrap;
    }

    td {
      padding: 12px;
      border-bottom: 1px solid rgba(48, 54, 61, 0.35);
      vertical-align: middle;
    }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }

    /* Badges */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
    }
    .badge-success { background: rgba(63, 185, 80, 0.15); color: var(--success); border: 1px solid rgba(63, 185, 80, 0.3); }
    .badge-warning { background: rgba(210, 153, 34, 0.15); color: var(--warning); border: 1px solid rgba(210, 153, 34, 0.3); }
    .badge-danger { background: rgba(248, 81, 73, 0.15); color: var(--danger); border: 1px solid rgba(248, 81, 73, 0.3); }
    .badge-purple { background: rgba(188, 140, 255, 0.15); color: var(--purple); border: 1px solid rgba(188, 140, 255, 0.3); }
    .badge-blue { background: rgba(88, 166, 255, 0.15); color: var(--accent); border: 1px solid rgba(88, 166, 255, 0.3); }
    .badge-cyan { background: rgba(57, 197, 207, 0.15); color: var(--cyan); border: 1px solid rgba(57, 197, 207, 0.3); }
    .badge-gray { background: rgba(110, 118, 129, 0.15); color: var(--text-muted); border: 1px solid rgba(110, 118, 129, 0.3); }

    /* Countdown & Ticker Styling */
    .cooldown-cell {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .countdown-timer {
      font-family: var(--font-mono);
      font-weight: 700;
      color: var(--warning);
      font-size: 13px;
    }
    .reset-clock {
      font-size: 11px;
      color: var(--text-muted);
    }
    .cooldown-source {
      font-size: 10px;
      color: var(--text-subtle);
    }

    /* Model Limits Sub-tags */
    .model-limits-box {
      margin-top: 6px;
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .model-limit-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-family: var(--font-mono);
      background: #090d13;
      border: 1px solid var(--card-border);
    }
    .model-limit-chip.limited {
      border-color: var(--warning);
      color: var(--warning);
    }
    .model-limit-chip.ready {
      border-color: var(--success);
      color: var(--success);
    }
    .quota-account-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
      gap: 16px;
    }
    .quota-account-card { margin: 0; min-width: 0; }
    .quota-model-row {
      display: grid;
      grid-template-columns: minmax(150px, 1fr) 90px 110px;
      gap: 10px;
      align-items: center;
      padding: 8px 0;
      border-top: 1px solid var(--card-border);
      font-size: 11px;
    }
    .quota-meter { height: 6px; border-radius: 99px; overflow: hidden; background: #090d13; }
    .quota-meter > span { display: block; height: 100%; background: var(--success); border-radius: inherit; }
    .quota-meter > span.low { background: var(--warning); }
    .quota-meter > span.empty { background: var(--danger); }
    @media (max-width: 600px) {
      .quota-account-grid { grid-template-columns: 1fr; }
      .quota-model-row { grid-template-columns: 1fr 70px; }
      .quota-model-row .quota-reset { grid-column: 1 / -1; }
    }

    /* Layout Grids */
    .grid-main {
      display: grid;
      grid-template-columns: 1fr 340px;
      gap: 20px;
      margin-bottom: 24px;
    }

    @media (max-width: 960px) {
      .grid-main { grid-template-columns: 1fr; }
    }

    /* Dashboard sections — toggled by sidebar nav */
    .dash-section { display: none; }
    .dash-section.active { display: block; }

    /* Pagination controls */
    .pagination-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 0 0;
      flex-wrap: wrap;
    }
    .pagination-info {
      flex: 1;
      font-size: 12px;
      color: var(--text-muted);
    }
    .btn-page {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: #21262d;
      color: var(--text);
      border: 1px solid var(--card-border);
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.18s;
      user-select: none;
    }
    .btn-page:hover:not(:disabled) { background: #30363d; border-color: var(--accent); }
    .btn-page:disabled { opacity: 0.38; cursor: default; }
    .btn-page:active:not(:disabled) { transform: translateY(1px); }

    /* Progress & Breakdown Bars */
    .progress-bar-container { margin-bottom: 12px; }
    .progress-labels {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      margin-bottom: 4px;
    }
    .progress-bg {
      height: 6px;
      background: #21262d;
      border-radius: 4px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #58a6ff, #bc8cff);
      border-radius: 4px;
      transition: width 0.3s ease;
    }
    .progress-fill.cyan { background: linear-gradient(90deg, #39c5cf, #58a6ff); }

    /* Lifetime analytics */
    .analytics-heading-copy p, .metric-note {
      color: var(--text-muted);
      font-size: 12px;
      margin-top: 4px;
    }
    .leader-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 14px;
      margin-bottom: 20px;
    }
    .leader-card {
      min-width: 0;
      border-left: 3px solid var(--accent);
    }
    .leader-card:nth-child(2) { border-left-color: var(--purple); }
    .leader-card:nth-child(3) { border-left-color: var(--cyan); }
    .leader-card:nth-child(4) { border-left-color: var(--success); }
    .leader-name {
      font-size: 14px;
      font-weight: 650;
      overflow-wrap: anywhere;
    }
    .leader-metrics {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 10px;
    }
    .analytics-table td:first-child { min-width: 210px; }
    .analytics-table .rank { color: var(--text-muted); width: 30px; }
    .analytics-table .entity-meta { color: var(--text-muted); font-size: 11px; margin-top: 3px; }
    .score-value { font-weight: 700; color: var(--success); }
    .analytics-table-empty { color: var(--text-muted); text-align: center; padding: 24px; }

    /* Sparkline & Charts */
    .sparkline-container {
      display: flex;
      align-items: flex-end;
      gap: 6px;
      height: 64px;
      padding-top: 10px;
      margin-top: 8px;
    }
    .spark-bar-wrap {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      height: 100%;
      justify-content: flex-end;
      position: relative;
    }
    .spark-bar {
      width: 100%;
      min-height: 4px;
      background: #58a6ff;
      border-radius: 3px 3px 0 0;
      transition: all 0.2s;
      opacity: 0.85;
    }
    .spark-bar:hover { opacity: 1; background: #bc8cff; }
    .spark-label {
      font-size: 10px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    .mono { font-family: var(--font-mono); }

    /* Filter Toolbar */
    .filter-toolbar {
      display: flex;
      gap: 10px;
      margin-bottom: 14px;
      flex-wrap: wrap;
    }
    .filter-input {
      background: #090d13;
      border: 1px solid var(--card-border);
      border-radius: 6px;
      color: var(--text);
      padding: 6px 12px;
      font-size: 12px;
      outline: none;
    }
    .filter-input:focus { border-color: var(--accent); }

    /* Modal */
    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.8);
      backdrop-filter: blur(4px);
      z-index: 100;
      align-items: center;
      justify-content: center;
    }
    .modal-overlay.open { display: flex; }
    .modal {
      background: #161b22;
      border: 1px solid var(--card-border);
      border-radius: 12px;
      width: 560px;
      max-width: 92vw;
      padding: 24px;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.6);
    }
    .modal h3 { margin-bottom: 14px; font-size: 18px; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 6px; font-weight: 500; }
    .form-control {
      width: 100%;
      background: #090d13;
      border: 1px solid var(--card-border);
      padding: 8px 12px;
      border-radius: 6px;
      color: var(--text);
      font-size: 13px;
    }
    .form-control:focus { outline: none; border-color: var(--accent); }
    textarea.form-control { resize: vertical; min-height: 100px; font-family: var(--font-mono); font-size: 11px; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }

    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #21262d;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 12px 18px;
      font-size: 13px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
      display: none;
      z-index: 200;
    }

    /* Privacy Mask */
    .privacy-mask {
      font-family: var(--font-mono);
      letter-spacing: 1px;
    }

    .pulse-indicator {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--success);
      margin-right: 6px;
      animation: pulse-green 2s infinite;
    }

    /* Tooltip */
    [data-tooltip] { position: relative; cursor: help; }
    [data-tooltip]::after {
      content: attr(data-tooltip);
      position: absolute;
      bottom: 125%;
      left: 50%;
      transform: translateX(-50%);
      background: #21262d;
      color: #fff;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      white-space: nowrap;
      display: none;
      z-index: 50;
      border: 1px solid var(--card-border);
      pointer-events: none;
    }
    [data-tooltip]:hover::after { display: block; }

    [hidden] { display: none !important; }
    :focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 3px;
    }
    .skip-link {
      position: fixed;
      top: 10px;
      left: 10px;
      z-index: 300;
      transform: translateY(-160%);
      background: var(--accent);
      color: #07111d;
      padding: 8px 12px;
      border-radius: 6px;
      font-weight: 700;
    }
    .skip-link:focus { transform: translateY(0); }
    .dashboard-error {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 20px;
      padding: 12px 16px;
      border: 1px solid rgba(248, 81, 73, 0.45);
      border-left: 4px solid var(--danger);
      border-radius: 10px;
      background: rgba(248, 81, 73, 0.09);
      color: #ffd8d5;
    }
    .dashboard-error strong { display: block; margin-bottom: 2px; }
    .dashboard-error span { color: var(--text-muted); font-size: 12px; }
    .activity-card { min-width: 0; }
    .activity-heading-copy { min-width: 220px; }
    .activity-heading-copy p {
      color: var(--text-muted);
      font-size: 12px;
      margin-top: 4px;
    }
    .activity-toolbar {
      display: grid;
      grid-template-columns: minmax(220px, 1.6fr) repeat(3, minmax(130px, .7fr)) auto;
      gap: 9px;
      margin-bottom: 12px;
    }
    .filter-field { min-width: 0; }
    .filter-field label {
      display: block;
      color: var(--text-muted);
      font-size: 10px;
      font-weight: 650;
      letter-spacing: .06em;
      margin: 0 0 5px 2px;
      text-transform: uppercase;
    }
    .filter-field .filter-input { width: 100%; height: 36px; }
    .filter-action { align-self: end; height: 36px; }
    .activity-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: var(--text-muted);
      font-size: 11px;
      min-height: 24px;
      margin-bottom: 8px;
    }
    .activity-list {
      display: grid;
      gap: 8px;
    }
    .activity-item {
      display: grid;
      grid-template-columns: minmax(205px, 1.35fr) minmax(145px, 1fr) minmax(145px, .85fr) minmax(132px, .7fr);
      gap: 14px;
      align-items: center;
      padding: 13px 14px;
      border: 1px solid rgba(48, 54, 61, .72);
      border-left: 3px solid var(--success);
      border-radius: 10px;
      background: rgba(13, 17, 23, .58);
      transition: background .16s, border-color .16s;
    }
    .activity-item:hover {
      background: rgba(30, 37, 46, .72);
      border-color: rgba(88, 166, 255, .35);
    }
    .activity-item.status-rate_limited { border-left-color: var(--warning); }
    .activity-item.status-error { border-left-color: var(--danger); }
    .activity-primary, .activity-diagnostic { min-width: 0; }
    .activity-primary-top, .activity-status-line, .activity-token-line {
      display: flex;
      gap: 7px;
      align-items: center;
      flex-wrap: wrap;
    }
    .activity-model {
      color: var(--text);
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    .activity-account, .activity-time, .activity-label {
      color: var(--text-muted);
      font-size: 11px;
    }
    .activity-account { margin-top: 5px; overflow-wrap: anywhere; }
    .activity-label {
      display: block;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: .08em;
      margin-bottom: 4px;
      text-transform: uppercase;
    }
    .activity-value { font-size: 12px; color: var(--text); }
    .activity-token-line { font-family: var(--font-mono); font-size: 11px; }
    .token-total { color: var(--text); font-weight: 700; }
    .token-split { color: var(--text-muted); }
    .tool-list {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
      margin-top: 5px;
    }
    .tool-chip {
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
      padding: 2px 6px;
      border: 1px solid rgba(57, 197, 207, .32);
      border-radius: 5px;
      color: var(--cyan);
      background: rgba(57, 197, 207, .08);
      font-family: var(--font-mono);
      font-size: 10px;
      white-space: nowrap;
    }
    .activity-error {
      grid-column: 1 / -1;
      border-top: 1px solid rgba(248, 81, 73, .2);
      padding-top: 9px;
      color: #ffb9b4;
      font-size: 11px;
      overflow-wrap: anywhere;
    }
    .activity-error summary {
      color: var(--danger);
      cursor: pointer;
      font-weight: 600;
    }
    .activity-error pre {
      margin-top: 7px;
      color: #ffcfcc;
      font: inherit;
      white-space: pre-wrap;
    }
    .state-panel {
      min-height: 180px;
      display: grid;
      place-items: center;
      padding: 28px;
      border: 1px dashed var(--card-border);
      border-radius: 10px;
      color: var(--text-muted);
      text-align: center;
    }
    .state-panel strong { display: block; color: var(--text); margin-bottom: 5px; }
    .state-panel.error { border-color: rgba(248, 81, 73, .45); color: #ffb9b4; }
    .skeleton-list { display: grid; gap: 9px; width: 100%; }
    .skeleton-row {
      height: 62px;
      border-radius: 9px;
      background: linear-gradient(90deg, rgba(33,38,45,.65), rgba(48,54,61,.8), rgba(33,38,45,.65));
      background-size: 220% 100%;
      animation: shimmer 1.4s infinite linear;
    }
    @keyframes shimmer { to { background-position: -220% 0; } }

    @media (max-width: 1180px) {
      .activity-toolbar { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .filter-action { width: 100%; }
      .activity-item { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 800px) {
      :root { --sidebar-w: 0px; }
      .sidebar { transform: translateX(-220px); transition: transform .22s ease; width: 220px; }
      .sidebar.open { transform: translateX(0); }
      .sidebar-toggle { display: flex; }
      .sidebar-overlay.open { display: block; }
      .main-wrap { margin-left: 0; padding: 14px 12px 36px; padding-top: 56px; }
      header { align-items: flex-start; }
      .header-actions, .gateways-status { width: 100%; }
      .gw-pill { flex: 1 1 150px; justify-content: center; }
      .grid-4 { grid-template-columns: 1fr; }
      .card { padding: 15px; border-radius: 10px; }
      .stat-val { font-size: 23px; }
      .activity-toolbar { grid-template-columns: 1fr; }
      .activity-item { grid-template-columns: 1fr; gap: 10px; }
      .activity-error { grid-column: 1; }
      .activity-meta { align-items: flex-start; flex-direction: column; }
      .tabs { width: 100%; overflow-x: auto; }
      .tab-btn { flex: 0 0 auto; }
      .failover-banner { align-items: flex-start; }
      .banner-actions { width: 100%; flex-wrap: wrap; }
      .banner-actions .badge { max-width: 100%; overflow-wrap: anywhere; }
      .modal { max-height: 92vh; overflow-y: auto; padding: 18px; }
      [data-tooltip]::after { display: none !important; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: .01ms !important;
        animation-iteration-count: 1 !important;
        scroll-behavior: auto !important;
      }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to dashboard content</a>

  <!-- Mobile sidebar toggle -->
  <button class="sidebar-toggle" id="sidebar-toggle" aria-label="Open navigation" aria-expanded="false" aria-controls="sidebar" onclick="toggleSidebar()">☰</button>
  <div class="sidebar-overlay" id="sidebar-overlay" onclick="closeSidebar()"></div>

  <!-- Sidebar Navigation -->
  <nav class="sidebar" id="sidebar" aria-label="Dashboard navigation">
    <div class="sidebar-brand">
      <div class="sidebar-logo">Z</div>
      <div class="sidebar-brand-text">
        <strong>Claude-Zen</strong>
        <span>v2.0 Gateway</span>
      </div>
    </div>
    <div class="sidebar-nav">
      <div class="sidebar-section-label">Monitor</div>
      <button class="nav-item active" data-section="overview" onclick="showSection('overview', this)" aria-current="page">
        <span class="nav-icon">📊</span> Overview
      </button>
      <button class="nav-item" data-section="activity" onclick="showSection('activity', this)">
        <span class="nav-icon">🔄</span> Activity Feed
        <span class="nav-badge" id="nav-badge-activity">—</span>
      </button>
      <button class="nav-item" data-section="analytics" onclick="showSection('analytics', this)">
        <span class="nav-icon">📈</span> Analytics
      </button>
      <div class="sidebar-section-label">Manage</div>
      <button class="nav-item" data-section="accounts" onclick="showSection('accounts', this)">
        <span class="nav-icon">👥</span> Account Pools
        <span class="nav-badge" id="nav-badge-limited"></span>
      </button>
      <button class="nav-item" data-section="quotas" onclick="showSection('quotas', this)">
        <span class="nav-icon">🧭</span> Model Quotas
        <span class="nav-badge" id="nav-badge-quotas">—</span>
      </button>
      <button class="nav-item" data-section="routing" onclick="showSection('routing', this)">
        <span class="nav-icon">⚡</span> Routing Profiles
      </button>
      <button class="nav-item" data-section="ratelimits" onclick="showSection('ratelimits', this)">
        <span class="nav-icon">🚦</span> Rate Limits
        <span class="nav-badge warn" id="nav-badge-rle" style="display:none"></span>
      </button>
    </div>
    <div class="sidebar-footer">
      <button class="nav-item" onclick="exportData('csv')" style="font-size:12px;">
        <span class="nav-icon">📥</span> Export CSV
      </button>
      <button class="nav-item" onclick="exportData('json')" style="font-size:12px;">
        <span class="nav-icon">📥</span> Export JSON
      </button>
    </div>
  </nav>

  <div class="main-wrap">
  <main class="container" id="main-content">
    <header>
      <div>
        <div class="page-title" id="page-title">Overview</div>
        <div class="page-subtitle" id="page-subtitle">Multi-Provider AI Failover &amp; Operations Console</div>
      </div>

      <div class="header-actions">
        <div class="gateways-status">
          <div class="gw-pill" id="gw-codex" data-tooltip="OpenAI ChatGPT Plus Gateway">
            <div class="dot" id="dot-codex"></div>
            <span>Codex (ChatGPT): :8789</span>
          </div>
          <div class="gw-pill" id="gw-agw" data-tooltip="Google Antigravity Gateway">
            <div class="dot" id="dot-agw"></div>
            <span>Antigravity (Gemini): :8788</span>
          </div>
          <div class="gw-pill" id="gw-zen" data-tooltip="OpenCode Zen Primary Bridge">
            <div class="dot" id="dot-zen"></div>
            <span>Zen Proxy: :8787</span>
          </div>
        </div>

        <button class="btn btn-outline" id="btn-privacy" onclick="togglePrivacy()" title="Mask emails for screenshots">
          <span id="privacy-icon">👁️</span> Privacy Mode: <strong id="privacy-state">OFF</strong>
        </button>

        <select class="filter-input" id="refresh-rate" aria-label="Dashboard refresh interval" onchange="changeRefreshRate(this.value)" style="cursor: pointer;">
          <option value="3000">⚡ Live (3s)</option>
          <option value="5000">Auto (5s)</option>
          <option value="10000">Slow (10s)</option>
          <option value="0">Paused</option>
        </select>
      </div>
    </header>

    <div class="dashboard-error" id="dashboard-error" role="alert" hidden>
      <div><strong>Some dashboard data could not be refreshed.</strong><span id="dashboard-error-detail"></span></div>
      <button class="btn btn-sm" type="button" onclick="fetchData()">Retry</button>
    </div>

    <!-- Failover Live Banner (always visible) -->
    <div class="failover-banner healthy" id="pool-banner">
      <div class="banner-content">
        <span id="banner-icon" style="font-size: 16px;">🟢</span>
        <div>
          <span class="banner-title" id="banner-title">Pool Status: Fully Operational</span>
          <span class="banner-meta" id="banner-meta">— All accounts ready to serve requests without cooldowns.</span>
        </div>
      </div>
      <div class="banner-actions">
        <span class="badge badge-cyan" id="banner-next-account">Next route: loading account data</span>
        <button class="btn btn-sm" onclick="syncAccounts()">🔄 Probe &amp; Sync</button>
      </div>
    </div>

    <!-- ══ SECTION: Overview ══ -->
    <div class="dash-section active" id="section-overview">

    <!-- Top Stats Row (KPIs) -->
    <div class="grid-4">
      <div class="card">
        <div class="card-title">
          <span>Today's Token Throughput</span>
          <span class="badge badge-blue">Today</span>
        </div>
        <div class="stat-val" id="stat-today-tokens">-</div>
        <div class="stat-sub">
          <span id="stat-today-in">In: 0</span>
          <span id="stat-today-out">Out: 0</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>Account Pool Capacity</span>
          <span class="badge badge-success" id="stat-avail-badge">Available</span>
        </div>
        <div class="stat-val" id="stat-accounts-active">-</div>
        <div class="stat-sub">
          <span id="stat-accounts-limited">0 cooling down</span>
          <span id="stat-accounts-next-reset">Next reset: -</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>Reliability & Success Rate</span>
          <span class="badge badge-purple" id="stat-success-badge">100%</span>
        </div>
        <div class="stat-val" id="stat-success-rate">100%</div>
        <div class="stat-sub">
          <span id="stat-total-turns">0 turns today</span>
          <span id="stat-rle-count">0 rate-limits (24h)</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>Latency & Duration</span>
          <span class="badge badge-gray">Turn Speed</span>
        </div>
        <div class="stat-val" id="stat-avg-latency">-</div>
        <div class="stat-sub">
          <span id="stat-p50-latency">p50: -</span>
          <span id="stat-p95-latency">p95: -</span>
        </div>
      </div>
    </div>

    <!-- 7-Day Overview Trend Snapshot -->
    <div class="card" style="margin-bottom: 20px;">
      <div class="section-header">
        <h2>7-Day Activity Trend</h2>
        <button class="btn btn-sm" onclick="showSection('analytics', document.querySelector('[data-section=analytics]'))">Full Analytics →</button>
      </div>
      <div class="sparkline-container" id="sparkline-7d"></div>
    </div>

    </div><!-- /#section-overview -->

    <!-- ══ SECTION: Activity Feed ══ -->
    <div class="dash-section" id="section-activity">
    <section class="card activity-card" aria-labelledby="activity-title">
        <div class="section-header">
          <div class="activity-heading-copy">
            <h2 id="activity-title">Recent Activity Feed & Diagnostics</h2>
            <p>Real provider turns only — inspect routing, reasoning, tools, tokens, latency, and failures.</p>
          </div>
          <button class="btn btn-sm" type="button" id="activity-refresh-btn" onclick="refreshActivity()">↻ Refresh</button>
        </div>

        <div class="activity-toolbar" role="search" aria-label="Filter recent activity">
          <div class="filter-field">
            <label for="req-search">Search diagnostics</label>
            <input type="search" class="filter-input" id="req-search" placeholder="Model, account, tool, or error" oninput="debounceFetch()">
          </div>
          <div class="filter-field">
            <label for="req-provider-filter">Provider</label>
            <select class="filter-input" id="req-provider-filter" onchange="resetActivityPage(); fetchData()">
              <option value="all">All providers</option>
              <option value="codex">Codex</option>
              <option value="antigravity">Antigravity</option>
              <option value="zen">Zen / OpenCode</option>
            </select>
          </div>
          <div class="filter-field">
            <label for="req-model-filter">Model</label>
            <select class="filter-input" id="req-model-filter" onchange="resetActivityPage(); fetchData()">
              <option value="all">All models</option>
            </select>
          </div>
          <div class="filter-field">
            <label for="req-status-filter">Status</label>
            <select class="filter-input" id="req-status-filter" onchange="resetActivityPage(); fetchData()">
              <option value="all">All statuses</option>
              <option value="success">Successful</option>
              <option value="rate_limited">Rate limited</option>
              <option value="error">Errors</option>
            </select>
          </div>
          <button class="btn filter-action" type="button" onclick="clearActivityFilters()">Clear filters</button>
        </div>

        <div class="activity-meta">
          <span id="activity-summary" aria-live="polite">Loading activity…</span>
          <span id="activity-updated"></span>
        </div>
        <div class="state-panel" id="activity-state" role="status" aria-live="polite">
          <div class="skeleton-list" aria-label="Loading recent activity">
            <div class="skeleton-row"></div>
            <div class="skeleton-row"></div>
            <div class="skeleton-row"></div>
          </div>
        </div>
        <div class="activity-list" id="requests-list" role="feed" aria-label="Recent provider activity" hidden></div>

        <!-- Stable cursor pagination controls -->
        <nav class="pagination-bar" aria-label="Activity pagination" id="pagination-bar" hidden>
          <span class="pagination-info" id="pagination-info" aria-live="polite"></span>
          <button class="btn-page" id="btn-prev-page" onclick="goActivityPage('prev')" disabled aria-label="Previous page">← Previous</button>
          <button class="btn-page" id="btn-next-page" onclick="goActivityPage('next')" disabled aria-label="Next page">Next →</button>
        </nav>
      </section>
    </div><!-- /#section-activity -->

    <!-- ══ SECTION: Analytics ══ -->
    <div class="dash-section" id="section-analytics">
      <div class="section-header">
        <div class="analytics-heading-copy">
          <h2>Lifetime Intelligence</h2>
          <p>Canonical provider turns only. Historical Antigravity proxy duplicates are excluded.</p>
        </div>
      </div>
      <div class="grid-4" aria-label="Lifetime usage summary">
        <div class="card"><div class="card-title">Lifetime Tokens <span>∑</span></div><div class="stat-val" id="lifetime-total-tokens">0</div><div class="stat-sub"><span id="lifetime-token-split">In 0 · Out 0</span><span id="lifetime-reasoning">0 reasoning</span></div></div>
        <div class="card"><div class="card-title">Provider Turns <span>↗</span></div><div class="stat-val" id="lifetime-total-turns">0</div><div class="stat-sub"><span id="lifetime-success-count">0 successful</span><span id="lifetime-tool-turns">0 with tools</span></div></div>
        <div class="card"><div class="card-title">Lifetime Reliability <span>✓</span></div><div class="stat-val" id="lifetime-success-rate">100%</div><div class="stat-sub"><span id="lifetime-failures">0 failed</span><span id="lifetime-rate-limits">0 limited</span></div></div>
        <div class="card"><div class="card-title">Operating History <span>◷</span></div><div class="stat-val" id="lifetime-active-days">0 days</div><div class="stat-sub"><span id="lifetime-first-seen">No activity</span><span id="lifetime-last-seen">Never</span></div></div>
      </div>

      <div class="leader-grid" aria-label="Performance leaders">
        <div class="card leader-card"><div class="card-title">Best Account</div><div id="leader-best-account"><div class="leader-name">Not enough data</div></div></div>
        <div class="card leader-card"><div class="card-title">Best Model</div><div id="leader-best-model"><div class="leader-name">Not enough data</div></div></div>
        <div class="card leader-card"><div class="card-title">Most Used Model</div><div id="leader-most-used-model"><div class="leader-name">No activity</div></div></div>
        <div class="card leader-card"><div class="card-title">Top Provider</div><div id="leader-top-provider"><div class="leader-name">No activity</div></div></div>
      </div>

      <div class="card" style="margin-bottom: 20px;">
        <div class="section-header"><div><h2>7-Day Activity Trend</h2><div class="metric-note" id="lifetime-latency-summary">Latency: no data</div></div></div>
        <div class="sparkline-container" id="sparkline-7d-full"></div>
      </div>

      <div class="card" style="margin-bottom: 20px;">
        <div class="section-header"><div><h2>Account Performance</h2><div class="metric-note">Score requires 5 turns · reliability 70% · latency 20% · sample confidence 10%</div></div></div>
        <div class="table-wrapper"><table class="analytics-table" aria-label="Account performance ranking"><thead><tr><th>#</th><th>Account</th><th>Score</th><th>Success</th><th>Turns</th><th>Tokens</th><th>Avg latency</th><th>Last used</th></tr></thead><tbody id="account-performance-table"><tr><td colspan="8" class="analytics-table-empty">No account performance data yet.</td></tr></tbody></table></div>
      </div>

      <div class="card" style="margin-bottom: 20px;">
        <div class="section-header"><div><h2>Model Performance</h2><div class="metric-note">Performance, utilization and reliability across every routed model.</div></div></div>
        <div class="table-wrapper"><table class="analytics-table" aria-label="Model performance ranking"><thead><tr><th>#</th><th>Model</th><th>Score</th><th>Success</th><th>Turns</th><th>Tokens</th><th>Avg latency</th><th>Last used</th></tr></thead><tbody id="model-performance-table"><tr><td colspan="8" class="analytics-table-empty">No model performance data yet.</td></tr></tbody></table></div>
      </div>
    </div><!-- /#section-analytics -->

    <!-- ══ SECTION: Routing Profiles ══ -->
    <div class="dash-section" id="section-routing">
    <!-- Runtime Routing Profiles -->
    <div class="card" style="margin-bottom: 24px;">
      <div class="section-header">
        <div>
          <h2>Runtime Model Profiles</h2>
          <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">Switch Opus, Sonnet and Haiku routes instantly. In-flight tool turns stay pinned to their original model.</div>
        </div>
        <button class="btn btn-primary" onclick="openProfileModal()">+ Create Profile</button>
      </div>
      <div id="routing-profiles" class="grid-4">
        <div style="color: var(--text-muted); font-size: 12px;">Loading routing profiles...</div>
      </div>
    </div>
    </div><!-- /#section-routing -->

    <!-- ══ SECTION: Account Pools ══ -->
    <div class="dash-section" id="section-accounts">
    <!-- Unified Accounts Pool Section -->
    <div class="card" style="margin-bottom: 24px;">
      <div class="section-header">
        <div>
          <h2>Account Pools & Dynamic Failover</h2>
        </div>
        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
          <div class="tabs" role="tablist" aria-label="Filter account pools">
            <button class="tab-btn active" role="tab" aria-selected="true" onclick="setTab('all', this)">All (<span id="count-all">0</span>)</button>
            <button class="tab-btn" role="tab" aria-selected="false" onclick="setTab('codex', this)">ChatGPT Plus (<span id="count-codex">0</span>)</button>
            <button class="tab-btn" role="tab" aria-selected="false" onclick="setTab('antigravity', this)">Google Antigravity (<span id="count-agw">0</span>)</button>
            <button class="tab-btn" role="tab" aria-selected="false" onclick="setTab('zen', this)">OpenCode Zen (<span id="count-zen">0</span>)</button>
            <button class="tab-btn" role="tab" aria-selected="false" onclick="setTab('qwen', this)">Qwen Chat (<span id="count-qwen">0</span>)</button>
            <button class="tab-btn" role="tab" aria-selected="false" onclick="setTab('limited', this)">Cooling Down (<span id="count-limited">0</span>)</button>
          </div>
          <button class="btn" onclick="resetRateLimits()" title="Clear all local rate-limit cooldown timers">⚡ Clear Local Cooldowns</button>
          <button class="btn btn-primary" onclick="openAddModal()">+ Add Account</button>
        </div>
      </div>

      <div class="table-wrapper" role="region" aria-label="Account pool table" tabindex="0">
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Account / Identity</th>
              <th>Type / Plan</th>
              <th>Status</th>
              <th>Rate Limit Cooldown & Reset Time</th>
              <th>Last Used</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="accounts-table-body">
            <tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 24px;">Loading accounts pool...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
    </div><!-- /#section-accounts -->

    <!-- ══ SECTION: Model Quotas ══ -->
    <div class="dash-section" id="section-quotas">
      <div class="section-header">
        <div>
          <h2>Antigravity Model Quotas</h2>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Live remaining allowance and reset time for every Google account.</div>
        </div>
        <button class="btn" onclick="fetchData()">↻ Refresh Quotas</button>
      </div>
      <div class="quota-account-grid" id="quota-account-grid">
        <div class="card">Loading model quotas…</div>
      </div>
    </div><!-- /#section-quotas -->

    <!-- ══ SECTION: Rate Limits ══ -->
    <div class="dash-section" id="section-ratelimits">
    <!-- Recent Rate Limit Events Log -->
    <div class="card" style="margin-bottom: 24px;">
      <div class="section-header">
        <h2>Recent Rate-Limit Incidents & Cooldown History</h2>
        <span class="badge badge-gray" id="rle-total-badge">Last 30 Events</span>
      </div>
      <div class="table-wrapper" role="region" aria-label="Rate-limit incident table" tabindex="0">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Provider</th>
              <th>Account</th>
              <th>Model</th>
              <th>Cooldown</th>
              <th>Reported Reason / Error</th>
            </tr>
          </thead>
          <tbody id="rate-limits-table-body">
            <tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 18px;">No rate-limit incidents recorded.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
    </div><!-- /#section-ratelimits -->

  </main>
  </div><!-- /.main-wrap -->

  <!-- Add Account Modal -->
  <div class="modal-overlay" id="add-modal" role="dialog" aria-modal="true" aria-labelledby="add-modal-title">
    <div class="modal">
      <h3 id="add-modal-title">Add Account to Pool</h3>
      <div class="form-group">
        <label>Provider</label>
        <select class="form-control" id="add-provider" onchange="toggleProviderHelp()">
          <option value="codex">ChatGPT Plus / OpenAI (Codex)</option>
          <option value="zen">OpenCode Zen / Go (API Key)</option>
          <option value="antigravity">Antigravity / Google OAuth (Gemini &amp; Claude)</option>
          <option value="qwen">Qwen Chat Web (chat.qwen.ai Token)</option>
        </select>
      </div>
      <div id="codex-help" style="font-size: 12px; color: var(--text-muted); margin-bottom: 14px; line-height: 1.4;">
        Recommended: authorize with ChatGPT in your browser. Claude-Zen never receives your password.
      </div>
      <div id="zen-help" style="display: none; font-size: 12px; color: var(--text-muted); margin-bottom: 14px; line-height: 1.4;">
        Enter your OpenCode API key (<span class="mono" style="color:var(--accent);">sk-...</span>). Supports both Zen Free models and Go paid models with automatic rotation.
      </div>
      <div id="agw-help" style="display: none; font-size: 12px; color: var(--text-muted); margin-bottom: 14px; line-height: 1.4;">
        Connect your Google account for Antigravity (Gemini 3.8 &amp; Claude Opus/Sonnet 4.6).
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px;">
          Or connect via terminal: <code class="mono" style="color:var(--accent); background:#090d13; padding:2px 6px; border-radius:4px;">claude-zen --accounts add</code>
        </div>
      </div>
      <div id="qwen-help" style="display: none; font-size: 12px; color: var(--text-muted); margin-bottom: 14px; line-height: 1.4;">
        Connect your <span class="mono" style="color:var(--accent);">chat.qwen.ai</span> account using your browser session token.
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px; line-height: 1.5;">
          1. Go to <a href="https://chat.qwen.ai" target="_blank" style="color:var(--accent);">chat.qwen.ai</a> and log in.<br>
          2. Open F12 DevTools &rarr; Console tab.<br>
          3. Run: <code class="mono" style="color:var(--accent); background:#090d13; padding:2px 6px; border-radius:4px;">localStorage.getItem("token")</code> and copy the token below.
        </div>
      </div>
      <div id="codex-login-actions" style="display: grid; gap: 8px; margin-bottom: 14px;">
        <button class="btn btn-primary" onclick="startChatGptLogin('browser')">🌐 Sign in with ChatGPT</button>
        <button class="btn" onclick="startChatGptLogin('device')">🔢 Use Device Code</button>
        <button class="btn" onclick="importLocalCodexLogin()">📥 Import Current Codex Login</button>
        <button class="btn btn-sm" onclick="toggleAdvancedTokens()">Advanced: paste auth.json</button>
      </div>
      <div id="agw-login-actions" style="display: none; gap: 8px; margin-bottom: 14px;">
        <button class="btn btn-primary" onclick="startGoogleLogin()">🌐 Sign in with Google (OAuth)</button>
        <button class="btn" onclick="importLocalAgwLogin()">📥 Import Local Google Accounts</button>
        <button class="btn btn-sm" onclick="toggleAdvancedTokens()">Advanced: paste Refresh Token / JSON</button>
      </div>
      <div id="zen-form-fields" style="display: none;">
        <div class="form-group">
          <label>OpenCode API Key</label>
          <input type="password" class="form-control mono" id="zen-api-key" placeholder="sk-..." autocomplete="off">
        </div>
        <div class="form-group">
          <label>Account Label / Email (Optional)</label>
          <input type="text" class="form-control" id="zen-email" placeholder="e.g. user-free-1@opencode.ai">
        </div>
        <div class="form-group">
          <label>Plan / Tier Type</label>
          <select class="form-control" id="zen-plan-type">
            <option value="hybrid">Zen Hybrid (Free &amp; Go Paid)</option>
            <option value="free">Zen Free (Free models only)</option>
            <option value="go">Zen Go (Paid models only)</option>
          </select>
        </div>
      </div>
      <div id="qwen-form-fields" style="display: none;">
        <div class="form-group">
          <label>Qwen Access Token (from chat.qwen.ai)</label>
          <textarea class="form-control mono" id="qwen-access-token" placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." style="height: 80px;"></textarea>
        </div>
        <div class="form-group">
          <label>Account Label / Email (Optional)</label>
          <input type="text" class="form-control" id="qwen-email" placeholder="e.g. my-qwen-account@chat.qwen.ai">
        </div>
      </div>
      <div id="login-progress" style="display: none; padding: 12px; margin-bottom: 14px; border: 1px solid var(--card-border); border-radius: 8px; line-height: 1.6;"></div>
      <div class="form-group" id="group-json" style="display: none;">
        <label>Account JSON or auth.json</label>
        <textarea class="form-control" id="add-json" placeholder='{"tokens": {"access_token": "...", "refresh_token": "..."}}'></textarea>
      </div>
      <div class="form-group" id="group-email" style="display: none;">
        <label>Account Email / Alias (Optional)</label>
        <input type="text" class="form-control" id="add-email" placeholder="e.g. work@gotipath.com">
      </div>
      <div class="modal-actions">
        <button class="btn" onclick="closeAddModal()">Cancel</button>
        <button class="btn btn-primary" id="save-zen-account" style="display: none;" onclick="submitAddZenAccount()">Save OpenCode Account</button>
        <button class="btn btn-primary" id="save-qwen-account" style="display: none;" onclick="submitAddQwenAccount()">Save Qwen Account</button>
        <button class="btn btn-primary" id="save-token-account" style="display: none;" onclick="submitAddAccount()">Save Token Account</button>
      </div>
    </div>
  </div>

  <!-- Routing Profile Modal -->
  <div class="modal-overlay" id="profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-modal-title">
    <div class="modal">
      <h3 id="profile-modal-title">Create Runtime Profile</h3>
      <div class="form-group"><label>Name</label><input class="form-control" id="profile-name" placeholder="e.g. Serious Backend"></div>
      <div class="form-group"><label>Description</label><input class="form-control" id="profile-description" placeholder="When to use this profile"></div>
      <div id="profile-tier-fields"></div>
      <div class="modal-actions">
        <button class="btn" onclick="closeProfileModal()">Cancel</button>
        <button class="btn btn-primary" id="save-profile-button" onclick="saveProfile()">Save Profile</button>
      </div>
    </div>
  </div>

  <div class="toast" id="toast" role="status" aria-live="polite"></div>

  <script>
    let currentTab = 'all';
    let cachedAccounts = [];
    let routingData = { profiles: [], catalog: {}, modelMetadata: {} };
    let editingProfileId = null;
    let loginPollTimer = null;
    let privacyMode = localStorage.getItem('zen_privacy_mode') === 'true';
    let refreshIntervalId = null;
    let debounceTimer = null;
    let activityLoaded = false;
    let fetchInFlight = false;
    let fetchQueued = false;

    // Cursor pagination state for Activity Feed
    let activityNextCursor = null;
    let activityPrevCursor = null;
    let activityCursor = null;       // current page cursor (null = first page)
    let activityDirection = 'next';  // 'next' | 'prev'
    let activityHasMore = false;
    let activityHasPrev = false;
    let activityTotalCount = 0;
    const ACTIVITY_PAGE_SIZE = 20;

    // Initialize privacy UI state
    updatePrivacyUI();

    // ── Sidebar navigation ──────────────────────────────────────────────
    const SECTION_TITLES = {
      overview: 'Overview',
      activity: 'Activity Feed & Diagnostics',
      analytics: 'Analytics',
      accounts: 'Account Pools',
      quotas: 'Antigravity Model Quotas',
      routing: 'Routing Profiles',
      ratelimits: 'Rate-Limit Incidents',
    };

    function showSection(name, triggerBtn) {
      document.querySelectorAll('.dash-section').forEach(el => { el.classList.remove('active'); });
      const target = document.getElementById('section-' + name);
      if (target) target.classList.add('active');

      document.querySelectorAll('.nav-item').forEach(btn => {
        btn.classList.remove('active');
        btn.removeAttribute('aria-current');
      });
      if (triggerBtn) {
        triggerBtn.classList.add('active');
        triggerBtn.setAttribute('aria-current', 'page');
      }

      const titleEl = document.getElementById('page-title');
      if (titleEl) titleEl.textContent = SECTION_TITLES[name] || name;

      closeSidebar();
    }

    function toggleSidebar() {
      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('sidebar-overlay');
      const toggle = document.getElementById('sidebar-toggle');
      const isOpen = sidebar.classList.toggle('open');
      overlay.classList.toggle('open', isOpen);
      toggle.classList.toggle('open', isOpen);
      toggle.setAttribute('aria-expanded', String(isOpen));
      toggle.setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation');
    }

    function closeSidebar() {
      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('sidebar-overlay');
      const toggle = document.getElementById('sidebar-toggle');
      sidebar.classList.remove('open');
      overlay.classList.remove('open');
      toggle.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open navigation');
    }

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && document.getElementById('sidebar').classList.contains('open')) {
        closeSidebar();
        document.getElementById('sidebar-toggle').focus();
      }
    });

    // ── Pagination helpers ───────────────────────────────────────────────
    function resetActivityPage() {
      activityCursor = null;
      activityDirection = 'next';
      activityNextCursor = null;
      activityPrevCursor = null;
    }

    function goActivityPage(dir) {
      if (dir === 'next' && activityNextCursor) {
        activityCursor = activityNextCursor;
        activityDirection = 'next';
      } else if (dir === 'prev' && activityPrevCursor) {
        activityCursor = activityPrevCursor;
        activityDirection = 'prev';
      } else {
        return;
      }
      document.getElementById('btn-prev-page').disabled = true;
      document.getElementById('btn-next-page').disabled = true;
      fetchData();
    }

    function refreshActivity() {
      resetActivityPage();
      fetchData();
    }

    function updatePaginationControls(hasMore, hasPrev, nextCursor, prevCursor, totalCount, pageItems) {
      activityHasMore = hasMore;
      activityHasPrev = hasPrev;
      activityNextCursor = nextCursor || null;
      activityPrevCursor = prevCursor || null;
      activityTotalCount = totalCount || 0;

      const bar = document.getElementById('pagination-bar');
      const btnPrev = document.getElementById('btn-prev-page');
      const btnNext = document.getElementById('btn-next-page');
      const info = document.getElementById('pagination-info');

      if (!bar) return;

      const showPagination = hasMore || hasPrev;
      bar.hidden = !showPagination;

      btnPrev.disabled = !hasPrev;
      btnNext.disabled = !hasMore;

      const shown = pageItems || 0;
      const total = totalCount || 0;
      info.textContent = total > 0
        ? shown + ' of ' + total + ' turns' + (hasPrev || hasMore ? ' (paginated)' : '')
        : shown + ' turn' + (shown === 1 ? '' : 's');
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function maskEmail(email) {
      if (!email || !privacyMode) return escapeHtml(email || 'anonymous');
      const parts = String(email).split('@');
      if (parts.length !== 2) return '***';
      const name = parts[0];
      const domain = parts[1];
      const maskedName = name.length <= 2 ? name[0] + '***' : name.slice(0, 2) + '***' + name.slice(-1);
      return '<span class="privacy-mask">' + escapeHtml(maskedName + '@' + domain) + '</span>';
    }

    function togglePrivacy() {
      privacyMode = !privacyMode;
      localStorage.setItem('zen_privacy_mode', privacyMode);
      updatePrivacyUI();
      renderAccountsTable();
      fetchData();
    }

    function updatePrivacyUI() {
      document.getElementById('privacy-state').innerText = privacyMode ? 'ON' : 'OFF';
      document.getElementById('privacy-icon').innerText = privacyMode ? '🔒' : '👁️';
    }

    function fmt(n) {
      if (!n || isNaN(n)) return '0';
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return Number(n).toLocaleString();
    }

    function formatDuration(ms) {
      const value = Number(ms) || 0;
      if (value < 1000) return Math.round(value) + ' ms';
      if (value < 60000) return (value / 1000).toFixed(value < 10000 ? 1 : 0) + ' s';
      return Math.floor(value / 60000) + 'm ' + Math.round((value % 60000) / 1000) + 's';
    }

    function normalizeTools(value) {
      if (Array.isArray(value)) return value;
      if (!value) return [];
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [{ name: String(value) }];
      }
    }

    function leaderMarkup(item, kind) {
      if (!item) return '<div class="leader-name">Not enough data</div><div class="metric-note">At least 5 completed or attempted turns are required.</div>';
      const rawName = kind === 'account' ? (item.email || 'anonymous') : (kind === 'model' ? item.model : item.provider);
      const name = kind === 'account' ? maskEmail(rawName) : escapeHtml(rawName || 'Unknown');
      const score = item.performance_score == null ? '' : '<span class="badge badge-success">Score ' + Number(item.performance_score).toFixed(1) + '</span>';
      const success = item.success_rate == null ? '' : '<span class="badge badge-blue">' + Number(item.success_rate).toFixed(1) + '% success</span>';
      const provider = kind === 'provider' ? '' : '<div class="metric-note">' + escapeHtml(item.provider || 'unknown provider') + '</div>';
      return '<div class="leader-name">' + name + '</div>' + provider + '<div class="leader-metrics">' + score + success +
        '<span class="badge badge-gray">' + fmt(item.total_tokens) + ' tokens</span><span class="badge badge-gray">' + formatDuration(item.avg_duration_ms) + '</span></div>';
    }

    function renderPerformanceTable(targetId, rows, kind) {
      const body = document.getElementById(targetId);
      if (!body) return;
      const ranked = (rows || [])
        .filter(row => kind !== 'account' || (row.email && row.email !== 'anonymous' && row.email !== 'antigravity-pool'))
        .sort((a, b) => {
          const aScore = a.performance_score == null ? -1 : Number(a.performance_score);
          const bScore = b.performance_score == null ? -1 : Number(b.performance_score);
          return bScore - aScore || Number(b.total_tokens || 0) - Number(a.total_tokens || 0);
        });
      if (!ranked.length) {
        body.innerHTML = '<tr><td colspan="8" class="analytics-table-empty">No ' + kind + ' performance data yet.</td></tr>';
        return;
      }
      body.innerHTML = ranked.map((row, index) => {
        const rawName = kind === 'account' ? row.email : row.model;
        const displayName = kind === 'account' ? maskEmail(rawName) : escapeHtml(rawName || 'unknown');
        const score = row.performance_score == null
          ? '<span class="badge badge-gray">Needs ' + Math.max(0, 5 - Number(row.request_count || 0)) + ' turns</span>'
          : '<span class="score-value">' + Number(row.performance_score).toFixed(1) + '</span>';
        return '<tr><td class="rank">' + (index + 1) + '</td><td><strong>' + displayName + '</strong><div class="entity-meta">' + escapeHtml(row.provider || 'unknown') + '</div></td>' +
          '<td>' + score + '</td><td>' + Number(row.success_rate || 0).toFixed(1) + '%</td><td class="mono">' + fmt(row.request_count) + '</td>' +
          '<td class="mono">' + fmt(row.total_tokens) + '</td><td class="mono">' + escapeHtml(formatDuration(row.avg_duration_ms)) + '</td>' +
          '<td title="' + escapeHtml(row.last_seen ? new Date(Number(row.last_seen)).toLocaleString() : 'Never') + '">' + escapeHtml(timeAgo(row.last_seen)) + '</td></tr>';
      }).join('');
    }

    function renderLifetimeAnalytics(stats) {
      const lifetime = stats.all_time || {};
      document.getElementById('lifetime-total-tokens').innerText = fmt(lifetime.total_tokens);
      document.getElementById('lifetime-token-split').innerText = 'In ' + fmt(lifetime.input_tokens) + ' · Out ' + fmt(lifetime.output_tokens);
      document.getElementById('lifetime-reasoning').innerText = fmt(lifetime.reasoning_tokens) + ' reasoning';
      document.getElementById('lifetime-total-turns').innerText = fmt(lifetime.total_requests);
      document.getElementById('lifetime-success-count').innerText = fmt(lifetime.success_requests) + ' successful';
      document.getElementById('lifetime-tool-turns').innerText = fmt(lifetime.tool_turns) + ' with tools';
      document.getElementById('lifetime-success-rate').innerText = Number(lifetime.success_rate == null ? 100 : lifetime.success_rate).toFixed(1) + '%';
      document.getElementById('lifetime-failures').innerText = fmt(Math.max(0, Number(lifetime.total_requests || 0) - Number(lifetime.success_requests || 0))) + ' failed';
      document.getElementById('lifetime-rate-limits').innerText = fmt(lifetime.rate_limited_requests) + ' limited';
      document.getElementById('lifetime-active-days').innerText = fmt(lifetime.active_days) + ' days';
      document.getElementById('lifetime-first-seen').innerText = lifetime.first_request_at ? 'Since ' + new Date(Number(lifetime.first_request_at)).toLocaleDateString() : 'No activity';
      document.getElementById('lifetime-last-seen').innerText = lifetime.last_request_at ? timeAgo(lifetime.last_request_at) : 'Never';
      document.getElementById('lifetime-latency-summary').innerText = 'Latency: avg ' + formatDuration(lifetime.avg_duration_ms) + ' · p50 ' + formatDuration(lifetime.p50_duration_ms) + ' · p95 ' + formatDuration(lifetime.p95_duration_ms) + ' · ' + fmt(lifetime.avg_tokens_per_request) + ' tokens/turn';

      const leaders = stats.leaders || {};
      document.getElementById('leader-best-account').innerHTML = leaderMarkup(leaders.best_account, 'account');
      document.getElementById('leader-best-model').innerHTML = leaderMarkup(leaders.best_model, 'model');
      document.getElementById('leader-most-used-model').innerHTML = leaderMarkup(leaders.most_used_model, 'model');
      document.getElementById('leader-top-provider').innerHTML = leaderMarkup(leaders.top_provider, 'provider');
      renderPerformanceTable('account-performance-table', stats.by_account, 'account');
      renderPerformanceTable('model-performance-table', stats.by_model, 'model');
    }

    function setActivityState(kind, title, detail) {
      const state = document.getElementById('activity-state');
      const list = document.getElementById('requests-list');
      list.hidden = true;
      state.hidden = false;
      state.className = 'state-panel' + (kind === 'error' ? ' error' : '');
      if (kind === 'loading') {
        state.innerHTML = '<div class="skeleton-list" aria-label="Loading recent activity"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>';
      } else {
        state.innerHTML = '<div><strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(detail || '') + '</span>' +
          (kind === 'error' ? '<div style="margin-top:12px"><button class="btn btn-sm" type="button" onclick="fetchData()">Try again</button></div>' : '') + '</div>';
      }
    }

    function renderRequests(requests) {
      const list = document.getElementById('requests-list');
      const state = document.getElementById('activity-state');
      const summary = document.getElementById('activity-summary');
      const filtered = document.getElementById('req-search').value.trim() ||
        document.getElementById('req-provider-filter').value !== 'all' ||
        document.getElementById('req-model-filter').value !== 'all' ||
        document.getElementById('req-status-filter').value !== 'all';

      if (!Array.isArray(requests) || !requests.length) {
        summary.innerText = filtered ? '0 matching turns' : 'No provider turns recorded';
        setActivityState(
          'empty',
          filtered ? 'No activity matches these filters' : 'Waiting for the first provider turn',
          filtered ? 'Clear or adjust a filter to broaden the diagnostics feed.' : 'Real requests will appear here after they pass through a Claude-Zen gateway.'
        );
        return;
      }

      const providerClass = { codex: 'badge-purple', antigravity: 'badge-cyan', zen: 'badge-blue', 'qwen-web': 'badge-green', qwen: 'badge-green' };
      const providerLabel = { codex: 'Codex', antigravity: 'Antigravity', zen: 'Zen', 'qwen-web': 'Qwen Web', qwen: 'Qwen Web' };
      const statusMeta = {
        success: ['Completed', 'badge-success'],
        rate_limited: ['Rate limited', 'badge-warning'],
        error: ['Error', 'badge-danger']
      };

      list.innerHTML = requests.map(r => {
        const status = statusMeta[r.status] || [r.status || 'Unknown', 'badge-gray'];
        const tools = normalizeTools(r.tools_called);
        const toolHtml = tools.length
          ? '<div class="tool-list">' + tools.map(tool => '<span class="tool-chip" title="' + escapeHtml(tool.name || 'unknown') + '">' + escapeHtml(tool.name || 'unknown') + '</span>').join('') + '</div>'
          : '<div class="activity-account">No tools called</div>';
        const reasoning = r.reasoning_effort
          ? 'Effort ' + r.reasoning_effort
          : (Number(r.reasoning_tokens) > 0 ? 'Provider reported reasoning' : 'Provider default');
        const reasoningTokens = Number(r.reasoning_tokens) > 0 ? ' · ' + fmt(r.reasoning_tokens) + ' tokens' : '';
        const timestamp = new Date(Number(r.timestamp));
        const fullTime = timestamp.toLocaleString();
        const error = r.error_message
          ? '<details class="activity-error"><summary>Error diagnostic</summary><pre>' + escapeHtml(r.error_message) + '</pre></details>'
          : '';

        return '<article class="activity-item status-' + escapeHtml(r.status || 'unknown') + '" aria-label="' +
          escapeHtml((providerLabel[r.provider] || r.provider || 'Unknown') + ' ' + (r.model || 'unknown') + ', ' + status[0]) + '">' +
          '<div class="activity-primary"><div class="activity-primary-top">' +
            '<span class="badge ' + (providerClass[r.provider] || 'badge-gray') + '">' + escapeHtml(providerLabel[r.provider] || r.provider || 'Unknown') + '</span>' +
            '<strong class="activity-model mono">' + escapeHtml(r.model || 'unknown') + '</strong></div>' +
            '<div class="activity-account">' + maskEmail(r.account_email) + '</div></div>' +
          '<div class="activity-diagnostic"><span class="activity-label">Reasoning & tools</span>' +
            '<div class="activity-value">' + escapeHtml(reasoning + reasoningTokens) + '</div>' + toolHtml + '</div>' +
          '<div><span class="activity-label">Token usage</span><div class="activity-token-line">' +
            '<span class="token-total">' + fmt(r.total_tokens) + ' total</span>' +
            '<span class="token-split">↓ ' + fmt(r.input_tokens) + ' · ↑ ' + fmt(r.output_tokens) + '</span></div>' +
            (r.stop_reason ? '<div class="activity-account">Stop: ' + escapeHtml(r.stop_reason) + '</div>' : '') + '</div>' +
          '<div><span class="activity-label">Outcome & time</span><div class="activity-status-line">' +
            '<span class="badge ' + status[1] + '">' + escapeHtml(status[0]) + '</span>' +
            '<span class="activity-value mono">' + escapeHtml(formatDuration(r.duration_ms)) + '</span></div>' +
            '<div class="activity-time" title="' + escapeHtml(fullTime) + '">' + escapeHtml(timeAgo(r.timestamp)) + ' · ' + escapeHtml(timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })) + '</div></div>' +
          error + '</article>';
      }).join('');

      state.hidden = true;
      list.hidden = false;
      summary.innerText = requests.length + (requests.length === 1 ? ' provider turn' : ' provider turns') + ' shown';
    }

    function updateModelFilter(stats, requests) {
      const select = document.getElementById('req-model-filter');
      const current = select.value;
      const models = new Set();
      const requestItems = Array.isArray(requests)
        ? requests
        : (Array.isArray(requests?.items) ? requests.items : []);
      (stats?.by_model || []).forEach(item => item.model && models.add(item.model));
      requestItems.forEach(item => item.model && models.add(item.model));
      select.innerHTML = '<option value="all">All models</option>' +
        [...models].sort().map(model => '<option value="' + escapeHtml(model) + '">' + escapeHtml(model) + '</option>').join('');
      select.value = models.has(current) || current === 'all' ? current : 'all';
    }

    function clearActivityFilters() {
      document.getElementById('req-search').value = '';
      document.getElementById('req-provider-filter').value = 'all';
      document.getElementById('req-model-filter').value = 'all';
      document.getElementById('req-status-filter').value = 'all';
      resetActivityPage();
      fetchData();
    }

    async function fetchJson(url, options = {}) {
      const response = await fetch(url, {
        cache: 'no-store',
        ...options,
        headers: {
          'Cache-Control': 'no-cache, no-store',
          'Pragma': 'no-cache',
          ...(options.headers || {})
        }
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(response.status + ' ' + response.statusText + ' returned invalid JSON');
      }
      if (!response.ok) throw new Error(payload?.error || response.status + ' ' + response.statusText);
      return payload;
    }

    function timeAgo(ts) {
      if (!ts) return 'Never';
      const sec = Math.floor((Date.now() - ts) / 1000);
      if (sec < 60) return sec + 's ago';
      if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
      if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
      return Math.floor(sec / 86400) + 'd ago';
    }

    function formatCountdown(targetTs) {
      if (!targetTs) return { text: '-', clock: '', sec: 0 };
      const now = Date.now();
      const diffSec = Math.max(0, Math.ceil((targetTs - now) / 1000));
      if (diffSec <= 0) return { text: 'Ready', clock: '00:00', sec: 0 };

      const hours = Math.floor(diffSec / 3600);
      const mins = Math.floor((diffSec % 3600) / 60);
      const secs = diffSec % 60;

      let countdownText = '';
      if (hours > 0) {
        countdownText = hours + 'h ' + mins + 'm ' + secs + 's';
      } else {
        countdownText = mins + 'm ' + (secs < 10 ? '0' : '') + secs + 's';
      }

      const resetDate = new Date(targetTs);
      const clockText = 'Resets at ' + resetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      return { text: countdownText, clock: clockText, sec: diffSec };
    }

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.innerText = msg;
      t.style.display = 'block';
      setTimeout(() => { t.style.display = 'none'; }, 3500);
    }

    function openAddModal() { document.getElementById('add-modal').classList.add('open'); }
    function closeAddModal() {
      document.getElementById('add-modal').classList.remove('open');
      if (loginPollTimer) clearInterval(loginPollTimer);
      loginPollTimer = null;
    }

    function toggleAdvancedTokens() {
      const open = document.getElementById('group-json').style.display === 'none';
      document.getElementById('group-json').style.display = open ? 'block' : 'none';
      document.getElementById('group-email').style.display = open ? 'block' : 'none';
      document.getElementById('save-token-account').style.display = open ? 'inline-flex' : 'none';
    }

    function toggleProviderHelp() {
      const p = document.getElementById('add-provider').value;
      document.getElementById('codex-help').style.display = p === 'codex' ? 'block' : 'none';
      document.getElementById('zen-help').style.display = p === 'zen' ? 'block' : 'none';
      document.getElementById('agw-help').style.display = p === 'antigravity' ? 'block' : 'none';
      document.getElementById('qwen-help').style.display = p === 'qwen' ? 'block' : 'none';

      document.getElementById('codex-login-actions').style.display = p === 'codex' ? 'grid' : 'none';
      document.getElementById('agw-login-actions').style.display = p === 'antigravity' ? 'grid' : 'none';
      document.getElementById('zen-form-fields').style.display = p === 'zen' ? 'block' : 'none';
      document.getElementById('save-zen-account').style.display = p === 'zen' ? 'inline-flex' : 'none';
      document.getElementById('qwen-form-fields').style.display = p === 'qwen' ? 'block' : 'none';
      document.getElementById('save-qwen-account').style.display = p === 'qwen' ? 'inline-flex' : 'none';

      document.getElementById('group-json').style.display = 'none';
      document.getElementById('group-email').style.display = 'none';
      document.getElementById('save-token-account').style.display = 'none';
      document.getElementById('login-progress').style.display = 'none';
    }

    async function submitAddQwenAccount() {
      const token = document.getElementById('qwen-access-token').value.trim();
      const email = document.getElementById('qwen-email').value.trim();

      if (!token) {
        return showToast('Qwen access token is required');
      }

      try {
        const res = await fetch('/api/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'qwen',
            token,
            email: email || null,
          }),
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Failed to add Qwen account');
        showToast('Qwen Chat account added: ' + (result.email || 'ready'));
        document.getElementById('qwen-access-token').value = '';
        document.getElementById('qwen-email').value = '';
        closeAddModal();
        fetchData();
      } catch (err) {
        showToast('Error: ' + err.message);
      }
    }

    async function submitAddZenAccount() {
      const apiKey = document.getElementById('zen-api-key').value.trim();
      const email = document.getElementById('zen-email').value.trim();
      const planType = document.getElementById('zen-plan-type').value;

      if (!apiKey || !apiKey.startsWith('sk-')) {
        return showToast('Valid OpenCode API key starting with "sk-" is required');
      }

      try {
        const res = await fetch('/api/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'zen',
            apiKey,
            email: email || null,
            planType,
          }),
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Failed to add OpenCode account');
        showToast('OpenCode Zen account added: ' + (result.email || 'ready'));
        document.getElementById('zen-api-key').value = '';
        document.getElementById('zen-email').value = '';
        closeAddModal();
        fetchData();
      } catch (err) {
        showToast('Error: ' + err.message);
      }
    }

    async function startChatGptLogin(method) {
      const progress = document.getElementById('login-progress');
      progress.style.display = 'block';
      progress.innerHTML = 'Starting secure ChatGPT authorization…';
      try {
        const res = await fetch('/api/accounts/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method })
        });
        const session = await res.json();
        if (!res.ok) throw new Error(session.error || 'Could not start login');
        const target = session.authUrl || session.verificationUrl;
        const visibleLink = '<div style="margin-top:8px;display:flex;gap:6px;align-items:center;">' +
          '<input class="form-control mono" style="font-size:11px;" readonly value="' + escapeHtml(target) + '" onclick="this.select()">' +
          '<button class="btn btn-sm" data-copy-value="' + escapeHtml(target) + '" onclick="copyLoginValue(this)">Copy Link</button>' +
          '<a class="btn btn-sm" href="' + escapeHtml(target) + '" target="_blank" rel="noopener">Open</a></div>';
        const visibleCode = method === 'device'
          ? '<div style="margin-top:8px;display:flex;gap:6px;align-items:center;">' +
            '<input class="form-control mono" style="font-size:18px;font-weight:700;letter-spacing:2px;" readonly value="' + escapeHtml(session.userCode) + '" onclick="this.select()">' +
            '<button class="btn btn-sm" data-copy-value="' + escapeHtml(session.userCode) + '" onclick="copyLoginValue(this)">Copy Code</button></div>'
          : '';
        progress.innerHTML = (method === 'device'
          ? '<strong>ChatGPT device authorization</strong><br>Open the link and enter the one-time code.'
          : '<strong>ChatGPT browser authorization</strong><br>Complete sign-in in the opened tab. You can also copy or reopen the full link.') +
          visibleLink + visibleCode + '<div style="margin-top:8px;color:var(--text-muted);">Waiting for authorization…</div>';
        window.open(target, '_blank', 'noopener');
        pollLogin(session.id);
      } catch (error) {
        progress.innerHTML = '<span style="color: var(--danger);">' + escapeHtml(error.message) + '</span>';
      }
    }

    async function copyLoginValue(button) {
      const value = button.getAttribute('data-copy-value') || '';
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        const input = document.createElement('textarea');
        input.value = value;
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
      }
      const original = button.innerText;
      button.innerText = 'Copied!';
      setTimeout(() => { button.innerText = original; }, 1500);
    }

    function pollLogin(id) {
      if (loginPollTimer) clearInterval(loginPollTimer);
      loginPollTimer = setInterval(async () => {
        const res = await fetch('/api/accounts/login/' + encodeURIComponent(id));
        const session = await res.json();
        if (session.status === 'completed') {
          clearInterval(loginPollTimer); loginPollTimer = null;
          const prov = session.provider === 'antigravity' ? 'Google Antigravity' : 'ChatGPT';
          showToast(prov + ' account connected: ' + (session.account?.email || 'ready'));
          closeAddModal(); fetchData();
        } else if (session.status === 'failed' || session.status === 'cancelled') {
          clearInterval(loginPollTimer); loginPollTimer = null;
          document.getElementById('login-progress').innerHTML = '<span style="color: var(--danger);">' + escapeHtml(session.error || 'Login failed') + '</span>';
        }
      }, 1000);
    }

    async function startGoogleLogin() {
      const progress = document.getElementById('login-progress');
      progress.style.display = 'block';
      progress.innerHTML = 'Starting Google OAuth authorization…';
      try {
        const res = await fetch('/api/accounts/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'antigravity', method: 'google' }),
        });
        const session = await res.json();
        if (!res.ok) throw new Error(session.error || 'Could not start Google login');
        const target = session.authUrl;
        const visibleLink = '<div style="margin-top:8px;display:flex;gap:6px;align-items:center;">' +
          '<input class="form-control mono" style="font-size:11px;" readonly value="' + escapeHtml(target) + '" onclick="this.select()">' +
          '<button class="btn btn-sm" data-copy-value="' + escapeHtml(target) + '" onclick="copyLoginValue(this)">Copy Link</button>' +
          '<a class="btn btn-sm" href="' + escapeHtml(target) + '" target="_blank" rel="noopener">Open</a></div>';
        progress.innerHTML = '<strong>Google Antigravity authorization</strong><br>Complete sign-in in the opened tab. You can also copy or reopen the full link.' +
          visibleLink +
          '<div style="margin-top:8px;color:var(--text-muted);">Waiting for authorization…</div>';
        window.open(target, '_blank', 'noopener');
        pollLogin(session.id);
      } catch (error) {
        progress.innerHTML = '<span style="color: var(--danger);">' + escapeHtml(error.message) + '</span>';
      }
    }

    async function importLocalAgwLogin() {
      const res = await fetch('/api/accounts/import-antigravity', { method: 'POST' });
      const result = await res.json();
      if (!res.ok) return showToast(result.error || 'Import failed');
      showToast('Imported Antigravity account(s): ' + (result.count ?? 0) + ' ready');
      closeAddModal();
      fetchData();
    }

    async function importLocalCodexLogin() {
      const res = await fetch('/api/accounts/import-local', { method: 'POST' });
      const result = await res.json();
      if (!res.ok) return showToast(result.error || 'Import failed');
      showToast('Imported current Codex login: ' + (result.email || 'ready'));
      closeAddModal(); fetchData();
    }

    function renderRoutingProfiles() {
      const root = document.getElementById('routing-profiles');
      const profiles = routingData.profiles || [];
      root.innerHTML = profiles.map(profile => {
        const routes = ['opus', 'sonnet', 'haiku'].map(tier => {
          const r = profile.tiers[tier];
          const effort = r.reasoning_effort ? ' · reasoning ' + r.reasoning_effort : '';
          const fallback = r.fallback ? '<br><span class="mono" style="color:var(--text-subtle);">↳ rate-limit fallback: ' + escapeHtml(r.fallback.provider + ' / ' + r.fallback.model) + '</span>' : '';
          const zenFallback = r.zen_fallback?.model ? '<br><span class="mono" style="color:var(--text-subtle);">↳ zen fallback: ' + escapeHtml(r.zen_fallback.model) + '</span>' : '';
          return '<div style="font-size: 11px; margin-top: 7px;"><strong style="text-transform: capitalize;">' + tier + '</strong><br><span class="mono" style="color: var(--text-muted);">' + escapeHtml(r.provider) + ' / ' + escapeHtml(r.model + effort) + '</span>' + fallback + zenFallback + '</div>';
        }).join('');
        return '<div class="card" style="margin: 0; border-color: ' + (profile.is_active ? 'var(--accent)' : 'var(--card-border)') + ';">' +
          '<div class="card-title"><span>' + escapeHtml(profile.name) + '</span>' + (profile.is_active ? '<span class="badge badge-success">ACTIVE</span>' : '') + '</div>' +
          '<div style="font-size: 11px; color: var(--text-muted); min-height: 30px;">' + escapeHtml(profile.description) + '</div>' + routes +
          '<div style="display:flex; gap:6px; margin-top:12px;">' +
            '<button class="btn btn-sm" onclick="editProfile(&quot;' + escapeHtml(profile.id) + '&quot;)">Edit</button>' +
            (!profile.is_active ? '<button class="btn btn-sm btn-primary" onclick="activateProfile(&quot;' + escapeHtml(profile.id) + '&quot;)">Activate</button><button class="btn btn-sm btn-danger" onclick="deleteProfile(&quot;' + escapeHtml(profile.id) + '&quot;)">Delete</button>' : '<span style="font-size:11px;color:var(--text-muted);align-self:center;">Changes apply next turn</span>') +
          '</div></div>';
      }).join('');
    }

    function openProfileModal(profileId = null) {
      editingProfileId = profileId;
      const profile = profileId ? (routingData.profiles || []).find(item => item.id === profileId) : null;
      const providers = Object.keys(routingData.catalog || {});
      document.getElementById('profile-modal-title').textContent = profile ? 'Edit Runtime Profile' : 'Create Runtime Profile';
      document.getElementById('save-profile-button').textContent = profile ? 'Save Changes' : 'Save Profile';
      document.getElementById('profile-name').value = profile?.name || '';
      document.getElementById('profile-description').value = profile?.description || '';
      document.getElementById('profile-tier-fields').innerHTML = ['opus', 'sonnet', 'haiku'].map(tier =>
        '<div class="form-group"><label style="text-transform:capitalize;">' + tier + '</label><div style="display:grid;grid-template-columns:1fr 1.6fr 1fr;gap:8px;">' +
        '<select class="form-control" id="profile-' + tier + '-provider" onchange="updateProfileModels(&quot;' + tier + '&quot;)">' + providers.map(p => '<option value="' + escapeHtml(p) + '">' + escapeHtml(p) + '</option>').join('') + '</select>' +
        '<select class="form-control" id="profile-' + tier + '-model" onchange="updateProfileEfforts(&quot;' + tier + '&quot;)"></select>' +
        '<select class="form-control" id="profile-' + tier + '-effort" title="Reasoning effort"></select></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1.6fr 1fr;gap:8px;margin-top:7px;">' +
        '<select class="form-control" id="profile-' + tier + '-fallback-provider" onchange="updateProfileFallbackModels(&quot;' + tier + '&quot;)"><option value="antigravity">Fallback: antigravity</option><option value="codex">Fallback: codex</option></select>' +
        '<select class="form-control" id="profile-' + tier + '-fallback-model"></select><span style="font-size:10px;color:var(--text-subtle);align-self:center;">Only on quota/rate limit</span></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1.6fr 1fr;gap:8px;margin-top:7px;">' +
        '<span style="font-size:10px;color:var(--text-subtle);align-self:center;">Zen fallback</span>' +
        '<select class="form-control" id="profile-' + tier + '-zen-fallback-model"></select>' +
        '<span style="font-size:10px;color:var(--text-subtle);align-self:center;">When all Google/OpenAI accounts are limited</span></div></div>'
      ).join('');
      ['opus', 'sonnet', 'haiku'].forEach(tier => {
        const route = profile?.tiers?.[tier];
        if (route?.provider) document.getElementById('profile-' + tier + '-provider').value = route.provider;
        updateProfileModels(tier);
        if (route?.model) document.getElementById('profile-' + tier + '-model').value = route.model;
        updateProfileEfforts(tier);
        if (route?.reasoning_effort) document.getElementById('profile-' + tier + '-effort').value = route.reasoning_effort;

        if (route?.fallback?.provider) document.getElementById('profile-' + tier + '-fallback-provider').value = route.fallback.provider;
        updateProfileFallbackModels(tier);
        if (route?.fallback?.model) document.getElementById('profile-' + tier + '-fallback-model').value = route.fallback.model;

        updateProfileZenFallbackModels(tier);
        if (route?.zen_fallback?.model) document.getElementById('profile-' + tier + '-zen-fallback-model').value = route.zen_fallback.model;
      });
      document.getElementById('profile-modal').classList.add('open');
    }
    function editProfile(id) { openProfileModal(id); }
    function closeProfileModal() {
      editingProfileId = null;
      document.getElementById('profile-modal').classList.remove('open');
    }
    function updateProfileModels(tier) {
      const provider = document.getElementById('profile-' + tier + '-provider').value;
      document.getElementById('profile-' + tier + '-model').innerHTML = (routingData.catalog[provider] || []).map(m => {
        const metadata = routingData.modelMetadata?.[provider]?.[m];
        const label = metadata?.displayName || m;
        return '<option value="' + escapeHtml(m) + '">' + escapeHtml(label) + '</option>';
      }).join('');
      updateProfileEfforts(tier);
    }
    function updateProfileEfforts(tier) {
      const provider = document.getElementById('profile-' + tier + '-provider').value;
      const model = document.getElementById('profile-' + tier + '-model').value;
      const select = document.getElementById('profile-' + tier + '-effort');
      const metadata = routingData.modelMetadata?.[provider]?.[model];
      const efforts = metadata?.supportedReasoningEfforts || [];
      if (!efforts.length) {
        select.innerHTML = '<option value="">Reasoning: none</option>';
        select.disabled = true;
        return;
      }
      select.disabled = false;
      select.innerHTML = efforts.map(effort => '<option value="' + escapeHtml(effort) + '"' + (effort === (metadata.defaultReasoningEffort || 'medium') ? ' selected' : '') + '>Reasoning: ' + escapeHtml(effort) + '</option>').join('');
    }
    function updateProfileFallbackModels(tier) {
      const provider = document.getElementById('profile-' + tier + '-fallback-provider').value;
      document.getElementById('profile-' + tier + '-fallback-model').innerHTML = (routingData.catalog[provider] || []).map(m => {
        const metadata = routingData.modelMetadata?.[provider]?.[m];
        return '<option value="' + escapeHtml(m) + '">' + escapeHtml(metadata?.displayName || m) + '</option>';
      }).join('');
    }
    function updateProfileZenFallbackModels(tier) {
      const zenModels = routingData.catalog.zen || [];
      const select = document.getElementById('profile-' + tier + '-zen-fallback-model');
      select.innerHTML = '<option value="">None</option>' + zenModels.map(m => {
        const metadata = routingData.modelMetadata?.zen?.[m];
        return '<option value="' + escapeHtml(m) + '">' + escapeHtml(metadata?.displayName || m) + '</option>';
      }).join('');
    }
    async function saveProfile() {
      const tiers = {};
      ['opus', 'sonnet', 'haiku'].forEach(tier => {
        const provider = document.getElementById('profile-' + tier + '-provider').value;
        tiers[tier] = { provider, model: document.getElementById('profile-' + tier + '-model').value };
        tiers[tier].fallback = {
          provider: document.getElementById('profile-' + tier + '-fallback-provider').value,
          model: document.getElementById('profile-' + tier + '-fallback-model').value
        };
        if (provider === 'codex' || provider === 'antigravity') {
          tiers[tier].reasoning_effort = document.getElementById('profile-' + tier + '-effort').value;
        }
        const zenFallbackModel = document.getElementById('profile-' + tier + '-zen-fallback-model').value;
        if (zenFallbackModel) {
          tiers[tier].zen_fallback = { provider: 'zen', model: zenFallbackModel };
        }
      });
      const profileId = editingProfileId;
      const res = await fetch('/api/routing/profiles', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ ...(profileId ? { id:profileId } : {}), name:document.getElementById('profile-name').value, description:document.getElementById('profile-description').value, tiers }) });
      const result = await res.json();
      if (!res.ok) return showToast(result.error || 'Could not save profile');
      closeProfileModal(); showToast(profileId ? 'Profile updated — next turn uses the changes' : 'Profile created'); fetchData();
    }
    async function activateProfile(id) {
      const res = await fetch('/api/routing/profiles/' + encodeURIComponent(id) + '/activate', { method:'POST' });
      const result = await res.json();
      if (!res.ok) return showToast(result.error || 'Activation failed');
      showToast('Activated ' + result.name + ' — next turn uses it'); fetchData();
    }
    async function deleteProfile(id) {
      if (!confirm('Delete this routing profile?')) return;
      const res = await fetch('/api/routing/profiles/' + encodeURIComponent(id), { method:'DELETE' });
      const result = await res.json();
      if (!res.ok) return showToast(result.error || 'Delete failed');
      showToast('Profile deleted'); fetchData();
    }

    function setTab(tab, button) {
      currentTab = tab;
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
        btn.setAttribute('aria-selected', 'false');
      });
      button?.classList.add('active');
      button?.setAttribute('aria-selected', 'true');
      renderAccountsTable();
    }

    function debounceFetch() {
      clearTimeout(debounceTimer);
      resetActivityPage();
      debounceTimer = setTimeout(fetchData, 300);
    }

    function changeRefreshRate(val) {
      if (refreshIntervalId) clearInterval(refreshIntervalId);
      const ms = Number(val);
      if (ms > 0) {
        refreshIntervalId = setInterval(fetchData, ms);
        showToast('Auto-refresh set to ' + (ms / 1000) + 's');
      } else {
        showToast('Auto-refresh paused.');
      }
    }

    async function checkGateways() {
      try {
        const [resZen, resAgw, resCodex] = await Promise.all([
          fetch('http://127.0.0.1:8787/health').catch(() => null),
          fetch('http://127.0.0.1:8788/health').catch(() => null),
          fetch('http://127.0.0.1:8789/health').catch(() => null)
        ]);

        const dotZen = document.getElementById('dot-zen');
        if (resZen && resZen.ok) { dotZen.className = 'dot'; } else { dotZen.className = 'dot down'; }

        const dotAgw = document.getElementById('dot-agw');
        if (resAgw && resAgw.ok) { dotAgw.className = 'dot'; } else { dotAgw.className = 'dot down'; }

        const dotCodex = document.getElementById('dot-codex');
        if (resCodex && resCodex.ok) { dotCodex.className = 'dot'; } else { dotCodex.className = 'dot down'; }
      } catch (e) {}
    }

    function renderAccountsTable() {
      const accTbody = document.getElementById('accounts-table-body');
      let filtered = cachedAccounts;

      if (currentTab === 'codex') filtered = cachedAccounts.filter(a => a.provider === 'codex');
      if (currentTab === 'antigravity') filtered = cachedAccounts.filter(a => a.provider === 'antigravity');
      if (currentTab === 'zen') filtered = cachedAccounts.filter(a => a.provider === 'zen');
      if (currentTab === 'qwen') filtered = cachedAccounts.filter(a => a.provider === 'qwen');
      if (currentTab === 'limited') filtered = cachedAccounts.filter(a => a.status === 'rate_limited' || a.status === 'partially_limited');

      if (!filtered.length) {
        accTbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 24px;">No accounts found for current filter (' + escapeHtml(currentTab) + ').</td></tr>';
        return;
      }

      accTbody.innerHTML = filtered.map(acc => {
        let providerBadge = '<span class="badge badge-gray">' + escapeHtml(acc.provider) + '</span>';
        if (acc.provider === 'codex') providerBadge = '<span class="badge badge-purple">ChatGPT Plus</span>';
        else if (acc.provider === 'antigravity') providerBadge = '<span class="badge badge-cyan">Google OAuth</span>';
        else if (acc.provider === 'zen') providerBadge = '<span class="badge badge-blue">OpenCode Zen</span>';
        else if (acc.provider === 'qwen') providerBadge = '<span class="badge badge-green" style="color:#00e5a3;border-color:rgba(0,229,163,0.3)">Qwen Chat</span>';

        let statusBadge = '<span class="badge badge-success">🟢 Ready</span>';
        let cooldownHtml = '<span style="color: var(--text-muted);">-</span>';

        const cd = formatCountdown(acc.rate_limited_until);

        if (acc.status === 'rate_limited') {
          statusBadge = '<span class="badge badge-warning">🟡 Rate-Limited</span>';
          cooldownHtml = '<div class="cooldown-cell">' +
            '<span class="countdown-timer" data-target-ts="' + (acc.rate_limited_until || 0) + '">' + cd.text + '</span>' +
            '<span class="reset-clock">' + cd.clock + '</span>' +
            '<span class="cooldown-source">' + (acc.cooldown_source === 'upstream' ? '⚡ Upstream quota limit' : '⏱️ Adaptive 1h cooldown') + '</span>' +
          '</div>';
        } else if (acc.status === 'partially_limited') {
          statusBadge = '<span class="badge badge-warning">🟠 Partial Limit</span>';
          cooldownHtml = '<div class="cooldown-cell">' +
            '<span class="countdown-timer" data-target-ts="' + (acc.rate_limited_until || 0) + '">' + cd.text + '</span>' +
            '<span class="reset-clock">' + cd.clock + '</span>' +
          '</div>';
        } else if (acc.status === 'invalid') {
          statusBadge = '<span class="badge badge-danger">🔴 Re-auth</span>';
          cooldownHtml = '<span style="color: var(--danger); font-size: 11px;">Token invalid</span>';
        }

        const activeIndicator = acc.is_current_active ? ' <span class="badge badge-cyan"><span class="pulse-indicator"></span>Active</span>' : '';
        const keyPreview = acc.key_preview ? '<div style="font-size: 11px; color: var(--text-subtle); font-family: var(--font-mono); margin-top: 2px;">' + escapeHtml(acc.key_preview) + '</div>' : '';

        // Model limits breakdown if present
        let modelLimitsHtml = '';
        if (acc.model_rate_limits && acc.model_rate_limits.length) {
          if (acc.provider === 'antigravity') {
            const limitedModels = acc.model_rate_limits.filter(m => m.is_rate_limited).length;
            const lowest = Math.min(...acc.model_rate_limits.map(m => Number(m.remaining_percent ?? 100)));
            modelLimitsHtml = '<div class="model-limits-box"><span class="badge badge-cyan">' + acc.model_rate_limits.length + ' model quotas</span>' +
              '<span class="badge ' + (lowest <= 10 ? 'badge-warning' : 'badge-success') + '">Lowest: ' + Math.round(lowest) + '% left</span>' +
              (limitedModels ? '<span class="badge badge-warning">' + limitedModels + ' exhausted</span>' : '') +
              '<button class="btn btn-sm" onclick="showSection(&quot;quotas&quot;, document.querySelector(&quot;[data-section=quotas]&quot;))">View details</button></div>';
          } else {
            modelLimitsHtml = '<div class="model-limits-box">' + acc.model_rate_limits.map(m => {
              const mcd = formatCountdown(m.reset_time);
              const remaining = m.remaining_percent != null ? ' · ' + Math.round(m.remaining_percent) + '% left' : '';
              if (m.is_rate_limited) {
                return '<span class="model-limit-chip limited" title="' + mcd.clock + '">⛔ ' + escapeHtml(m.display_name || m.model) + remaining + ' (' + mcd.text + ')</span>';
              }
              return '<span class="model-limit-chip ready" title="' + mcd.clock + '">✓ ' + escapeHtml(m.display_name || m.model) + remaining + '</span>';
            }).join('') + '</div>';
          }
        } else if (acc.provider === 'antigravity' && acc.quota_error) {
          modelLimitsHtml = '<div class="model-limits-box"><span class="badge badge-danger">Quota unavailable</span><span style="font-size:10px;color:var(--text-muted);">' + escapeHtml(acc.quota_error) + '</span></div>';
        }

        const makeActiveBtn = !acc.is_current_active && acc.status !== 'invalid'
          ? '<button class="btn btn-sm" style="margin-right: 4px;" onclick="setActiveAccount(\\'' + escapeHtml(acc.id) + '\\')">Set Active</button>'
          : '';

        return '<tr>' +
          '<td>' + providerBadge + '</td>' +
          '<td>' +
            '<div><strong>' + maskEmail(acc.email) + '</strong>' + activeIndicator + '</div>' +
            keyPreview +
            modelLimitsHtml +
          '</td>' +
          '<td><span style="font-size: 12px; color: var(--text-muted);">' + escapeHtml(acc.plan_type || acc.account_id || 'Standard') + '</span></td>' +
          '<td>' + statusBadge + '</td>' +
          '<td>' + cooldownHtml + '</td>' +
          '<td style="color: var(--text-muted); font-size: 12px;">' + timeAgo(acc.last_used) + '</td>' +
          '<td>' +
            makeActiveBtn +
                        '<button class="btn btn-sm btn-sm" style="margin-right: 4px;" onclick="testAccount(\\'' + escapeHtml(acc.id) + '\\')">🧪 Test</button>' +
            '<button class="btn btn-sm btn-danger" onclick="deleteAccount(\\'' + escapeHtml(acc.id) + '\\')">Remove</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }

    function renderQuotaDetails() {
      const root = document.getElementById('quota-account-grid');
      if (!root) return;
      const accounts = cachedAccounts.filter(a => a.provider === 'antigravity');
      const totalModels = accounts.reduce((sum, account) => sum + (account.model_rate_limits?.length || 0), 0);
      const badge = document.getElementById('nav-badge-quotas');
      if (badge) badge.textContent = totalModels ? String(totalModels) : '—';
      if (!accounts.length) {
        root.innerHTML = '<div class="card" style="color:var(--text-muted);">No Antigravity accounts configured.</div>';
        return;
      }
      root.innerHTML = accounts.map(account => {
        const models = [...(account.model_rate_limits || [])].sort((a, b) =>
          Number(a.remaining_percent ?? 101) - Number(b.remaining_percent ?? 101) ||
          String(a.display_name || a.model).localeCompare(String(b.display_name || b.model)));
        const checked = account.rate_limits_checked_at
          ? 'Checked ' + timeAgo(account.rate_limits_checked_at)
          : 'Not checked yet';
        let content = '';
        if (models.length) {
          content = models.map(model => {
            const remaining = Math.max(0, Math.min(100, Number(model.remaining_percent ?? 0)));
            const meterClass = remaining <= 0 ? 'empty' : (remaining <= 20 ? 'low' : '');
            const reset = model.reset_time ? formatCountdown(model.reset_time) : null;
            return '<div class="quota-model-row">' +
              '<div><strong>' + escapeHtml(model.display_name || model.model) + '</strong><div class="mono" style="font-size:9px;color:var(--text-subtle);margin-top:2px;">' + escapeHtml(model.model) + '</div><div class="quota-meter" style="margin-top:5px;"><span class="' + meterClass + '" style="width:' + remaining + '%"></span></div></div>' +
              '<div class="mono" style="text-align:right;color:' + (remaining <= 20 ? 'var(--warning)' : 'var(--success)') + ';">' + Math.round(remaining) + '% left</div>' +
              '<div class="quota-reset" style="color:var(--text-muted);text-align:right;">' + (reset ? reset.text + '<br><span style="font-size:9px;">' + reset.clock + '</span>' : 'No reset reported') + '</div>' +
            '</div>';
          }).join('');
        } else {
          content = '<div style="padding:18px 0;color:var(--text-muted);font-size:11px;">' +
            (account.quota_error
              ? '<span class="badge badge-danger">Quota fetch failed</span><div style="margin-top:8px;">' + escapeHtml(account.quota_error) + '. Reconnect this Google account if refreshing does not resolve it.</div>'
              : 'Google has not returned model quota data for this account yet.') +
            '</div>';
        }
        return '<div class="card quota-account-card">' +
          '<div class="card-title"><span>' + maskEmail(account.email) + '</span>' +
            (account.is_current_active ? '<span class="badge badge-cyan">Active</span>' : '') + '</div>' +
          '<div style="display:flex;justify-content:space-between;gap:8px;color:var(--text-muted);font-size:10px;margin-bottom:8px;"><span>' + escapeHtml(account.account_id || 'Google OAuth') + '</span><span>' + checked + '</span></div>' +
          content + '</div>';
      }).join('');
    }

    async function fetchData() {
      if (fetchInFlight) {
        fetchQueued = true;
        return;
      }
      fetchInFlight = true;
      checkGateways();
      if (!activityLoaded) setActivityState('loading');
      try {
        const reqSearch = document.getElementById('req-search').value.trim();
        const reqStatus = document.getElementById('req-status-filter').value;
        const reqProvider = document.getElementById('req-provider-filter').value;
        const reqModel = document.getElementById('req-model-filter').value;

        // Build cursor-paginated request query (paginate=true enables {items, nextCursor, prevCursor, ...})
        const reqQuery = new URLSearchParams({
          limit: String(ACTIVITY_PAGE_SIZE),
          paginate: 'true',
          ...(activityCursor ? { cursor: activityCursor, direction: activityDirection } : {}),
          ...(reqSearch ? { search: reqSearch } : {}),
          ...(reqStatus !== 'all' ? { status: reqStatus } : {}),
          ...(reqProvider !== 'all' ? { provider: reqProvider } : {}),
          ...(reqModel !== 'all' ? { model: reqModel } : {})
        });

        const [statsResult, accountsResult, reqsResult, rleResult, routingResult] = await Promise.allSettled([
          fetchJson('/api/stats'),
          fetchJson('/api/accounts'),
          fetchJson('/api/requests?' + reqQuery.toString()),
          fetchJson('/api/rate-limits?limit=15'),
          fetchJson('/api/routing')
        ]);

        const statsRes = statsResult.status === 'fulfilled' ? statsResult.value : null;
        const accountsRes = accountsResult.status === 'fulfilled' ? accountsResult.value : null;
        const reqsRes = reqsResult.status === 'fulfilled' ? reqsResult.value : null;
        const rleRes = rleResult.status === 'fulfilled' ? rleResult.value : null;
        const routingRes = routingResult.status === 'fulfilled' ? routingResult.value : null;

        if (!statsRes && !accountsRes && !reqsRes && !rleRes && !routingRes) {
          const firstErr = statsResult.reason || accountsResult.reason || reqsResult.reason || 'Failed to connect to gateway';
          throw firstErr;
        }

        document.getElementById('dashboard-error').hidden = true;
        if (accountsRes) {
          cachedAccounts = accountsRes || [];
        }
        if (routingRes) {
          routingData = routingRes || routingData;
          renderRoutingProfiles();
        }

        // Count tabs & update sidebar badges
        const codexCount = cachedAccounts.filter(a => a.provider === 'codex').length;
        const agwCount = cachedAccounts.filter(a => a.provider === 'antigravity').length;
        const zenCount = cachedAccounts.filter(a => a.provider === 'zen').length;
        const qwenCount = cachedAccounts.filter(a => a.provider === 'qwen').length;
        const limitedCount = cachedAccounts.filter(a => a.status === 'rate_limited' || a.status === 'partially_limited').length;

        document.getElementById('count-all').innerText = cachedAccounts.length;
        document.getElementById('count-codex').innerText = codexCount;
        document.getElementById('count-agw').innerText = agwCount;
        document.getElementById('count-zen').innerText = zenCount;
        const countQwenEl = document.getElementById('count-qwen');
        if (countQwenEl) countQwenEl.innerText = qwenCount;
        document.getElementById('count-limited').innerText = limitedCount;

        const navLimited = document.getElementById('nav-badge-limited');
        if (navLimited) {
          navLimited.textContent = limitedCount > 0 ? String(limitedCount) : '';
          navLimited.style.display = limitedCount > 0 ? '' : 'none';
        }

        // Render KPI Top Stats
        if (statsRes && statsRes.today) {
          document.getElementById('stat-today-tokens').innerText = fmt(statsRes.today.total_tokens);
          document.getElementById('stat-today-in').innerText = 'In: ' + fmt(statsRes.today.input_tokens);
          document.getElementById('stat-today-out').innerText = 'Out: ' + fmt(statsRes.today.output_tokens);

          const availCount = cachedAccounts.filter(a => a.status === 'active').length;
          document.getElementById('stat-accounts-active').innerText = availCount + ' / ' + cachedAccounts.length;
          document.getElementById('stat-accounts-limited').innerText = limitedCount + ' currently cooling down';

          if (statsRes.pool && statsRes.pool.earliest_reset_sec > 0) {
            const resetMins = Math.ceil(statsRes.pool.earliest_reset_sec / 60);
            document.getElementById('stat-accounts-next-reset').innerText = 'Next reset in ~' + resetMins + 'm';
          } else {
            document.getElementById('stat-accounts-next-reset').innerText = 'All pools ready';
          }

          // Reliability KPI
          const successRate = statsRes.today.success_rate != null ? statsRes.today.success_rate : 100;
          document.getElementById('stat-success-rate').innerText = successRate + '%';
          document.getElementById('stat-success-badge').innerText = (statsRes.today.success_requests || 0) + ' OK';
          document.getElementById('stat-total-turns').innerText = (statsRes.today.total_requests || 0) + ' turns today';
          document.getElementById('stat-rle-count').innerText = (statsRes.rate_limit_events_24h || 0) + ' rate-limits (24h)';

          // Latency KPI
          document.getElementById('stat-avg-latency').innerText = Math.round(statsRes.today.avg_duration_ms || 0) + 'ms';
          document.getElementById('stat-p50-latency').innerText = 'p50: ' + Math.round(statsRes.today.p50_duration_ms || 0) + 'ms';
          document.getElementById('stat-p95-latency').innerText = 'p95: ' + Math.round(statsRes.today.p95_duration_ms || 0) + 'ms';
          renderLifetimeAnalytics(statsRes);
        }

        // Update Failover Live Banner
        const banner = document.getElementById('pool-banner');
        const bannerTitle = document.getElementById('banner-title');
        const bannerMeta = document.getElementById('banner-meta');
        const bannerIcon = document.getElementById('banner-icon');
        const nextAccountBadge = document.getElementById('banner-next-account');

        const availCount = cachedAccounts.filter(a => a.status === 'active').length;
        const activeAcc = cachedAccounts.find(a => a.is_current_active) || cachedAccounts[0];
        if (activeAcc) {
          nextAccountBadge.innerHTML = 'Next Turn: <strong>' + maskEmail(activeAcc.email) + '</strong> (' + escapeHtml(activeAcc.provider) + ')';
        }

        if (availCount === 0 && cachedAccounts.length > 0) {
          banner.className = 'failover-banner danger';
          bannerIcon.innerText = '🔴';
          bannerTitle.innerText = 'Pool Exhausted: All accounts are cooling down';
          bannerMeta.innerText = '— Gateway will auto-resume turn execution as soon as the first account resets.';
        } else if (limitedCount > 0) {
          banner.className = 'failover-banner warning';
          bannerIcon.innerText = '🟡';
          bannerTitle.innerText = 'Dynamic Failover Active: ' + limitedCount + ' account(s) cooling down';
          bannerMeta.innerText = '— Automatic seamless rotation enabled across remaining ' + availCount + ' healthy accounts.';
        } else {
          banner.className = 'failover-banner healthy';
          bannerIcon.innerText = '🟢';
          bannerTitle.innerText = 'Pool Status: Fully Operational';
          bannerMeta.innerText = '— All ' + cachedAccounts.length + ' accounts ready for zero-latency turn execution.';
        }

        // Render Accounts Table
        if (accountsRes) {
          renderAccountsTable();
          renderQuotaDetails();
        }

        // Render 7-Day Trend Chart (both overview + analytics copies)
        if (statsRes && statsRes.past_7_days && statsRes.past_7_days.length) {
          const maxDayTokens = Math.max(...statsRes.past_7_days.map(d => d.total_tokens || 1));
          const sparkHtml = statsRes.past_7_days.map(day => {
            const heightPct = Math.max(8, Math.round(((day.total_tokens || 0) / maxDayTokens) * 100));
            const formattedTokens = fmt(day.total_tokens);
            return '<div class="spark-bar-wrap" data-tooltip="' + escapeHtml(day.date) + ': ' + formattedTokens + ' tokens (' + (day.request_count || 0) + ' reqs)">' +
              '<div class="spark-bar" style="height: ' + heightPct + '%;"></div>' +
              '<div class="spark-label">' + escapeHtml(day.day_name) + '</div>' +
            '</div>';
          }).join('');
          const spark1 = document.getElementById('sparkline-7d');
          const spark2 = document.getElementById('sparkline-7d-full');
          if (spark1) spark1.innerHTML = sparkHtml;
          if (spark2) spark2.innerHTML = sparkHtml;
        }

        // Render cursor-paginated activity feed
        if (reqsResult.status === 'fulfilled') {
          const requestItems = Array.isArray(reqsRes?.items) ? reqsRes.items : [];
          updateModelFilter(statsRes, requestItems);
          renderRequests(requestItems);
          activityLoaded = true;
          document.getElementById('activity-updated').innerText = 'Updated ' +
            new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

          // Wire pagination controls from cursor response
          updatePaginationControls(
            reqsRes?.hasMore || false,
            reqsRes?.hasPrev || false,
            reqsRes?.nextCursor || null,
            reqsRes?.prevCursor || null,
            reqsRes?.totalCount || requestItems.length,
            requestItems.length
          );

          // Update activity sidebar badge
          const navActivity = document.getElementById('nav-badge-activity');
          if (navActivity) {
            const total = reqsRes?.totalCount || requestItems.length;
            navActivity.textContent = total > 0 ? fmt(total) : '—';
          }
        } else if (!activityLoaded) {
          setActivityState('error', 'Activity could not be loaded', reqsResult.reason?.message || 'Request failed');
        }

        // Update rate-limit sidebar badge
        if (statsRes) {
          const navRle = document.getElementById('nav-badge-rle');
          const rleCount = statsRes.rate_limit_events_24h || 0;
          if (navRle) {
            navRle.textContent = rleCount > 0 ? String(rleCount) : '';
            navRle.style.display = rleCount > 0 ? '' : 'none';
          }
        }

        // Render Rate Limit Incidents
        if (rleResult.status === 'fulfilled') {
          const rleTbody = document.getElementById('rate-limits-table-body');
          if (rleRes && rleRes.length) {
            rleTbody.innerHTML = rleRes.map(e => {
              const mins = Math.ceil((e.cooldown_ms || 3600000) / 60000);
              return '<tr>' +
                '<td style="color: var(--text-muted); font-size: 11px;" class="mono">' + new Date(e.timestamp).toLocaleTimeString() + '</td>' +
                '<td><span class="badge badge-gray">' + escapeHtml(e.provider) + '</span></td>' +
                '<td>' + maskEmail(e.account_email) + '</td>' +
                '<td><span class="mono" style="font-size: 12px;">' + escapeHtml(e.model || 'all') + '</span></td>' +
                '<td><span class="badge badge-warning">' + mins + 'm cooldown</span></td>' +
                '<td style="color: var(--text-muted); font-size: 12px;">' + escapeHtml(e.reason || 'Usage limit reached') + '</td>' +
              '</tr>';
            }).join('');
          } else {
            rleTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 18px;">No rate-limit incidents recorded.</td></tr>';
          }
        }

      } catch (err) {
        console.error('Fetch error:', err);
        const message = err?.message || String(err);
        const banner = document.getElementById('dashboard-error');
        document.getElementById('dashboard-error-detail').innerText = message;
        banner.hidden = false;
        setActivityState('error', 'Activity could not be loaded', message);
        document.getElementById('activity-summary').innerText = 'Refresh failed';
        updatePaginationControls(false, false, null, null, 0, 0);
      } finally {
        fetchInFlight = false;
        if (fetchQueued) {
          fetchQueued = false;
          queueMicrotask(fetchData);
        }
      }
    }

    // Client-side 1s ticker for live countdown timers without full page reload
    setInterval(() => {
      document.querySelectorAll('.countdown-timer').forEach(el => {
        const targetTs = Number(el.getAttribute('data-target-ts') || 0);
        if (targetTs > 0) {
          const cd = formatCountdown(targetTs);
          el.innerText = cd.text;
        }
      });
    }, 1000);

    async function syncAccounts() {
      showToast('Syncing and probing accounts...');
      try {
        await fetch('/api/accounts/sync', { method: 'POST' });
        showToast('Accounts synchronized successfully.');
        fetchData();
      } catch (e) {
        showToast('Sync failed: ' + e.message);
      }
    }

    async function setActiveAccount(id) {
      try {
        const res = await fetch('/api/accounts/set-active', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
        const result = await res.json().catch(() => ({}));
        if (res.ok && result.success) {
          showToast('✅ Active account updated — next turn uses this account.');
          fetchData();
        } else if (res.status === 404 || !result.success) {
          showToast('Account not found or could not be set active.');
        } else {
          showToast('Error: ' + (result.error || res.statusText));
        }
      } catch (e) {
        showToast('Error: ' + e.message);
      }
    }

    async function resetRateLimits() {
      await fetch('/api/accounts/reset-limits', { method: 'POST' });
      showToast('All local rate limit cooldowns cleared.');
      fetchData();
    }

    async function deleteAccount(id) {
      if (!confirm('Are you sure you want to remove this account from the failover pool?')) return;
      await fetch('/api/accounts/' + encodeURIComponent(id), { method: 'DELETE' });
      showToast('Account removed.');
      fetchData();
    }

    async function testAccount(id, btn) {
      const origText = btn ? btn.innerText : '';
      if (btn) { btn.disabled = true; btn.innerText = 'Testing…'; }
      showToast('Testing account connection…');
      try {
        const res = await fetch('/api/accounts/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        const result = await res.json();
        if (!res.ok || !result.success) {
          throw new Error(result.error || 'Test failed');
        }
        showToast('✅ Verified (' + result.durationMs + 'ms): ' + (result.responseText || 'OK'));
      } catch (err) {
        showToast('❌ Test failed: ' + err.message);
      } finally {
        if (btn) { btn.disabled = false; btn.innerText = origText; }
        fetchData();
      }
    }

    function exportData(format) {
      window.open('/api/export?format=' + format, '_blank');
    }

    async function submitAddAccount() {
      const provider = document.getElementById('add-provider').value;
      const jsonStr = document.getElementById('add-json').value.trim();
      const email = document.getElementById('add-email').value.trim();
      if (!jsonStr) return alert('Please enter token JSON or auth.json content.');

      try {
        let payload = {};
        try {
          payload = JSON.parse(jsonStr);
        } catch {
          payload = provider === 'antigravity'
            ? { refreshToken: jsonStr }
            : { accessToken: jsonStr };
        }

        let accessToken = payload.access_token || payload.accessToken || payload.token || payload.tokens?.access_token;
        let refreshToken = payload.refresh_token || payload.refreshToken || payload.tokens?.refresh_token;
        let idToken = payload.id_token || payload.idToken || payload.tokens?.id_token;
        let projectId = payload.projectId || payload.project_id;
        let accountEmail = email || payload.email || payload.user?.email;

        if (provider === 'antigravity') {
          if (!refreshToken && !accessToken) {
            return alert('Could not find refresh_token or access_token in the provided input.');
          }
          const res = await fetch('/api/accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              provider: 'antigravity',
              refreshToken: refreshToken || accessToken,
              accessToken,
              email: accountEmail || null,
              projectId: projectId || null,
            })
          });
          const result = await res.json();
          if (res.ok) {
            showToast('Google Antigravity account added: ' + (result.email || 'ready'));
            closeAddModal();
            document.getElementById('add-json').value = '';
            document.getElementById('add-email').value = '';
            fetchData();
          } else {
            alert('Failed to save account: ' + (result.error || (await res.text())));
          }
          return;
        }

        if (!accessToken && !refreshToken) {
          return alert('Could not find access_token or refresh_token in the provided JSON.');
        }

        const res = await fetch('/api/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken, refreshToken, idToken, email: accountEmail || null })
        });
        if (res.ok) {
          showToast('Account added successfully!');
          closeAddModal();
          document.getElementById('add-json').value = '';
          document.getElementById('add-email').value = '';
          fetchData();
        } else {
          alert('Failed to save account: ' + (await res.text()));
        }
      } catch (err) {
        alert('Invalid JSON: ' + err.message);
      }
    }

    // Initial Fetch & Start Polling
    fetchData();
    refreshIntervalId = setInterval(fetchData, 3000);
  </script>
</body>
</html>`;
}
