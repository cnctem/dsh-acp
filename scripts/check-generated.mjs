// Fail when TypeScript compilation changes committed lib/ output. Hashing all
// files before and after the build checks freshness without requiring a clean
// git worktree, so it also works during a migration commit.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const lib = join(root, 'lib')

function snapshot(dir, base = dir) {
  const result = new Map()
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      for (const [key, value] of snapshot(path, base)) result.set(key, value)
    } else {
      const bytes = readFileSync(path)
      result.set(relative(base, path), createHash('sha256').update(bytes).digest('hex'))
    }
  }
  return result
}

const before = snapshot(lib)
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
  cwd: root,
  stdio: 'inherit',
})
const after = snapshot(lib)
const keys = [...new Set([...before.keys(), ...after.keys()])].sort()
const changed = keys.filter((key) => before.get(key) !== after.get(key))
if (changed.length > 0) {
  console.error(`lib/ is stale; build changed: ${changed.join(', ')}`)
  process.exit(1)
}
console.log('lib/ generated output is current')
