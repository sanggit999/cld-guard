// prompt-context: khối ngữ cảnh gắn sau mỗi prompt của user (git, việc chưa kiểm, sổ đen theo khu vực, từ khoá fix:/review:).
// Hàm thuần để test trực tiếp; phần gọi `$` nằm ở register.ts.

export const AREAS = ['fe', 'cms', 'api', 'db', 'infra', 'git'] as const
export type Area = (typeof AREAS)[number]

export type BlacklistEntry = { area: Area; text: string }

const isArea = (s: string): s is Area => (AREAS as readonly string[]).includes(s)

/** Các dòng `- [khu vực] ...` trong mục "Sổ đen" của CLAUDE.md gốc repo. */
export function parseBlacklist(md: string): BlacklistEntry[] {
  const lines = md.split(/\r?\n/)
  const start = lines.findIndex(l => /^#+\s.*sổ đen/i.test(l))
  if (start < 0) return []
  const entries: BlacklistEntry[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^#+\s/.test(line)) break
    const m = /^-\s+\[(\w+)\]\s+(.+)$/.exec(line.trim())
    const area = m?.[1] ?? ''
    if (m && isArea(area)) entries.push({ area, text: (m[2] ?? '').trim() })
  }
  return entries
}

const TEXT_AREAS: [Area, RegExp][] = [
  ['api', /\bapi\b|nestjs|prisma|redis|swagger|\bjob\b|cron/],
  ['fe', /\bfe\b|next(\.js)?\b|frontend|trang public|\bisr\b|revalidate|proxy\.ts|\blink\b|giao diện|\bui\b/],
  ['cms', /\bcms\b|\badmin\b/],
  ['db', /\bdb\b|prisma|migration|migrate|\bseed\b|order\s?by|postgres|phân trang|\bsql\b/],
  ['infra', /docker|\bcurl\b|minio|\.env\b|\binfra\b|deploy/],
  ['git', /\bgit\b|commit|\bpush\b|\bpr\b|pull request|merge|nhánh|branch/],
]

/** Khu vực sổ đen liên quan, đoán từ chữ trong prompt và các file đang sửa. */
export function detectAreas(text: string, files: readonly string[]): Area[] {
  const found = new Set<Area>()
  const t = text.toLowerCase()
  for (const [area, re] of TEXT_AREAS) if (re.test(t)) found.add(area)
  for (const f of files) {
    if (f.startsWith('api/prisma/')) found.add('db')
    if (f.startsWith('api/')) found.add('api')
    if (f.startsWith('fe/src/app/admin/') || f.startsWith('fe/src/cms/')) found.add('cms')
    if (f.startsWith('fe/')) found.add('fe')
    if (f.startsWith('packages/shared/')) found.add('api').add('fe')
    if (/(^|\/)(docker-compose[^/]*\.ya?ml|\.env\.example)$/.test(f)) found.add('infra')
  }
  return AREAS.filter(a => found.has(a))
}

export type GitInfo = { branch: string; files: string[]; lines: string[] }

/** Đọc kết quả `git status --porcelain=v1 --branch`. */
export function parseGitStatus(stdout: string): GitInfo {
  const rows = stdout.split(/\r?\n/).filter(Boolean)
  const head = rows[0]?.startsWith('## ') ? rows.shift() ?? '' : ''
  const branch = head
    .slice(3)
    .replace(/^No commits yet on /, '')
    .replace(/\.\.\..*$/, '')
    .replace(/\s+\[.*\]$/, '')
    .trim()
  const lines = rows.map(r => r.trimEnd())
  // `XY path` hoặc `XY old -> new`; bỏ nháy của path có ký tự đặc biệt
  const files = lines.map(r => (r.slice(3).split(' -> ').pop() ?? '').replace(/^"|"$/g, ''))
  return { branch, files, lines }
}

export type Keyword = 'fix' | 'review'

/** Tiền tố `fix:` / `review:` ở đầu prompt. */
export function detectKeyword(text: string): Keyword | undefined {
  const m = /^\s*(fix|review)\s*:/i.exec(text)
  const k = m?.[1]?.toLowerCase()
  return k === 'fix' || k === 'review' ? k : undefined
}

const FIX_STEPS = [
  'Từ khoá `fix:`: làm đúng quy trình sửa bug, không vá triệu chứng.',
  '1. Tái hiện: đọc code liên quan, xác định input/trạng thái gây lỗi; tái hiện bằng test hoặc lệnh cụ thể. Chưa tái hiện được thì nói rõ và hỏi thêm thông tin, đừng đoán sửa.',
  '2. Nguyên nhân gốc: chỉ ra dòng/điều kiện sai và vì sao. Kiểm tra cùng lỗi có lặp ở chỗ khác không.',
  '3. Sửa đúng gốc, trong phạm vi tối thiểu; thêm/cập nhật test tái hiện bug (api: vitest `*.spec.ts`, shared: vitest).',
  '4. Kiểm chứng: chạy lại bước tái hiện + lint/build/test của package bị ảnh hưởng, đọc kết quả.',
  'Báo lại: nguyên nhân gốc, đã sửa gì, kiểm chứng bằng gì, còn rủi ro gì. Lỗi mà đọc code chưa chắc thấy → đề xuất một dòng sổ đen.',
]

const REVIEW_STEPS = [
  'Từ khoá `review:`: review code, KHÔNG sửa file trừ khi user yêu cầu.',
  'Phạm vi: theo mô tả sau `review:`; không nêu thì là thay đổi của nhánh so với `dev` (`git diff dev...HEAD`) cộng phần chưa commit.',
  'Checklist:',
  '- Kiến trúc: fe chỉ gọi API (không Prisma/pg/Redis); không hardcode nội dung; trang public SSG/ISR revalidate ≤ 60s; một nguồn sự thật cho thông số MGO; Redis lỗi phải fallback DB; logic dùng chung nằm ở `@remak/shared`.',
  '- Đúng & ổn định: case lỗi, dữ liệu rỗng, chạy đồng thời; `orderBy` kết thúc bằng cột unique; không `catch {}` rỗng.',
  '- Bảo mật: validate input ở biên, kiểm tra quyền, không lộ chi tiết nội bộ; không secret trong code/log.',
  '- Hiệu năng: N+1 query, index, phân trang.',
  '- Quy ước: TS strict, không `any`, không `as` bịt lỗi; comment và text hiển thị tiếng Việt; migration đã commit không bị sửa; `.env.example` cập nhật khi thêm biến.',
  '- Test: logic mới / bug fix có test.',
  '- Mọi dòng sổ đen bên dưới.',
  'Báo cáo: mỗi phát hiện kèm `file:dòng`, mức độ (nghiêm trọng / nên sửa / gợi ý), kịch bản lỗi cụ thể; xếp nặng nhất trước. Không có gì thì nói thẳng.',
]

export type ContextInput = {
  git: GitInfo | undefined
  pendingText: string | undefined
  blacklist: readonly BlacklistEntry[]
  areas: readonly Area[]
  keyword: Keyword | undefined
}

const MAX_FILES = 15

/** Khối ngữ cảnh gắn sau prompt; `undefined` khi không có gì để nói. */
export function buildContext({ git, pendingText, blacklist, areas, keyword }: ContextInput): string | undefined {
  const out: string[] = []

  if (keyword === 'fix') out.push(...FIX_STEPS, '')
  if (keyword === 'review') out.push(...REVIEW_STEPS, '')

  if (git?.branch) {
    const protectedBranch = git.branch === 'dev' || git.branch === 'main'
    out.push(
      `Nhánh: \`${git.branch}\` (base PR: \`dev\`).` +
        (protectedBranch ? ' Đang ở nhánh tích hợp: trước khi commit phải tạo nhánh feature/fix/chore.' : ''),
    )
    if (git.lines.length) {
      const shown = git.lines.slice(0, MAX_FILES)
      const more = git.lines.length - shown.length
      out.push(`Đang thay đổi (git status): ${shown.join(', ')}${more > 0 ? ` (+${more} file)` : ''}`)
    }
  }

  if (pendingText) out.push(`${pendingText} → chạy trước khi báo "xong".`)

  // review: cần cả sổ đen; còn lại chỉ khu vực liên quan
  const wanted = keyword === 'review' ? blacklist : blacklist.filter(b => areas.includes(b.area))
  if (wanted.length) {
    const label = keyword === 'review' ? 'toàn bộ' : [...new Set(wanted.map(b => b.area))].join(', ')
    out.push(`Sổ đen liên quan (${label}):`, ...wanted.map(b => `- [${b.area}] ${b.text}`))
  }

  if (!out.length) return undefined
  return ['<webmgo-context> (plugin cld-guard tự gắn, user không thấy khối này)', ...out, '</webmgo-context>'].join('\n')
}
