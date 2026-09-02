import { test, expect } from 'bun:test'
import {
  attributeImplementerVendor,
  DEFAULT_VENDOR_CONFIG,
  type VendorAttributionConfig,
} from '../../../packages/orchestrator/src/gate/vendor.ts'

test('a vendor: label wins over everything else', () => {
  const vendor = attributeImplementerVendor({
    headRef: 'cursor/some-branch',
    body: 'Claude-Session: https://claude.ai/code/session_x',
    labels: ['vendor:codex', 'parity'],
  })
  expect(vendor).toBe('codex')
})

test('branch prefix rule applies when there is no vendor label', () => {
  const vendor = attributeImplementerVendor({
    headRef: 'cursor/add-thing',
    body: '',
    labels: ['parity'],
  })
  expect(vendor).toBe('grok')
})

test('branch prefix wins over a body marker', () => {
  const vendor = attributeImplementerVendor({
    headRef: 'cursor/add-thing',
    body: 'Claude-Session: https://claude.ai/code/session_x',
    labels: [],
  })
  expect(vendor).toBe('grok')
})

test('body marker rule applies when label and branch rules do not match', () => {
  const vendor = attributeImplementerVendor({
    headRef: 'feat/add-thing',
    body: [
      'Some PR description.',
      '',
      'Claude-Session: https://claude.ai/code/session_x',
    ].join('\n'),
    labels: [],
  })
  expect(vendor).toBe('claude')
})

test('body marker must START a line, not just appear as a substring', () => {
  const vendor = attributeImplementerVendor({
    headRef: 'feat/add-thing',
    body: 'See Claude-Session: mentioned mid-sentence, not at line start.',
    labels: [],
  })
  expect(vendor).toBe('human')
})

test('defaults to human when nothing matches', () => {
  const vendor = attributeImplementerVendor({
    headRef: 'feat/add-thing',
    body: 'A normal human-written PR body.',
    labels: ['parity'],
  })
  expect(vendor).toBe('human')
})

test('custom config: first matching branch-prefix rule wins, in config order', () => {
  const config: VendorAttributionConfig = {
    branchPrefixes: [
      { prefix: 'bot/', vendor: 'vendor-a' },
      { prefix: 'bot/special/', vendor: 'vendor-b' },
    ],
    bodyMarkers: [],
  }
  const vendor = attributeImplementerVendor(
    { headRef: 'bot/special/thing', body: '', labels: [] },
    config,
  )
  expect(vendor).toBe('vendor-a')
})

test('custom labelPrefix is honored', () => {
  const config: VendorAttributionConfig = {
    labelPrefix: 'impl:',
    branchPrefixes: [],
    bodyMarkers: [],
  }
  const vendor = attributeImplementerVendor(
    { headRef: 'feat/x', body: '', labels: ['impl:gemini'] },
    config,
  )
  expect(vendor).toBe('gemini')
})

test('DEFAULT_VENDOR_CONFIG is used when no config is passed', () => {
  const vendor = attributeImplementerVendor({ headRef: 'cursor/x', body: '', labels: [] })
  expect(vendor).toBe(DEFAULT_VENDOR_CONFIG.branchPrefixes[0]!.vendor)
})
