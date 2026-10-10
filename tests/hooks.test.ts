import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = 'D:/webmgo'

/** Giả lập session đang chạy trong repo webmgo (cwd, file đánh dấu, git). */
function fakeRepo(on: On, branch = 'feature/x') {
  on('session.cwd', () => ({ value: ROOT }))
  // Engine chuẩn hoá đường dẫn theo hệ điều hành (Windows: dấu \)
  on('fs.exists', (_$, e) => ({ value: e.path.replace(/\\/g, '/') === `${ROOT}/packages/shared/package.json` }))
  on('fs.read', () => ({ value: '{ "name": "@remak/shared" }' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: `${branch}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
}

test('Edit vi phạm sổ đen bị chặn, tool không chạy', async ($, on) => {
  fakeRepo(on)
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: { filePath: '', oldString: '', newString: '', originalFile: '', structuredPatch: [], userModified: false, replaceAll: false } }
  })
  const res = await $.tool.call({
    tool: 'Edit',
    file_path: `${ROOT}/api/src/a.service.ts`,
    old_string: 'const a = 1',
    new_string: "import { B } from './b.service'",
  })
  expect(res.deny).toContain('code-guard')
  expect(ran).toBe(false)
})

test('Edit hợp lệ chạy bình thường', async ($, on) => {
  fakeRepo(on)
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: { filePath: '', oldString: '', newString: '', originalFile: '', structuredPatch: [], userModified: false, replaceAll: false } }
  })
  const res = await $.tool.call({
    tool: 'Edit',
    file_path: `${ROOT}/api/src/a.service.ts`,
    old_string: 'const a = 1',
    new_string: "import { B } from './b.service.js'",
  })
  expect(res.deny).toBeUndefined()
  expect(ran).toBe(true)
})

test('git push khi đang ở dev bị chặn', async ($, on) => {
  fakeRepo(on, 'dev')
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  const res = await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(res.deny).toContain('nhánh `dev`')
})

test('ngoài repo webmgo thì không chặn gì', async ($, on) => {
  on('session.cwd', () => ({ value: 'C:/other' }))
  on('fs.exists', () => ({ value: false }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  const res = await $.tool.call({ tool: 'Bash', command: 'npm install' })
  expect(res.deny).toBeUndefined()
})
