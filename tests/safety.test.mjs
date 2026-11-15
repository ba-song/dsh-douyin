import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LIB = join(ROOT, 'lib')

test('package.json：main/exports 指向真实文件，无未安装的 npm 依赖', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.ok(existsSync(join(ROOT, pkg.main)))
  assert.ok(existsSync(join(ROOT, 'cordis.patch.yml')))
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.peerDependencies, undefined)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
})

// 由 DSH 宿主提供的模块（与 dsh-channel-bridge 同样的生态；插件自己不带 node_modules）
const HOST_MODULES = new Set(['@deepseek-ai/schemastery'])

test('lib 只 import Node 内置 / 相对模块 / DSH 宿主模块（无未安装的第三方包）', () => {
  for (const file of readdirSync(LIB).filter((f) => f.endsWith('.js'))) {
    const text = readFileSync(join(LIB, file), 'utf8')
    for (const match of text.matchAll(/^import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
      const spec = match[1]
      assert.ok(
        spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../') || HOST_MODULES.has(spec),
        `${file} 导入了非内置/非相对/非宿主模块：${spec}`,
      )
    }
  }
})

test('cordis.patch.yml 只是单条示例 insert（不写 profile、不重复注册）', () => {
  const text = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(text, /^- insert:/m)
  assert.match(text, /id: douyin/m)
  assert.match(text, /name: dsh-douyin/m)
  assert.equal((text.match(/- id:/g) ?? []).length, 1)
  assert.equal((text.match(/name: dsh-douyin/g) ?? []).length, 1)
})

test('新进程 import 入口：无连 SSH / 无定时器，进程能正常退出', () => {
  const code = `import(${JSON.stringify(new URL('../lib/index.js', import.meta.url).href)}).then(m => { console.log(m.name); }).catch(e => { console.error(e); process.exit(1) })`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    timeout: 5000,
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /dsh-douyin/)
})

test('源码没有 import 阶段可执行的顶层 await / setInterval', () => {
  for (const file of readdirSync(LIB).filter((f) => f.endsWith('.js'))) {
    const text = readFileSync(join(LIB, file), 'utf8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!/^\S/.test(line)) continue // 只看顶格语句
      assert.ok(!/^\s*(?:await\s|setInterval\s*\(|setTimeout\s*\()/.test(line), `${file}:${i + 1} 顶层副作用`)
    }
  }
})
