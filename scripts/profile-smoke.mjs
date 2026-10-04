// Real-profile acceptance test for the bundled ACP bridge. It installs this
// repository into a temporary DSH_HOME and drives the actual dsh CLI over stdio.
//
// Run: pnpm run test:profile

import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH = process.env.DSH_BIN ?? 'dsh'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function launch(extraEnv = {}) {
  const child = spawn(DSH, ['--profile', 'acp'], {
    cwd: REPO,
    env: { ...process.env, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const rl = readline.createInterface({ input: child.stdout })
  const pending = new Map()
  let stderr = ''
  let nextId = 0
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  rl.on('line', (line) => {
    if (!line.trim()) return
    const frame = JSON.parse(line)
    if (frame.id !== undefined && pending.has(frame.id)) {
      const resolveResponse = pending.get(frame.id)
      pending.delete(frame.id)
      resolveResponse(frame)
    }
  })
  const request = (method, params) => new Promise((resolveRequest, rejectRequest) => {
    const id = ++nextId
    const timeout = setTimeout(() => {
      pending.delete(id)
      rejectRequest(new Error(`${method} timed out; stderr=${stderr}`))
    }, 20_000)
    pending.set(id, (frame) => {
      clearTimeout(timeout)
      if (frame.error !== undefined) rejectRequest(new Error(`${method} failed: ${JSON.stringify(frame.error)}; stderr=${stderr}`))
      else resolveRequest(frame.result)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  return {
    request,
    async close() {
      child.stdin.end()
      await new Promise((resolveClose) => child.once('close', resolveClose))
      assert(!stderr.includes('incompatible with dsh'), `profile rejected the bundle:\n${stderr}`)
    },
  }
}

async function lifecycle(home) {
  const dsh = await launch({ DSH_HOME: home })
  try {
    const initialized = await dsh.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    assert(initialized.agentInfo?.name === 'dsh-acp', 'custom bridge did not answer initialize')
    assert(initialized.agentCapabilities?.sessionCapabilities?.resume !== undefined, 'resume capability missing')
    assert(initialized.agentCapabilities?.sessionCapabilities?.close !== undefined, 'close capability missing')

    const created = await dsh.request('session/new', { cwd: REPO, mcpServers: [] })
    const sessionId = created.sessionId
    assert(typeof sessionId === 'string' && sessionId.length > 0, 'session/new failed')
    await dsh.request('session/close', { sessionId })
    const listed = await dsh.request('session/list', {})
    assert(listed.sessions.some((item) => item.sessionId === sessionId), 'closed session missing from session/list')
    await dsh.request('session/resume', { sessionId, cwd: REPO, mcpServers: [] })
    await dsh.request('session/close', { sessionId })
    await dsh.request('session/delete', { sessionId })
  } finally {
    await dsh.close()
  }
}

async function preset(home, id) {
  const dsh = await launch({ DSH_HOME: home, DSH_ACP_PRESET: id })
  try {
    const created = await dsh.request('session/new', { cwd: REPO, mcpServers: [] })
    assert(typeof created.sessionId === 'string', `preset ${id} did not create a session`)
    await dsh.request('session/close', { sessionId: created.sessionId })
  } finally {
    await dsh.close()
  }
  console.log(`profile preset ${id} -> OK`)
}

const home = await mkdtemp(join(tmpdir(), 'dsh-acp-profile-'))
try {
  execFileSync(DSH, ['plugin', '--profile', 'acp', 'add', REPO], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: home },
    stdio: 'inherit',
  })
  const dump = execFileSync(DSH, ['--profile', 'acp', '--dump-config'], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
  assert(dump.includes("id: acp-editor\n  name: '@cnctem/dsh-acp'"), 'custom bridge row missing from dump')
  assert(dump.includes('id: preset-cordis'), 'cordis preset missing from dump')
  const help = execFileSync(DSH, ['--profile', 'acp', '--help'], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
  assert(help.includes('Serve automation clients over Agent Client Protocol stdio'), 'ACP help path did not mount')

  await lifecycle(home)
  for (const id of ['standard', 'ptc', 'minimal', 'cordis']) await preset(home, id)
  console.log('PROFILE SMOKE TEST PASSED')
} finally {
  await rm(home, { recursive: true, force: true })
}
