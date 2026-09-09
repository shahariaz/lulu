/**
 * Specification Version Diffing & Changelog Generator.
 * Compares versioned PRD markdown baselines (e.g. v1.0.0 vs v1.1.0).
 */

/**
 * Parse a specification markdown document into a map of requirement records.
 * Matches lines starting with - REQ-*, ### REQ-*, or **REQ-***
 */
export function parseRequirementsMap(markdown = '') {
  const reqMap = new Map() // reqId -> { id, title, text, raw }
  if (!markdown || typeof markdown !== 'string') return reqMap

  const lines = markdown.split('\n')
  let currentReq = null
  let currentLines = []

  const reqHeaderRegex = /(?:^|\s|\*\*|###?\s*)(REQ-[A-Z0-9_-]+)(?:\*\*|\*|:|\s)(.*)/

  for (const line of lines) {
    const match = line.match(reqHeaderRegex)
    if (match) {
      if (currentReq) {
        currentReq.text = currentLines.join('\n').trim()
        reqMap.set(currentReq.id, currentReq)
      }
      const id = match[1]
      const title = match[2] ? match[2].replace(/^[\s:*]+/, '').trim() : ''
      currentReq = { id, title: title || id, text: '', raw: line }
      currentLines = [line]
    } else if (currentReq) {
      // Check if entering a new major section
      if (line.startsWith('# ') || line.startsWith('## ')) {
        currentReq.text = currentLines.join('\n').trim()
        reqMap.set(currentReq.id, currentReq)
        currentReq = null
        currentLines = []
      } else {
        currentLines.push(line)
      }
    }
  }

  if (currentReq) {
    currentReq.text = currentLines.join('\n').trim()
    reqMap.set(currentReq.id, currentReq)
  }

  return reqMap
}

/**
 * Compare two baseline specifications and compute structured requirement deltas.
 */
export function diffRequirementsBaselines(specV1 = '', specV2 = '') {
  const mapV1 = parseRequirementsMap(specV1)
  const mapV2 = parseRequirementsMap(specV2)

  const added = []
  const removed = []
  const modified = []
  const unchanged = []

  // Check items in V2 against V1
  for (const [id, req2] of mapV2.entries()) {
    if (!mapV1.has(id)) {
      added.push(req2)
    } else {
      const req1 = mapV1.get(id)
      const isContentSame = req1.text.replace(/\s+/g, ' ').trim() === req2.text.replace(/\s+/g, ' ').trim()
      if (isContentSame) {
        unchanged.push(req2)
      } else {
        modified.push({
          id,
          title: req2.title,
          previous: req1,
          current: req2,
        })
      }
    }
  }

  // Check items in V1 removed from V2
  for (const [id, req1] of mapV1.entries()) {
    if (!mapV2.has(id)) {
      removed.push(req1)
    }
  }

  const hasChanges = added.length > 0 || removed.length > 0 || modified.length > 0

  return {
    hasChanges,
    added,
    removed,
    modified,
    unchanged,
    stats: {
      totalV1: mapV1.size,
      totalV2: mapV2.size,
      addedCount: added.length,
      removedCount: removed.length,
      modifiedCount: modified.length,
      unchangedCount: unchanged.length,
    },
  }
}

/**
 * Generate formatted Markdown Changelog from diff result.
 */
export function generateSpecificationChangelog({
  versionFrom = 'v1.0.0',
  versionTo = 'v1.1.0',
  diffResult,
}) {
  const { added, removed, modified, stats } = diffResult

  let md = `# Specification Changelog: ${versionFrom} → ${versionTo}\n\n`
  md += `**Summary:** ${stats.addedCount} added, ${stats.modifiedCount} modified, ${stats.removedCount} removed, ${stats.unchangedCount} unchanged.\n\n`

  if (added.length > 0) {
    md += `## Added Requirements (${added.length})\n`
    for (const req of added) {
      md += `- **${req.id}**: ${req.title}\n`
    }
    md += '\n'
  }

  if (modified.length > 0) {
    md += `## Modified Requirements (${modified.length})\n`
    for (const mod of modified) {
      md += `- **${mod.id}**: ${mod.title} *(Scope / Criteria altered)*\n`
    }
    md += '\n'
  }

  if (removed.length > 0) {
    md += `## Removed Requirements (${removed.length})\n`
    for (const req of removed) {
      md += `- **${req.id}**: ${req.title} *(Deprecated / Removed)*\n`
    }
    md += '\n'
  }

  if (!diffResult.hasChanges) {
    md += `*No requirement modifications detected between ${versionFrom} and ${versionTo}.*\n`
  }

  return md.trim()
}
