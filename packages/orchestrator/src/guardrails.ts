import type { AgentOutput, GuardrailsConfig, GuardrailViolation } from '@floor-agents/core'

export function validateAgentOutput(
  output: AgentOutput,
  guardrails: GuardrailsConfig,
): readonly GuardrailViolation[] {
  const violations: GuardrailViolation[] = []
  const encoder = new TextEncoder()

  // File count
  if (output.files.length > guardrails.maxFilesPerTask) {
    violations.push({
      type: 'too_many_files',
      detail: `${output.files.length} files exceeds limit of ${guardrails.maxFilesPerTask}`,
    })
  }

  let totalSize = 0

  for (const file of output.files) {
    const size = encoder.encode(file.content).length

    // Path traversal
    if (file.path.startsWith('/') || file.path.includes('..')) {
      violations.push({
        type: 'path_traversal',
        detail: `Path contains traversal: ${file.path}`,
        file: file.path,
      })
    }

    // File size
    if (size > guardrails.maxFileSizeBytes) {
      violations.push({
        type: 'file_too_large',
        detail: `${file.path} is ${size} bytes (limit: ${guardrails.maxFileSizeBytes})`,
        file: file.path,
      })
    }

    totalSize += size

    // Blocked extensions
    for (const ext of guardrails.blockedExtensions) {
      if (file.path.endsWith(ext)) {
        violations.push({
          type: 'blocked_extension',
          detail: `${file.path} has blocked extension "${ext}"`,
          file: file.path,
        })
      }
    }

    // Blocked paths (glob matching)
    for (const pattern of guardrails.blockedPaths) {
      const glob = new Bun.Glob(pattern)
      if (glob.match(file.path)) {
        violations.push({
          type: 'blocked_path',
          detail: `${file.path} matches blocked pattern "${pattern}"`,
          file: file.path,
        })
      }
    }

    // Allowed paths (if specified, file must match at least one)
    if (guardrails.allowedPaths.length > 0) {
      const allowed = guardrails.allowedPaths.some(pattern => {
        const glob = new Bun.Glob(pattern)
        return glob.match(file.path)
      })
      if (!allowed) {
        violations.push({
          type: 'outside_allowed_paths',
          detail: `${file.path} is not in any allowed path`,
          file: file.path,
        })
      }
    }
  }

  // Total size
  if (totalSize > guardrails.maxTotalOutputBytes) {
    violations.push({
      type: 'total_too_large',
      detail: `Total output ${totalSize} bytes exceeds limit of ${guardrails.maxTotalOutputBytes}`,
    })
  }

  return violations
}
