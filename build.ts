#!/usr/bin/env bun
/**
 * Bundle @floor/agents for publication with code splitting: the shared engine is
 * emitted once as a chunk that BOTH the library entry (dist/index.js) and the CLI
 * entry (dist/cli.js) import — no duplication. Zero runtime dependencies, Bun
 * target, minified (--keep-names for readable stack traces).
 *
 *   bun run build  →  dist/index.js (library) + dist/cli.js (bin) + shared chunk
 */
import { rm, rename, chmod, readFile, writeFile } from 'node:fs/promises'

await rm('dist', { recursive: true, force: true })

// Build both entries together so Bun extracts the shared engine into one chunk.
const proc = Bun.spawn([
  'bun', 'build', 'src/index.ts', 'src/main.ts',
  '--target', 'bun', '--minify', '--keep-names', '--splitting', '--outdir', 'dist',
], { stdout: 'inherit', stderr: 'inherit' })
if ((await proc.exited) !== 0) {
  console.error('build failed')
  process.exit(1)
}

// The CLI entry is emitted as main.js — rename it to the published bin name and
// make it an executable (shebang + +x). It imports the shared chunk, untouched.
await rename('dist/main.js', 'dist/cli.js')
const cli = await readFile('dist/cli.js', 'utf8')
await writeFile('dist/cli.js', `#!/usr/bin/env bun\n${cli}`)
await chmod('dist/cli.js', 0o755)

// Type declarations: a single self-contained rollup matching dist/index.js
// (the @floor-agents/* internal types are inlined, so consumers get full types).
const dts = Bun.spawn(
  ['./node_modules/.bin/dts-bundle-generator', '-o', 'dist/index.d.ts', '--no-check', 'src/index.ts'],
  { stdout: 'inherit', stderr: 'inherit' },
)
if ((await dts.exited) !== 0) {
  console.error('type declaration generation failed')
  process.exit(1)
}

console.log('✓ dist/index.js + dist/cli.js + dist/index.d.ts + shared chunk')
