// code-guard: các luật trong "sổ đen" của CLAUDE.md repo webmgo, kiểm trên phần code MỚI THÊM.
// Hàm thuần — không gọi `$` — để test trực tiếp.

type Rule = {
  /** Áp cho file nào (đường dẫn tương đối tới gốc repo, dấu `/`). */
  applies: (rel: string) => boolean
  /** Các đoạn vi phạm tìm thấy trong một đoạn text. */
  find: (text: string) => string[]
  message: (hit: string) => string
}

const isApiTs = (rel: string) =>
  /^api\/(src|test|prisma)\/.*\.m?ts$/.test(rel) && !rel.startsWith('api/src/generated/')
const isFeCode = (rel: string) => /^fe\/.*\.(ts|tsx|js|jsx|mjs)$/.test(rel)
const isPublicWeb = (rel: string) =>
  /^fe\/src\/.*\.(tsx|jsx)$/.test(rel) &&
  !/^fe\/src\/(app\/admin|cms)\//.test(rel) &&
  // Hai file này chính là nơi bọc next/link cho đa ngôn ngữ
  !/^fe\/src\/components\/(ui\/LocaleLink|layout\/LanguageSwitcher)\.tsx$/.test(rel)

const allMatches = (re: RegExp, text: string, group = 0) =>
  [...text.matchAll(re)].map(m => m[group] ?? m[0])

/** Các lời gọi `revalidateTag(...)` chỉ có một tham số (đếm dấu phẩy ở cấp ngoài cùng). */
export function findSingleArgRevalidateTag(text: string): string[] {
  const hits: string[] = []
  const re = /\brevalidateTag\s*\(/g
  for (const m of text.matchAll(re)) {
    const start = m.index + m[0].length
    let depth = 1
    let quote: string | undefined
    let hasTopComma = false
    let end = -1
    for (let i = start; i < text.length; i++) {
      const c = text[i]
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = undefined
        continue
      }
      if (c === '"' || c === "'" || c === '`') quote = c
      else if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      } else if (c === ',' && depth === 1) hasTopComma = true
    }
    // Lời gọi chưa đóng (đoạn edit bị cắt giữa chừng) thì bỏ qua, không đoán
    if (end === -1) continue
    const args = text.slice(start, end).trim()
    if (args !== '' && !hasTopComma) hits.push(text.slice(m.index, end + 1))
  }
  return hits
}

const RULES: Rule[] = [
  {
    applies: isApiTs,
    find: text =>
      allMatches(/\b(?:from|import)\s*\(?\s*(['"])(\.{1,2}\/[^'"]*)\1/g, text, 2).filter(
        spec => !/\.(js|mjs|cjs|json)$/.test(spec),
      ),
    message: spec =>
      `Import tương đối '${spec}' thiếu đuôi .js. api là ESM nodenext: build vẫn qua nhưng runtime crash. Viết '${spec}.js' (thư mục thì '${spec}/index.js').`,
  },
  {
    applies: isApiTs,
    find: text => allMatches(/(['"])@prisma\/client\1/g, text),
    message: () =>
      `Không import từ '@prisma/client' (Prisma 7, output tuỳ chỉnh). Import từ 'src/generated/prisma/client.js' (đường dẫn tương đối, có đuôi .js).`,
  },
  {
    applies: isFeCode,
    find: text =>
      allMatches(
        /\b(?:from|import|require)\s*\(?\s*(['"])(@prisma\/[^'"]+|prisma|pg|ioredis|redis|@redis\/[^'"]+)\1/g,
        text,
        2,
      ),
    message: mod =>
      `fe không được dùng '${mod}' (kể cả Server Component / Route Handler). Frontend chỉ gọi API.`,
  },
  {
    applies: isFeCode,
    find: findSingleArgRevalidateTag,
    message: call =>
      `${call} chỉ có một tham số: đã deprecated ở Next 16. Dùng revalidateTag(tag, { expire: 0 }).`,
  },
  {
    applies: isPublicWeb,
    find: text => allMatches(/(['"])next\/link\1/g, text),
    message: () =>
      `Web khách hàng không dùng 'next/link'. Dùng Link từ '@/components/ui/LocaleLink' (href viết URL tiếng Việt), nếu không trang /en sẽ dẫn về bản tiếng Việt.`,
  },
  {
    applies: isPublicWeb,
    find: text => allMatches(/<a\s[^>]*\bhref=\{?\s*(['"`])\/(?!\/)[^'"`]*\1/g, text),
    message: tag =>
      `Link nội bộ bằng thẻ <a> (${tag}…). Dùng Link từ '@/components/ui/LocaleLink' để giữ locale.`,
  },
  {
    applies: isFeCode,
    find: text =>
      allMatches(
        /\b(?:localStorage|sessionStorage)\.setItem\(\s*(['"`])[^'"`]*(?:token|session|jwt|auth|refresh)[^'"`]*\1/gi,
        text,
      ),
    message: call =>
      `${call}…: không lưu token/session vào Web Storage. Auth dùng httpOnly cookie, client chỉ fetch với credentials: 'include'.`,
  },
  {
    applies: rel => rel === 'fe/src/proxy.ts',
    // `\.` có một dấu gạch: chuỗi JS thành `.`, matcher khớp mọi URL
    find: text => allMatches(/(?<!\\)\\\.(?!\\)/g, text).length > 0 ? ['\\.'] : [],
    message: () =>
      `Trong src/proxy.ts phải viết '\\\\.' (hai gạch) thay vì '\\.' — chuỗi '\\.' thành '.', matcher khớp mọi URL và proxy bỏ qua toàn bộ route tiếng Việt.`,
  },
]

/** Trừ đa tập: phần tử của `added` không có tương ứng trong `removed`. */
function subtract(added: string[], removed: string[]): string[] {
  const left = [...removed]
  return added.filter(hit => {
    const i = left.indexOf(hit)
    if (i === -1) return true
    left.splice(i, 1)
    return false
  })
}

/**
 * Lỗi sổ đen mà lần sửa này THÊM VÀO file `rel`.
 * Chỉ tính vi phạm có trong `added` mà chưa có trong `removed`, để sửa gần code cũ không bị chặn oan.
 */
export function checkCode(rel: string, added: string, removed: string): string[] {
  const out: string[] = []
  for (const rule of RULES) {
    if (!rule.applies(rel)) continue
    for (const hit of subtract(rule.find(added), rule.find(removed))) {
      const msg = rule.message(hit)
      if (!out.includes(msg)) out.push(msg)
    }
  }
  return out
}

/** Migration Prisma (file migration.sql trong một thư mục migration). */
export const isMigrationFile = (rel: string) =>
  /^api\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(rel)
