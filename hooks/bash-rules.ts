// bash-guard: lệnh phá dữ liệu hoặc sai quy ước của repo webmgo. Hàm thuần để test trực tiếp.

/** Đuôi lệnh cho biết user ĐÃ đồng ý rõ ràng trong chat. */
export const APPROVAL_MARKER = '# user-approved'

export type BashVerdict = {
  /** Lý do chặn, rỗng nghĩa là cho chạy. */
  reasons: string[]
  /** Có cần hỏi nhánh hiện tại (git push không ghi refspec) không. */
  needsBranchCheck: boolean
}

/** Bỏ nội dung trong '...' / "..." và thân heredoc, để chữ trong commit message hay chuỗi echo không bị bắt nhầm. */
export function stripQuoted(cmd: string): string {
  let out = cmd.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, '<<HEREDOC')
  out = out.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
  return out
}

/** Tách lệnh ghép thành từng lệnh đơn theo `&&`, `||`, `;`, `|`, xuống dòng. */
export function splitCommands(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||[;\n|]/)
    .map(s => s.trim())
    .filter(Boolean)
}

const SAFE_RM_TARGET =
  /(^|\/)(dist|\.next|coverage|\.turbo|node_modules\/\.cache|tmp|\.tmp)(\/|$)|AppData\/Local\/Temp|scratchpad/i

function checkRm(part: string): boolean {
  const tokens = part.split(/\s+/)
  if (tokens[0] !== 'rm') return false
  const flags = tokens.filter(t => t.startsWith('-'))
  const recursive = flags.some(f => f === '--recursive' || (/^-[a-zA-Z]+$/.test(f) && /[rR]/.test(f)))
  if (!recursive) return false
  const targets = tokens.slice(1).filter(t => !t.startsWith('-'))
  return targets.length === 0 || targets.some(t => !SAFE_RM_TARGET.test(t.replace(/\\/g, '/')))
}

const PROTECTED_BRANCH = /^(?:\+?(?:[^:]*:)?)(?:refs\/heads\/)?(dev|main)$/

export function checkBash(command: string): BashVerdict {
  const approved = command.trimEnd().endsWith(APPROVAL_MARKER)
  const plain = stripQuoted(command)
  const parts = splitCommands(plain)
  const hard: string[] = []
  const soft: string[] = []
  let needsBranchCheck = false

  for (const part of parts) {
    // B1: seed đè tài khoản admin/editor về mật khẩu mặc định
    if (/\bdb:seed(?![:\w])|\bprisma\s+db\s+seed\b|prisma\/seed\.ts\b/.test(part))
      soft.push(
        'Seed toàn bộ (db:seed / prisma db seed) upsert lại tài khoản admin/editor về mật khẩu mặc định và tải ảnh lên MinIO theo .env. Chỉ nạp tin tức: `pnpm --filter api db:seed:news`. Seed DB tạm thì đặt cả DATABASE_URL và MINIO_BUCKET=<bucket-tam>.',
      )

    // B2: repo dùng pnpm
    if (/^(?:npx\s+)?npm\s+(install|i|ci|add|run|exec|uninstall|un|remove|rm|update|up)\b/.test(part) || /^yarn\b/.test(part))
      hard.push('Repo dùng pnpm (Node 24): `pnpm install` ở root, `pnpm --filter <package> <script>` / `pnpm --filter <package> add <dep>`.')

    // B4: lệnh git không lấy lại được
    if (/^git\s+reset\b.*--hard\b/.test(part)) soft.push('`git reset --hard` xoá thay đổi chưa commit.')
    if (/^git\s+clean\b.*\s-[a-zA-Z]*f/.test(part)) soft.push('`git clean -f` xoá file chưa track.')
    if (/^git\s+checkout\s+(?:\S+\s+)?--\s+\.(\s|$)/.test(part) || /^git\s+restore\s+(?:--\S+\s+)*\.(\s|$)/.test(part))
      soft.push('`git checkout -- .` / `git restore .` bỏ toàn bộ thay đổi chưa commit.')

    const push = /^git\s+push\b(.*)$/.exec(part)
    if (push) {
      const args = (push[1] ?? '').trim().split(/\s+/).filter(Boolean)
      if (args.some(a => /^(--force|--force-with-lease(=.*)?|-[a-zA-Z]*f[a-zA-Z]*)$/.test(a)))
        soft.push('Force push ghi đè lịch sử trên remote.')
      const positional = args.filter(a => !a.startsWith('-'))
      const refspecs = positional.slice(1)
      if (refspecs.some(r => PROTECTED_BRANCH.test(r)))
        soft.push('Không push thẳng `dev`/`main`: push nhánh feature/fix/chore rồi mở PR vào `dev`.')
      else if (refspecs.length === 0 || refspecs.every(r => r === 'HEAD')) needsBranchCheck = true
    }

    // B6: xoá đệ quy
    if (checkRm(part)) soft.push('`rm -r` ngoài thư mục build/tạm (dist, .next, coverage, tmp, scratchpad...).')

    // B7: phá DB / volume
    if (/\bprisma\s+migrate\s+reset\b|\bdb\s+push\b.*--force-reset\b/.test(part))
      soft.push('`prisma migrate reset` / `db push --force-reset` xoá sạch DB.')
    if (/^docker[\s-]+compose\b.*\bdown\b.*(\s-v\b|--volumes\b)/.test(part) || /^docker\s+volume\s+(rm|prune)\b/.test(part))
      soft.push('Xoá docker volume là mất dữ liệu Postgres/MinIO dev.')
  }

  // B7 trong chuỗi SQL (nằm trong dấu nháy nên kiểm trên lệnh gốc); chỉ khi lệnh chạm tới DB, để commit message không bị bắt nhầm
  if (
    /\b(psql|prisma|docker|pg_\w+)\b/.test(command) &&
    /\b(DROP\s+(DATABASE|SCHEMA|TABLE)|TRUNCATE(\s+TABLE)?\s+\w)/i.test(command)
  )
    soft.push('Lệnh SQL DROP / TRUNCATE xoá dữ liệu.')

  // B3: JSON tiếng Việt qua biến shell bị hỏng ký tự trong Git Bash (kiểm trên lệnh gốc vì nằm trong nháy)
  if (/\bcurl\b[\s\S]*?(?:\s-d|\s--data(?:-raw|-binary|-urlencode)?)(?:\s+|=)"\$/.test(command))
    hard.push(
      'Gửi JSON qua `curl -d "$BIEN"` làm hỏng tiếng Việt (thành ?/�) và có thể ghi đè dữ liệu thật. Ghi file UTF-8 bằng Write rồi `curl --data-binary @file.json`.',
    )

  return { reasons: approved ? hard : [...hard, ...soft], needsBranchCheck: needsBranchCheck && !approved }
}

/** Thông báo deny cho model. */
export function denyMessage(reasons: string[], approvable: boolean): string {
  const lines = ['bash-guard (CLAUDE.md): lệnh bị chặn.', ...reasons.map(r => `- ${r}`)]
  if (approvable)
    lines.push(
      `Nếu thật sự cần, HỎI user trước. Chỉ khi user đã đồng ý rõ ràng trong chat mới chạy lại với đuôi \`${APPROVAL_MARKER}\` ở cuối lệnh. Không tự thêm đuôi này.`,
    )
  return lines.join('\n')
}

/** Lý do nào trong `reasons` không vượt được bằng marker. */
export function hasHardReason(command: string): boolean {
  const withMarker = `${command.trimEnd()} ${APPROVAL_MARKER}`
  return checkBash(withMarker).reasons.length > 0
}
