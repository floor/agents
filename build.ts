#!/usr/bin/env bun
/**
 * Bundle @floor/agents for publication. The internal @floor-agents/* workspace
 * packages are inlined into a single self-contained output; third-party runtime
 * deps stay external (declared in package.json dependencies). Bun runtime target.
 *
 *   bun run build   →  dist/index.js (library) + dist/cli.js (bin)
 */
import { rm, chmod } from 'node:fs/promises'

const EXTERNAL = ['yaml', '@modelcontextprotocol/sdk', 'zod']
const externalArgs = EXTERNAL.flatMap(p => ['--external', p])

await rm('dist', { recursive: true, force: true })

async function bundle(entry: string, outfile: string, banner?: string): Promise<void> {
  const args = ['build', entry, '--outfile', outfile, '--target', 'bun', ...externalArgs]
  if (banner) args.push(`--banner=${banner}`)
  const proc = Bun.spawn(['bun', ...args], { stdout: 'inherit', stderr: 'inherit' })
  if ((await proc.exited) !== 0) {
    console.error(`build failed: ${entry}`)
    process.exit(1)
  }
}

// Runtime bundles (internals inlined; yaml/sdk/zod stay external)
await bundle('src/index.ts', 'dist/index.js')
await bundle('src/main.ts', 'dist/cli.js', '#!/usr/bin/env bun')
await chmod('dist/cli.js', 0o755)

console.log('✓ dist/index.js + dist/cli.js')
