import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  SshExecTransport,
  StreamLocalTransport,
  assertSafeShotPath,
  classifyExit,
  firstJsonLine,
  shellQuote,
} from '../lib/transport.js'
import {
  PNG,
  cleanupDir,
  makeFakeSpawn,
  makeTmpDir,
  makeTransportCfg,
  touchFile,
} from './helpers.mjs'

function setupSpawn(spawnOptions = {}, cfgOverrides = {}) {
  const dir = makeTmpDir('transport')
  const cfg = makeTransportCfg(dir, cfgOverrides)
  const spawnImpl = makeFakeSpawn(spawnOptions)
  const transport = new SshExecTransport(cfg, { spawnImpl })
  return { dir, cfg, spawnImpl, transport }
}

test('SSH 参数：key / port / StrictHostKeyChecking / known_hosts / 远程 node 命令', () => {
  const { dir, cfg, spawnImpl, transport } = setupSpawn()
  const args = transport.buildSshArgs()
  assert.equal(args[0], '-i')
  assert.equal(args[1], cfg.sshKeyPath)
  assert.deepEqual(args.slice(2, 4), ['-p', '2222'])
  assert.ok(args.includes('BatchMode=yes'))
  assert.ok(args.includes('StrictHostKeyChecking=yes'))
  assert.ok(args.includes(`UserKnownHostsFile=${cfg.knownHosts}`))
  assert.equal(args[args.length - 2], `root@${cfg.sshHost}`)
  assert.equal(
    args[args.length - 1],
    'PATH=/manager/extensions/harness/program/node/bin:$PATH node /persistent/cdp/client-stdin.js',
  )
  assert.equal(spawnImpl.calls.length, 0) // 只构造参数，不 spawn
  cleanupDir(dir)
})

test('request：JSON 只走 stdin 一行，读 stdout 一行 JSON；不拼 shell', async () => {
  const stdout = '{"ok":true,"cmd":"ping","result":{"proto":"1.0","browser":true,"pages":2}}\n'
  const { dir, spawnImpl, transport } = setupSpawn({ stdout })
  const res = await transport.request({ cmd: 'ping' })
  assert.deepEqual(res, { ok: true, cmd: 'ping', result: { proto: '1.0', browser: true, pages: 2 } })
  assert.equal(spawnImpl.calls.length, 1)
  const call = spawnImpl.calls[0]
  assert.equal(call.cmd, 'ssh')
  assert.equal(call.child.stdin.written, '{"cmd":"ping"}\n')
  assert.equal(call.opts.stdio[0], 'pipe')
  cleanupDir(dir)
})

test('pressKey：默认先聚焦再按键；只允许 z/x/c，不拼任意按键', async () => {
  const { dir, spawnImpl, transport } = setupSpawn()
  await transport.pressKey('z')
  assert.equal(spawnImpl.calls.length, 2, '一次聚焦 + 一次按键')
  const focusCmd = spawnImpl.calls[0].args[spawnImpl.calls[0].args.length - 1]
  assert.match(focusCmd, /getwindowgeometry/)
  assert.match(focusCmd, /mousemove/)
  const keyCmd = spawnImpl.calls[1].args[spawnImpl.calls[1].args.length - 1]
  assert.match(keyCmd, /DISPLAY=':20'/)
  assert.match(keyCmd, /xdotool key --clearmodifiers --delay 50 'z'/)

  // focus:false 只发按键
  const before = spawnImpl.calls.length
  await transport.pressKey('c', { focus: false })
  assert.equal(spawnImpl.calls.length, before + 1)
  const onlyKey = spawnImpl.calls[spawnImpl.calls.length - 1].args.at(-1)
  assert.match(onlyKey, /xdotool key --clearmodifiers --delay 50 'c'/)
  assert.match(onlyKey, /DISPLAY=':20'/)

  await assert.rejects(() => transport.pressKey('q'), (e) => e.code === 'E_BAD_ARG')
  await assert.rejects(() => transport.pressKey('Enter'), (e) => e.code === 'E_BAD_ARG')
  cleanupDir(dir)
})

test('pasteText：文本走 stdin 写临时文件，再 xclip + ctrl+v（不拼中文到 shell）', async () => {
  const { dir, spawnImpl, transport } = setupSpawn()
  await transport.pasteText('中文粘贴测试')
  assert.equal(spawnImpl.calls.length, 3)
  assert.match(spawnImpl.calls[0].args[spawnImpl.calls[0].args.length - 1], /command -v xclip/)
  const writeCmd = spawnImpl.calls[1].args[spawnImpl.calls[1].args.length - 1]
  assert.match(writeCmd, /cat > '\/tmp\/dsh-douyin-clip.txt'/)
  assert.equal(spawnImpl.calls[1].child.stdin.written, '中文粘贴测试')
  const pasteCmd = spawnImpl.calls[2].args[spawnImpl.calls[2].args.length - 1]
  assert.match(pasteCmd, /xclip -selection clipboard -i/)
  assert.match(pasteCmd, /xdotool key --clearmodifiers ctrl\+v/)
  assert.match(pasteCmd, /rm -f/)
  cleanupDir(dir)
})

test('缺私钥：E_SSH_AUTH，且不 spawn（启动/调用都不依赖远程）', async () => {
  const dir = makeTmpDir('nokey')
  const cfg = makeTransportCfg(dir, { sshKeyPath: join(dir, 'missing-key') })
  const spawnImpl = makeFakeSpawn()
  const transport = new SshExecTransport(cfg, { spawnImpl })
  await assert.rejects(
    transport.request({ cmd: 'ping' }),
    (e) => e.code === 'E_SSH_AUTH' && /私钥不存在/.test(e.message),
  )
  assert.equal(spawnImpl.calls.length, 0)
  cleanupDir(dir)
})

test('缺 known_hosts：E_SSH_AUTH，不 spawn', async () => {
  const dir = makeTmpDir('nokh')
  const cfg = makeTransportCfg(dir, { knownHosts: join(dir, 'missing-known_hosts') })
  const spawnImpl = makeFakeSpawn()
  const transport = new SshExecTransport(cfg, { spawnImpl })
  await assert.rejects(
    transport.request({ cmd: 'title' }),
    (e) => e.code === 'E_SSH_AUTH' && /known_hosts/.test(e.message),
  )
  assert.equal(spawnImpl.calls.length, 0)
  cleanupDir(dir)
})

test('超时：杀子进程；open 用 E_OPEN_TIMEOUT，其余 E_TIMEOUT', async () => {
  const { dir, spawnImpl, transport } = setupSpawn(
    { hold: true },
    { openTimeoutMs: 20, callTimeoutMs: 20 },
  )
  await assert.rejects(
    transport.request({ cmd: 'open', url: 'https://www.douyin.com/' }),
    (e) => e.code === 'E_OPEN_TIMEOUT',
  )
  assert.equal(spawnImpl.calls[0].child.killed, true)

  await assert.rejects(
    transport.request({ cmd: 'ping' }),
    (e) => e.code === 'E_TIMEOUT',
  )
  assert.equal(spawnImpl.calls[1].child.killed, true)
  cleanupDir(dir)
})

test('SSH 认证失败 / 连接失败 / 坏 JSON / spawn ENOENT 的错误码', async () => {
  {
    const { dir, transport } = setupSpawn({ stderr: 'root@host: Permission denied (publickey).', code: 255 })
    await assert.rejects(transport.request({ cmd: 'ping' }), (e) => e.code === 'E_SSH_AUTH')
    cleanupDir(dir)
  }
  {
    const { dir, transport } = setupSpawn({ stderr: 'ssh: connect to host x port 2222: Connection refused', code: 255 })
    await assert.rejects(transport.request({ cmd: 'ping' }), (e) => e.code === 'E_BRIDGE_DOWN')
    cleanupDir(dir)
  }
  {
    const { dir, transport } = setupSpawn({ stdout: 'not-json\n' })
    await assert.rejects(transport.request({ cmd: 'ping' }), (e) => e.code === 'E_PARSE')
    cleanupDir(dir)
  }
  {
    const { dir, transport } = setupSpawn({
      stderr: "node: cannot find module '/persistent/cdp/client-stdin.js'",
      code: 1,
    })
    await assert.rejects(transport.request({ cmd: 'ping' }), (e) => e.code === 'E_BRIDGE_DOWN')
    cleanupDir(dir)
  }
  {
    const dir = makeTmpDir('enoent')
    const cfg = makeTransportCfg(dir)
    const spawnImpl = () => {
      const e = new Error('spawn ssh ENOENT')
      e.code = 'ENOENT'
      throw e
    }
    const transport = new SshExecTransport(cfg, { spawnImpl })
    await assert.rejects(transport.request({ cmd: 'ping' }), (e) => e.code === 'E_BRIDGE_DOWN')
    cleanupDir(dir)
  }
})

test('request：退出码非 0 但 stdout 有合法 JSON 时按桥应答处理', async () => {
  const { dir, transport } = setupSpawn({
    stdout: '{"ok":false,"cmd":"open","error":"timeout"}\n',
    stderr: 'some warning',
    code: 1,
  })
  const res = await transport.request({ cmd: 'open', url: 'https://www.douyin.com/' })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'timeout')
  cleanupDir(dir)
})

test('readFile：cat 取回 PNG；路径白名单；超限杀进程', async () => {
  {
    const { dir, spawnImpl, transport } = setupSpawn({ stdout: PNG })
    const buf = await transport.readFile('/persistent/cdp/shots/shot-1.png')
    assert.deepEqual(buf, PNG)
    const command = spawnImpl.calls[0].args[spawnImpl.calls[0].args.length - 1]
    assert.equal(command, "cat -- '/persistent/cdp/shots/shot-1.png'")
    cleanupDir(dir)
  }
  {
    const { dir, spawnImpl, transport } = setupSpawn()
    await assert.rejects(
      transport.readFile('/persistent/cdp/shots/../../etc/passwd'),
      (e) => e.code === 'E_REMOTE_IO',
    )
    await assert.rejects(transport.readFile('/tmp/shot.png'), (e) => e.code === 'E_REMOTE_IO')
    assert.equal(spawnImpl.calls.length, 0)
    cleanupDir(dir)
  }
  {
    const big = Buffer.alloc(64)
    const { dir, spawnImpl, transport } = setupSpawn({ stdout: big })
    await assert.rejects(
      transport.readFile('/persistent/cdp/shots/shot-big.png', { maxBytes: 16 }),
      (e) => e.code === 'E_REMOTE_IO',
    )
    assert.equal(spawnImpl.calls[0].child.killed, true)
    cleanupDir(dir)
  }
})

test('readFile：远程 cat 失败返回 E_REMOTE_IO', async () => {
  const { dir, transport } = setupSpawn({ stderr: 'cat: no such file', code: 1 })
  await assert.rejects(
    transport.readFile('/persistent/cdp/shots/missing.png'),
    (e) => e.code === 'E_REMOTE_IO',
  )
  cleanupDir(dir)
})

test('streamlocal 仅占位：明确 E_BRIDGE_DOWN，不偷偷回退', async () => {
  const transport = new StreamLocalTransport({})
  await assert.rejects(transport.request({ cmd: 'ping' }), (e) => e.code === 'E_BRIDGE_DOWN')
  await assert.rejects(transport.readFile('/persistent/cdp/shots/a.png'), (e) => e.code === 'E_BRIDGE_DOWN')
})

test('纯工具函数：firstJsonLine / shellQuote / assertSafeShotPath / classifyExit', () => {
  assert.equal(firstJsonLine('\n {"a":1}\n{"b":2}'), '{"a":1}')
  assert.equal(firstJsonLine('   '), '')
  assert.equal(shellQuote("a'b"), `'a'\\''b'`)
  assert.equal(
    assertSafeShotPath('/persistent/cdp/shots/a-1.png', '/persistent/cdp/shots'),
    '/persistent/cdp/shots/a-1.png',
  )
  assert.throws(() => assertSafeShotPath('/persistent/cdp/shots/a.jpg', '/persistent/cdp/shots'), /不合法/)
  assert.equal(classifyExit(255, 'Permission denied (publickey)').code, 'E_SSH_AUTH')
  assert.equal(classifyExit(255, 'Connection refused').code, 'E_BRIDGE_DOWN')
  assert.equal(classifyExit(1, 'whatever').code, 'E_REMOTE_IO')
})
