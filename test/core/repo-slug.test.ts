import { describe, expect, test } from 'bun:test'
import { repoSlug } from '@floor-agents/core'

describe('repoSlug', () => {
  test('owner and name, wherever the owner comes from', () => {
    expect(repoSlug({ repo: 'mtrl', owner: 'floor' })).toBe('floor/mtrl')
    expect(repoSlug({ repo: 'mtrl' }, 'floor')).toBe('floor/mtrl')
    expect(repoSlug({ repo: 'mtrl', owner: 'floor' }, 'someone-else')).toBe('floor/mtrl')
  })

  test('a repo already written in one piece is left alone', () => {
    expect(repoSlug({ repo: 'floor/mtrl', owner: 'ignored' })).toBe('floor/mtrl')
  })

  test('no owner anywhere: the name, which is all there is', () => {
    expect(repoSlug({ repo: 'mtrl' })).toBe('mtrl')
  })
})
