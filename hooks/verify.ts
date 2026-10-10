// verify-status: package nào đã sửa mà chưa chạy lint / build / test. Hàm thuần để test trực tiếp.

import type { CldGuardPending } from '../types'
import { splitCommands, stripQuoted } from './bash-rules'

export type Pkg = 'api' | 'fe' | 'shared'
export type Check = 'lint' | 'build' | 'test'

const ORDER: Check[] = ['lint', 'build', 'test']
const PKG_ORDER: Pkg[] = ['shared', 'api', 'fe']

/** Những check cần chạy lại sau khi sửa file `rel` (đường dẫn tương đối tới gốc repo). */
export function checksForFile(rel: string): Partial<Record<Pkg, Check[]>> {
  if (/\.md$/i.test(rel) || /(^|\/)docs\//.test(rel)) return {}
  if (rel.startsWith('api/')) return { api: ['lint', 'build', 'test'] }
  if (rel.startsWith('fe/')) return { fe: ['lint', 'build'] }
  // Sửa shared thì api và fe build lại trên bản dist mới
  if (rel.startsWith('packages/shared/')) return { shared: ['build', 'test'], api: ['build'], fe: ['build'] }
  return {}
}

const FILTER_TO_PKG: Record<string, Pkg> = { api: 'api', mgo_remak: 'fe', '@remak/shared': 'shared' }
const DIR_TO_PKG: Record<string, Pkg> = { api: 'api', fe: 'fe', 'packages/shared': 'shared' }

function scriptToCheck(script: string): Check | undefined {
  if (script === 'lint' || script === 'build') return script
  if (script === 'test' || script.startsWith('test:')) return 'test'
  return undefined
}

/** Các check mà một lệnh Bash (đã chạy thành công) vừa hoàn thành. */
export function checksDoneBy(command: string): Partial<Record<Pkg, Check[]>> {
  const done: Partial<Record<Pkg, Check[]>> = {}
  const add = (pkg: Pkg | undefined, check: Check | undefined) => {
    if (!pkg || !check) return
    const list = (done[pkg] ??= [])
    if (!list.includes(check)) list.push(check)
  }
  let dirPkg: Pkg | undefined
  for (const part of splitCommands(stripQuoted(command))) {
    const cd = /^cd\s+(?:\/d\/webmgo\/|[A-Za-z]:[\\/]webmgo[\\/])?\.?\/?([\w/.-]+?)\/?$/i.exec(part)
    if (cd) {
      dirPkg = DIR_TO_PKG[(cd[1] ?? '').replace(/\\/g, '/')]
      continue
    }
    const filtered = /^pnpm\s+(?:--filter|-F)[\s=]+(\S+)\s+(?:run\s+)?([\w:-]+)/.exec(part)
    if (filtered) {
      add(FILTER_TO_PKG[(filtered[1] ?? '').replace(/^['"]|['"]$/g, '')], scriptToCheck(filtered[2] ?? ''))
      continue
    }
    // Script ở root: build:fe / build:api
    const rootBuild = /^pnpm\s+(?:run\s+)?build:(fe|api)\b/.exec(part)
    if (rootBuild) {
      add(rootBuild[1] === 'fe' ? 'fe' : 'api', 'build')
      continue
    }
    const plain = /^pnpm\s+(?:run\s+)?([\w:-]+)/.exec(part)
    if (plain && dirPkg) add(dirPkg, scriptToCheck(plain[1] ?? ''))
  }
  return done
}

export function addPending(pending: CldGuardPending, add: Partial<Record<Pkg, Check[]>>): CldGuardPending {
  const next: CldGuardPending = { ...pending }
  for (const pkg of PKG_ORDER) {
    const checks = add[pkg]
    if (!checks?.length) continue
    const merged = new Set([...(next[pkg] ?? []), ...checks])
    next[pkg] = ORDER.filter(c => merged.has(c))
  }
  return next
}

export function removePending(pending: CldGuardPending, done: Partial<Record<Pkg, Check[]>>): CldGuardPending {
  const next: CldGuardPending = {}
  const doneMap: Record<string, Check[] | undefined> = done
  for (const [pkg, checks] of Object.entries(pending)) {
    const doneHere: string[] = doneMap[pkg] ?? []
    const left = checks.filter(c => !doneHere.includes(c))
    if (left.length) next[pkg] = left
  }
  return next
}

/** Dòng status, `undefined` khi không còn gì phải kiểm. */
export function statusText(pending: CldGuardPending): string | undefined {
  const items = PKG_ORDER.filter(p => pending[p]?.length).map(p => `${p}(${(pending[p] ?? []).join(',')})`)
  return items.length ? `Chưa kiểm: ${items.join(' · ')}` : undefined
}
