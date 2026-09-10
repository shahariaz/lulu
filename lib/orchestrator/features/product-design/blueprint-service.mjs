export function blueprintToSpecMarkdown(projectName, blueprint, marketResearch = null) {
  const requirements = blueprint.prd.requirements.map((requirement) => [
    `### ${requirement.id}: ${requirement.title}`, `**Priority:** ${requirement.priority}`, '',
    requirement.description, '', '**Acceptance Criteria**',
    ...requirement.acceptanceCriteria.map((criterion) => `- ${criterion}`),
  ].join('\n')).join('\n\n')
  const sources = (marketResearch?.sources || []).map((source) => `- [${source.title}](${source.url})`).join('\n')
  return `# Product Requirements Document: ${projectName}

Version: v1.0.0
Author: Claude-Zen Product Council

## Executive Summary

${blueprint.prd.executiveSummary}

## In Scope

${blueprint.prd.inScope.map((item) => `- ${item}`).join('\n')}

## Out of Scope

${blueprint.prd.outOfScope.map((item) => `- ${item}`).join('\n')}

## Market Position

${blueprint.market.coreValueProp}

${blueprint.market.uniqueDifferentiators.map((item) => `- ${item}`).join('\n')}

## Requirements

${requirements}

## Architecture

${blueprint.architecture.techStack}

## Research Sources

${sources || '- No sources were persisted.'}
`
}
