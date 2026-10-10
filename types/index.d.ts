/** Việc kiểm chứng còn thiếu của từng package, vd `{ api: ['lint', 'test'] }`. */
export type CldGuardPending = Record<string, string[]>

declare module 'claude-code' {
  interface PluginState {
    'cld-guard': { pending: CldGuardPending }
  }
}
