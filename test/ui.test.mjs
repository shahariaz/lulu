import test from 'node:test'
import assert from 'node:assert/strict'
import { renderDashboardHtml } from '../lib/ui.mjs'

test('renders an accessible responsive diagnostics dashboard without sample activity', () => {
  const html = renderDashboardHtml()

  assert.match(html, /Recent Activity Feed & Diagnostics/)
  assert.match(html, /id="req-provider-filter"/)
  assert.match(html, /id="req-model-filter"/)
  assert.match(html, /id="req-status-filter"/)
  assert.match(html, /id="activity-state" role="status" aria-live="polite"/)
  assert.match(html, /id="requests-list" role="feed" aria-label="Recent provider activity"/)
  assert.match(html, /aria-label="Rate-limit incident table" tabindex="0"/)
  assert.match(html, /Activity could not be loaded/)
  assert.match(html, /Waiting for the first provider turn/)
  assert.match(html, /Reasoning & tools/)
  assert.match(html, /Token usage/)
  assert.match(html, /Outcome & time/)
  assert.match(html, /prefers-reduced-motion/)
  assert.match(html, /\.banner-actions \{ width: 100%; flex-wrap: wrap; \}/)
  assert.match(html, /class="skip-link"/)
  assert.match(html, /aria-modal="true"/)
  assert.doesNotMatch(html, /khaled@gotipath\.com/)
  assert.doesNotMatch(html, /id="requests-table-body"/)

  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.ok(script)
  assert.doesNotThrow(() => new Function(script))
})

test('accepts the cursor-paginated recent requests response shape', () => {
  const html = renderDashboardHtml()
  assert.match(html, /Array\.isArray\(reqsRes\?\.items\) \? reqsRes\.items : \[\]/)
  assert.match(html, /updateModelFilter\(statsRes, requestItems\)/)
  assert.match(html, /renderRequests\(requestItems\)/)
})

test('renders lifetime intelligence and data-driven performance rankings', () => {
  const html = renderDashboardHtml()
  assert.match(html, /id="lifetime-total-tokens"/)
  assert.match(html, /id="lifetime-success-rate"/)
  assert.match(html, /id="leader-best-account"/)
  assert.match(html, /id="leader-best-model"/)
  assert.match(html, /id="account-performance-table"/)
  assert.match(html, /id="model-performance-table"/)
  assert.match(html, /reliability 70% · latency 20% · sample confidence 10%/)
  assert.match(html, /function renderLifetimeAnalytics\(stats\)/)
  assert.match(html, /renderLifetimeAnalytics\(statsRes\)/)
})

test('has sidebar navigation with all required sections', () => {
  const html = renderDashboardHtml()

  // Sidebar nav exists and is accessible
  assert.match(html, /class="sidebar"/)
  assert.match(html, /aria-label="Dashboard navigation"/)
  assert.doesNotMatch(html, /class="nav-item[^"]*" role="listitem"/)

  // All nav sections present
  assert.match(html, /data-section="overview"/)
  assert.match(html, /data-section="activity"/)
  assert.match(html, /data-section="analytics"/)
  assert.match(html, /data-section="accounts"/)
  assert.match(html, /data-section="routing"/)
  assert.match(html, /data-section="ratelimits"/)

  // All dash-sections exist in HTML
  assert.match(html, /id="section-overview"/)
  assert.match(html, /id="section-activity"/)
  assert.match(html, /id="section-analytics"/)
  assert.match(html, /id="section-accounts"/)
  assert.match(html, /id="section-routing"/)
  assert.match(html, /id="section-ratelimits"/)

  // Mobile toggle
  assert.match(html, /id="sidebar-toggle"/)
  assert.match(html, /aria-expanded="false"/)
})

test('routing profiles can be edited in place from the dashboard', () => {
  const html = renderDashboardHtml()
  assert.match(html, /id="save-profile-button"/)
  assert.match(html, /function editProfile\(id\)/)
  assert.match(html, /editingProfileId = profileId/)
  assert.match(html, /Profile updated — next turn uses the changes/)
  assert.match(html, />Edit<\/button>/)
})

test('has stable Next/Previous pagination controls wired to cursor state', () => {
  const html = renderDashboardHtml()

  // Pagination bar and buttons exist
  assert.match(html, /id="pagination-bar"/)
  assert.match(html, /id="btn-prev-page"/)
  assert.match(html, /id="btn-next-page"/)
  assert.match(html, /id="pagination-info"/)
  assert.match(html, /aria-label="Activity pagination"/)

  // Pagination functions exist in script
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.ok(script)
  assert.match(script, /function resetActivityPage/)
  assert.match(script, /function goActivityPage/)
  assert.match(script, /function refreshActivity/)
  assert.match(script, /function updatePaginationControls/)

  // Cursor state variables exist
  assert.match(script, /activityNextCursor/)
  assert.match(script, /activityPrevCursor/)
  assert.match(script, /activityCursor/)
  assert.match(script, /activityDirection/)
  assert.match(script, /ACTIVITY_PAGE_SIZE/)

  // Filters reset the page cursor
  assert.match(script, /resetActivityPage\(\)/)

  // paginate=true sent to API
  assert.match(script, /paginate.*true/)
})

test('filter changes and search reset page to first', () => {
  const html = renderDashboardHtml()
  // Filter selects call resetActivityPage before fetchData
  assert.match(html, /resetActivityPage\(\); fetchData\(\)/)
  // Debounce fetch resets page too
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.ok(script)
  // Search debounce resets the cursor before scheduling the request.
  assert.match(script, /function debounceFetch\(\) \{[\s\S]*?resetActivityPage\(\);[\s\S]*?setTimeout\(fetchData, 300\)/)
  assert.match(script, /clearActivityFilters/)
})

test('queues user refreshes that arrive during an in-flight dashboard request', () => {
  const html = renderDashboardHtml()
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.ok(script)
  assert.match(script, /if \(fetchInFlight\) \{\s*fetchQueued = true;/)
  assert.match(script, /if \(fetchQueued\) \{\s*fetchQueued = false;\s*queueMicrotask\(fetchData\)/)
})

test('sidebar showSection function updates page title and active state', () => {
  const html = renderDashboardHtml()

  // page-title element exists in HTML
  assert.match(html, /id="page-title"/)

  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.ok(script)
  assert.match(script, /function showSection/)
  assert.match(script, /SECTION_TITLES/)
  // showSection references page-title element by id
  assert.match(script, /getElementById\('page-title'\)/)
  // classList toggling for dash-section active state
  assert.match(script, /classList\.remove\('active'\)/)
  assert.match(script, /classList\.add\('active'\)/)
})

test('renders OpenCode Zen account pool tab, add modal form, and submission logic', () => {
  const html = renderDashboardHtml()

  // Account Pools Tab for OpenCode Zen
  assert.match(html, /onclick="setTab\('zen', this\)">OpenCode Zen \(<span id="count-zen">0<\/span>\)/)

  // Modal option for OpenCode Zen
  assert.match(html, /<option value="zen">OpenCode Zen \/ Go \(API Key\)<\/option>/)
  assert.match(html, /id="zen-api-key"/)
  assert.match(html, /id="zen-email"/)
  assert.match(html, /id="zen-plan-type"/)
  assert.match(html, /id="save-zen-account"/)

  // Script has submission handler
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.ok(script)
  assert.match(script, /function submitAddZenAccount/)
  assert.match(script, /provider:\s*'zen'/)
})

test('renders Antigravity account pool actions, OAuth login, and import options', () => {
  const html = renderDashboardHtml()

  // Antigravity option in provider dropdown
  assert.match(html, /<option value="antigravity">Antigravity \/ Google OAuth/)
  assert.match(html, /id="agw-help"/)
  assert.match(html, /id="agw-login-actions"/)
  assert.match(html, /startGoogleLogin\(\)/)
  assert.match(html, /importLocalAgwLogin\(\)/)

  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.ok(script)
  assert.match(script, /function startGoogleLogin/)
  assert.match(script, /function importLocalAgwLogin/)
  assert.match(script, /provider === 'antigravity'/)
  assert.doesNotMatch(script, /alert\('To add a Google Antigravity account, run:/)
})
