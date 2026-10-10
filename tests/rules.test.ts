import { describe, expect, test } from 'claude-code/testing'
import { checkBash, hasHardReason } from '../hooks/bash-rules'
import { checkCode, findSingleArgRevalidateTag, isMigrationFile } from '../hooks/code-rules'
import { relToRepo } from '../hooks/repo'
import { addPending, checksDoneBy, checksForFile, removePending, statusText } from '../hooks/verify'

describe('code-guard', () => {
  test('api: import tương đối thiếu .js bị chặn, có .js thì qua', () => {
    expect(checkCode('api/src/a.service.ts', "import { B } from './b.service'", '')).toHaveLength(1)
    expect(checkCode('api/src/a.service.ts', "import { B } from './b.service.js'", '')).toHaveLength(0)
    expect(checkCode('api/src/generated/prisma/x.ts', "import { B } from './b'", '')).toHaveLength(0)
  })

  test('chỉ bắt vi phạm MỚI, giữ nguyên dòng cũ thì không chặn', () => {
    const old = "import { B } from './b'\nconst x = 1"
    expect(checkCode('api/src/a.ts', "import { B } from './b'\nconst x = 2", old)).toHaveLength(0)
  })

  test('api: @prisma/client bị chặn', () => {
    expect(checkCode('api/src/x.ts', "import { PrismaClient } from '@prisma/client'", '')).toHaveLength(1)
  })

  test('fe: không dùng Prisma / pg / Redis', () => {
    expect(checkCode('fe/src/app/page.tsx', "import Redis from 'ioredis'", '')).toHaveLength(1)
    expect(checkCode('fe/src/lib/db.ts', "import { Pool } from 'pg'", '')).toHaveLength(1)
    expect(checkCode('fe/src/lib/x.ts', "import { pgFormat } from 'pg-format'", '')).toHaveLength(0)
  })

  test('revalidateTag một tham số', () => {
    expect(findSingleArgRevalidateTag("revalidateTag('home')")).toHaveLength(1)
    expect(findSingleArgRevalidateTag("revalidateTag(tagFor(a, b))")).toHaveLength(1)
    expect(findSingleArgRevalidateTag("revalidateTag(tag, { expire: 0 })")).toHaveLength(0)
    expect(findSingleArgRevalidateTag("revalidateTag('a,b', { expire: 0 })")).toHaveLength(0)
  })

  test('web khách hàng: next/link và <a href="/..."> bị chặn, admin thì không', () => {
    expect(checkCode('fe/src/components/Foo.tsx', "import Link from 'next/link'", '')).toHaveLength(1)
    expect(checkCode('fe/src/components/Foo.tsx', '<a href="/san-pham">x</a>', '')).toHaveLength(1)
    expect(checkCode('fe/src/components/Foo.tsx', '<a href="https://x.vn">x</a>', '')).toHaveLength(0)
    expect(checkCode('fe/src/app/admin/page.tsx', "import Link from 'next/link'", '')).toHaveLength(0)
    expect(checkCode('fe/src/components/ui/LocaleLink.tsx', "import Link from 'next/link'", '')).toHaveLength(0)
  })

  test('token trong localStorage', () => {
    expect(checkCode('fe/src/cms/x.ts', "localStorage.setItem('accessToken', t)", '')).toHaveLength(1)
    expect(checkCode('fe/src/cms/x.ts', "localStorage.setItem('sidebarOpen', '1')", '')).toHaveLength(0)
  })

  test('proxy.ts: \\. một gạch', () => {
    expect(checkCode('fe/src/proxy.ts', "matcher: ['/((?!api|.*\\.).*)']", '')).toHaveLength(1)
    expect(checkCode('fe/src/proxy.ts', "matcher: ['/((?!api|.*\\\\.).*)']", '')).toHaveLength(0)
  })

  test('nhận diện migration', () => {
    expect(isMigrationFile('api/prisma/migrations/20260101_x/migration.sql')).toBe(true)
    expect(isMigrationFile('api/prisma/schema.prisma')).toBe(false)
  })
})

describe('bash-guard', () => {
  const blocked = (cmd: string) => checkBash(cmd).reasons.length > 0

  test('seed toàn bộ bị chặn, seed tin tức thì qua', () => {
    expect(blocked('pnpm --filter api db:seed')).toBe(true)
    expect(blocked('pnpm --filter api db:seed:news')).toBe(false)
  })

  test('npm / yarn bị chặn, không vượt được bằng marker', () => {
    expect(blocked('npm install lodash')).toBe(true)
    expect(blocked('cd fe && yarn')).toBe(true)
    expect(blocked('npm install lodash # user-approved')).toBe(true)
    expect(blocked('pnpm install')).toBe(false)
  })

  test('curl -d "$BIEN" bị chặn', () => {
    expect(blocked('curl -X PUT -d "$BODY" http://localhost:4000/x')).toBe(true)
    expect(blocked('curl -X PUT --data-binary @body.json http://localhost:4000/x')).toBe(false)
  })

  test('git phá dữ liệu bị chặn, marker thì cho qua', () => {
    expect(blocked('git reset --hard HEAD~1')).toBe(true)
    expect(blocked('git push --force origin feature/x')).toBe(true)
    expect(blocked('git clean -fd')).toBe(true)
    expect(blocked('git reset --hard HEAD~1 # user-approved')).toBe(false)
    expect(hasHardReason('git reset --hard')).toBe(false)
  })

  test('push thẳng dev/main bị chặn; push không refspec thì phải hỏi nhánh', () => {
    expect(blocked('git push origin dev')).toBe(true)
    expect(blocked('git push -u origin HEAD:main')).toBe(true)
    expect(blocked('git push -u origin feature/x')).toBe(false)
    expect(checkBash('git push').needsBranchCheck).toBe(true)
  })

  test('chữ trong commit message không bị bắt nhầm', () => {
    expect(blocked('git commit -m "docs: cấm git reset --hard và npm install"')).toBe(false)
  })

  test('rm -rf chỉ cho thư mục build/tạm', () => {
    expect(blocked('rm -rf fe/.next')).toBe(false)
    expect(blocked('rm -rf packages/shared/dist')).toBe(false)
    expect(blocked('rm -rf api/src')).toBe(true)
    expect(blocked('rm file.txt')).toBe(false)
  })

  test('phá DB / volume bị chặn', () => {
    expect(blocked('pnpm --filter api exec prisma migrate reset')).toBe(true)
    expect(blocked('docker compose down -v')).toBe(true)
    expect(blocked('docker compose down')).toBe(false)
    expect(blocked('docker compose exec postgres psql -c "DROP TABLE posts"')).toBe(true)
  })
})

describe('verify-status', () => {
  test('sửa file → check cần chạy', () => {
    expect(checksForFile('api/src/x.ts')).toEqual({ api: ['lint', 'build', 'test'] })
    expect(checksForFile('fe/docs/A.md')).toEqual({})
    expect(checksForFile('packages/shared/src/slug.ts')).toEqual({
      shared: ['build', 'test'],
      api: ['build'],
      fe: ['build'],
    })
  })

  test('lệnh pnpm → check đã chạy', () => {
    expect(checksDoneBy('pnpm --filter api lint && pnpm --filter api test:e2e')).toEqual({ api: ['lint', 'test'] })
    expect(checksDoneBy('pnpm --filter mgo_remak build')).toEqual({ fe: ['build'] })
    expect(checksDoneBy('cd fe && pnpm lint')).toEqual({ fe: ['lint'] })
    expect(checksDoneBy('pnpm -F @remak/shared test')).toEqual({ shared: ['test'] })
    expect(checksDoneBy('git status')).toEqual({})
  })

  test('cộng / trừ và dòng status', () => {
    let p = addPending({}, { api: ['test', 'lint'] })
    p = addPending(p, { fe: ['build'] })
    expect(statusText(p)).toBe('Chưa kiểm: api(lint,test) · fe(build)')
    p = removePending(p, { api: ['lint', 'test'], fe: ['build'] })
    expect(statusText(p)).toBeUndefined()
  })

  test('đường dẫn tương đối tới repo, không phân biệt hoa thường', () => {
    expect(relToRepo('d:\\webmgo\\api\\src\\x.ts', 'D:/webmgo')).toBe('api/src/x.ts')
    expect(relToRepo('C:/other/x.ts', 'D:/webmgo')).toBeUndefined()
  })
})
