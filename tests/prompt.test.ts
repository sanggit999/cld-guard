import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { buildContext, detectAreas, detectKeyword, parseBlacklist, parseGitStatus } from '../hooks/prompt-rules'

const MD = [
  '# CLAUDE.md',
  '## 📕 Sổ đen — lỗi đã gặp',
  '- Một dòng một lỗi, theo mẫu: `- [khu vực] Đừng ...`',
  '- [api] Đừng import thiếu .js',
  '- [fe] Đừng dùng next/link',
  '- [git] Đừng mở PR vào main',
  '## Mục khác',
  '- [api] không phải sổ đen',
].join('\n')

describe('prompt-rules', () => {
  test('đọc sổ đen, bỏ dòng hướng dẫn và mục khác', () => {
    expect(parseBlacklist(MD)).toEqual([
      { area: 'api', text: 'Đừng import thiếu .js' },
      { area: 'fe', text: 'Đừng dùng next/link' },
      { area: 'git', text: 'Đừng mở PR vào main' },
    ])
  })

  test('khu vực từ chữ trong prompt và file đang sửa', () => {
    expect(detectAreas('sửa màn admin sản phẩm', [])).toEqual(['cms'])
    expect(detectAreas('xem lỗi', ['fe/src/cms/x.tsx', 'api/prisma/schema.prisma'])).toEqual(['fe', 'cms', 'api', 'db'])
    expect(detectAreas('xin chào', [])).toEqual([])
  })

  test('git status --branch', () => {
    const g = parseGitStatus('## feature/x...origin/feature/x [ahead 1]\n M fe/a.tsx\n?? fe/b.tsx\nR  api/old.ts -> api/new.ts\n')
    expect(g.branch).toBe('feature/x')
    expect(g.files).toEqual(['fe/a.tsx', 'fe/b.tsx', 'api/new.ts'])
    expect(parseGitStatus('## dev\n').branch).toBe('dev')
  })

  test('từ khoá fix: / review:', () => {
    expect(detectKeyword('fix: trang tin tức 404')).toBe('fix')
    expect(detectKeyword('  Review: PR này')).toBe('review')
    expect(detectKeyword('fixed rồi')).toBeUndefined()
  })

  test('khối ngữ cảnh: chỉ sổ đen đúng khu vực; review lấy toàn bộ', () => {
    const blacklist = parseBlacklist(MD)
    const git = parseGitStatus('## dev\n M fe/a.tsx\n')
    const ctx = buildContext({ git, pendingText: 'Chưa kiểm: fe(build)', blacklist, areas: ['fe'], keyword: undefined }) ?? ''
    expect(ctx).toContain('Đang ở nhánh tích hợp')
    expect(ctx).toContain('Chưa kiểm: fe(build)')
    expect(ctx).toContain('[fe] Đừng dùng next/link')
    expect(ctx).not.toContain('[api]')
    const review = buildContext({ git: undefined, pendingText: undefined, blacklist, areas: [], keyword: 'review' }) ?? ''
    expect(review).toContain('[api]')
    expect(review).toContain('[git]')
    expect(buildContext({ git: undefined, pendingText: undefined, blacklist, areas: [], keyword: undefined })).toBeUndefined()
  })
})

const ROOT = 'D:/webmgo'

function fakeRepo(on: On) {
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.exists', (_$, e) => {
    const p = e.path.replace(/\\/g, '/')
    return { value: p === `${ROOT}/packages/shared/package.json` || p === `${ROOT}/CLAUDE.md` }
  })
  on('fs.read', (_$, e) => ({ value: e.path.replace(/\\/g, '/').endsWith('CLAUDE.md') ? MD : '{ "name": "@remak/shared" }' }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '## feature/x\n M api/src/a.ts\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
}

test('prompt của user được gắn khối ngữ cảnh, chữ giữ nguyên', async ($, on) => {
  fakeRepo(on)
  let seen: { text: string; context?: readonly string[] } | undefined
  on('prompt.submit', (_$, e) => {
    seen = { text: e.text, context: e.context }
    return { text: e.text, context: e.context }
  })
  await $.prompt.submit({ text: 'fix: lỗi phân trang tin tức', wait: false, origin: { kind: 'composer' } })
  expect(seen?.text).toBe('fix: lỗi phân trang tin tức')
  const ctx = seen?.context?.join('\n') ?? ''
  expect(ctx).toContain('Tái hiện')
  expect(ctx).toContain('`feature/x`')
  expect(ctx).toContain('[api] Đừng import thiếu .js')
})

test('prompt do plugin khác gửi thì không gắn gì', async ($, on) => {
  fakeRepo(on)
  let context: readonly string[] | undefined
  on('prompt.submit', (_$, e) => {
    context = e.context
    return { text: e.text }
  })
  await $.prompt.submit({ text: 'fix: x', wait: false, origin: { kind: 'plugin', name: 'other' } })
  expect(context).toBeUndefined()
})
