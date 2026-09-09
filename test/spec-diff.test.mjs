import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRequirementsMap,
  diffRequirementsBaselines,
  generateSpecificationChangelog,
} from '../lib/orchestrator/spec-diff.mjs'

test('parseRequirementsMap extracts structured requirement definitions', () => {
  const spec = `
# Feature: User Management

## Functional Requirements
- REQ-F-01: User Registration
  Users must be able to register using email and password.
- REQ-F-02: Password Reset
  Users receive a one-time reset token via email.

## Nonfunctional Requirements
- REQ-NF-01: API Latency
  Registration completes in under 200ms.
  `

  const reqMap = parseRequirementsMap(spec)
  assert.equal(reqMap.size, 3)

  const req1 = reqMap.get('REQ-F-01')
  assert.equal(req1.id, 'REQ-F-01')
  assert.equal(req1.title, 'User Registration')
  assert.match(req1.text, /email and password/)

  const reqNf = reqMap.get('REQ-NF-01')
  assert.equal(reqNf.id, 'REQ-NF-01')
  assert.equal(reqNf.title, 'API Latency')
})

test('diffRequirementsBaselines categorizes added, removed, modified, and unchanged requirements', () => {
  const v1 = `
# Version 1.0.0
- REQ-F-01: User Profile
  Basic profile with name and email.
- REQ-F-02: Legacy SMS Auth
  SMS OTP verification.
- REQ-NF-01: Performance SLA
  p95 latency < 100ms.
  `

  const v2 = `
# Version 1.1.0
- REQ-F-01: User Profile
  Extended profile with name, email, and avatar URL.
- REQ-F-03: OAuth2 Google Login
  Support login via Google OAuth PKCE.
- REQ-NF-01: Performance SLA
  p95 latency < 100ms.
  `

  const diff = diffRequirementsBaselines(v1, v2)
  assert.equal(diff.hasChanges, true)
  assert.equal(diff.stats.addedCount, 1)
  assert.equal(diff.stats.removedCount, 1)
  assert.equal(diff.stats.modifiedCount, 1)
  assert.equal(diff.stats.unchangedCount, 1)

  // Added: REQ-F-03
  assert.equal(diff.added[0].id, 'REQ-F-03')
  assert.equal(diff.added[0].title, 'OAuth2 Google Login')

  // Removed: REQ-F-02
  assert.equal(diff.removed[0].id, 'REQ-F-02')

  // Modified: REQ-F-01
  assert.equal(diff.modified[0].id, 'REQ-F-01')
  assert.match(diff.modified[0].current.text, /avatar URL/)

  // Unchanged: REQ-NF-01
  assert.equal(diff.unchanged[0].id, 'REQ-NF-01')

  // Generate Markdown Changelog
  const changelog = generateSpecificationChangelog({
    versionFrom: 'v1.0.0',
    versionTo: 'v1.1.0',
    diffResult: diff,
  })

  assert.match(changelog, /# Specification Changelog: v1\.0\.0 → v1\.1\.0/)
  assert.match(changelog, /## Added Requirements \(1\)/)
  assert.match(changelog, /- \*\*REQ-F-03\*\*: OAuth2 Google Login/)
  assert.match(changelog, /## Modified Requirements \(1\)/)
  assert.match(changelog, /- \*\*REQ-F-01\*\*: User Profile/)
  assert.match(changelog, /## Removed Requirements \(1\)/)
  assert.match(changelog, /- \*\*REQ-F-02\*\*: Legacy SMS Auth/)
})
