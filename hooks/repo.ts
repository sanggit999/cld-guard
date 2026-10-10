// Đường dẫn trong repo webmgo. Hàm thuần; phần gọi `$` (tìm gốc repo) nằm ở register.ts.

export const toSlash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** Thư mục cha, `undefined` khi đã tới gốc ổ đĩa. */
export function parentOf(dir: string): string | undefined {
  const i = dir.lastIndexOf('/')
  if (i <= 0) return undefined
  const parent = dir.slice(0, i)
  // `D:` không phải thư mục, dừng ở đó
  return /^[A-Za-z]:$/.test(parent) ? undefined : parent
}

/** Đường dẫn của `file` tính từ `root` (dấu `/`), `undefined` khi file nằm ngoài repo. */
export function relToRepo(file: string, root: string): string | undefined {
  const f = toSlash(file)
  const r = toSlash(root)
  // Windows không phân biệt hoa thường (d:\webmgo và D:/webmgo là một)
  if (f.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return f.slice(r.length + 1)
  // Đường dẫn tương đối: coi như tính từ gốc repo
  if (!/^([A-Za-z]:)?\//.test(f)) return f.replace(/^\.\//, '')
  return undefined
}
