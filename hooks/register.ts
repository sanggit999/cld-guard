// cld-guard: code-guard + bash-guard + verify-status + prompt-context cho repo webmgo.
// Ngoài repo webmgo thì mọi hook chỉ chuyển tiếp, không làm gì.

import { atom, read, update, type EngineInterface, type Register } from 'claude-code'
import { checkBash, denyMessage, hasHardReason } from './bash-rules'
import { checkCode, isMigrationFile } from './code-rules'
import { buildContext, detectAreas, detectKeyword, parseBlacklist, parseGitStatus } from './prompt-rules'
import { parentOf, relToRepo, toSlash } from './repo'
import { addPending, checksDoneBy, checksForFile, removePending, statusText } from './verify'

const pending = atom({ plugin: 'cld-guard', key: 'pending' } as const, {})

let cached: { cwd: string; root: string | undefined } | undefined

/** Gốc repo webmgo (dấu `/`), hoặc `undefined` khi session không chạy trong repo này. */
async function findRepoRoot($: EngineInterface): Promise<string | undefined> {
  const cwd = toSlash(await $.session.cwd())
  if (cached?.cwd === cwd) return cached.root
  let root: string | undefined
  for (let dir: string | undefined = cwd; dir; dir = parentOf(dir)) {
    const marker = `${dir}/packages/shared/package.json`
    if (await $.fs.exists(marker)) {
      if ((await $.fs.read(marker)).includes('"@remak/shared"')) root = dir
      break
    }
  }
  cached = { cwd, root }
  return root
}

async function isTracked($: EngineInterface, root: string, rel: string): Promise<boolean> {
  const { exitCode } = await $.process.run(['git', 'ls-files', '--error-unmatch', rel], { cwd: root, timeoutMs: 10_000 })
  return exitCode === 0
}

function codeDeny(rel: string, problems: string[]): string {
  return [`code-guard (sổ đen CLAUDE.md): ${rel}`, ...problems.map(p => `- ${p}`), 'Sửa lại rồi gọi lại.'].join('\n')
}

const MIGRATION_DENY =
  'code-guard (sổ đen CLAUDE.md): không sửa/xoá migration đã commit. Tạo migration mới: sửa api/prisma/schema.prisma rồi `pnpm --filter api db:migrate`.'

export const register: Register = on => {
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const root = await findRepoRoot($)
    const rel = root && relToRepo(e.file_path, root)
    if (!root || !rel) return next(e)

    if (isMigrationFile(rel) && (await isTracked($, root, rel))) return { deny: MIGRATION_DENY }
    const problems = checkCode(rel, e.new_string, e.old_string)
    if (problems.length) return { deny: codeDeny(rel, problems) }

    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const now = await update($, pending, p => addPending(p, checksForFile(rel)))
      $.ui.status(statusText(now))
    }
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'cld-guard: code-guard gặp lỗi khi kiểm Edit.' }))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const root = await findRepoRoot($)
    const rel = root && relToRepo(e.file_path, root)
    if (!root || !rel) return next(e)

    if (isMigrationFile(rel) && (await isTracked($, root, rel))) return { deny: MIGRATION_DENY }
    // Ghi đè file cũ: chỉ tính vi phạm mới so với nội dung đang có
    const before = (await $.fs.exists(e.file_path)) ? await $.fs.read(e.file_path) : ''
    const problems = checkCode(rel, e.content, before)
    if (problems.length) return { deny: codeDeny(rel, problems) }

    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const now = await update($, pending, p => addPending(p, checksForFile(rel)))
      $.ui.status(statusText(now))
    }
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'cld-guard: code-guard gặp lỗi khi kiểm Write.' }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const root = await findRepoRoot($)
    if (!root) return next(e)

    const verdict = checkBash(e.command)
    const reasons = [...verdict.reasons]
    if (verdict.needsBranchCheck) {
      const { exitCode, stdout } = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: root,
        timeoutMs: 10_000,
      })
      const branch = stdout.trim()
      if (exitCode === 0 && (branch === 'dev' || branch === 'main'))
        reasons.push(`Đang ở nhánh \`${branch}\`: không push thẳng. Tạo nhánh feature/fix/chore rồi mở PR vào \`dev\`.`)
    }
    if (reasons.length) return { deny: denyMessage(reasons, !hasHardReason(e.command)) }

    const ran = await next(e)
    const ok =
      ran.deny === undefined &&
      ran.isError !== true &&
      ran.result.interrupted !== true &&
      ran.result.backgroundTaskId === undefined
    if (ok) {
      const done = checksDoneBy(e.command)
      if (Object.keys(done).length) {
        const now = await update($, pending, p => removePending(p, done))
        $.ui.status(statusText(now))
      }
    }
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'cld-guard: bash-guard gặp lỗi khi kiểm lệnh.' }))

  // prompt-context: gắn khối ngữ cảnh SAU prompt (e.context) thay vì sửa system prompt —
  // system prompt đổi mỗi lượt sẽ làm mất prompt cache của cả hội thoại.
  on('prompt.submit', async ($, e, next) => {
    const o = e.origin
    const fromUser = o.kind === 'composer' || o.kind === 'bridge' || (o.kind === 'plugin' && o.asUser === true)
    if (!fromUser || e.text.trimStart().startsWith('/')) return next(e)
    const root = await findRepoRoot($)
    if (!root) return next(e)

    const claudeMd = `${root}/CLAUDE.md`
    const [status, md, now] = await Promise.all([
      $.process.run(['git', 'status', '--porcelain=v1', '--branch'], { cwd: root, timeoutMs: 10_000 }),
      $.fs.exists(claudeMd).then(ok => (ok ? $.fs.read(claudeMd) : '')),
      read($, pending),
    ])
    const git = status.exitCode === 0 ? parseGitStatus(status.stdout) : undefined
    const keyword = detectKeyword(e.text)
    const block = buildContext({
      git,
      pendingText: statusText(now),
      blacklist: parseBlacklist(md),
      areas: detectAreas(e.text, git?.files ?? []),
      keyword,
    })
    if (!block) return next(e)
    if (keyword) $.ui.toast(`cld-guard: đã mở rộng \`${keyword}:\``)
    return next({ ...e, context: [...(e.context ?? []), block] })
  }).catch(($, e, next) => next(e)) // lỗi thì cho prompt đi nguyên vẹn, không chặn user

  // Hot reload / resume: dựng lại dòng status từ state đã lưu
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (await findRepoRoot($)) $.ui.status(statusText(await read($, pending)))
    return result
  })
}
