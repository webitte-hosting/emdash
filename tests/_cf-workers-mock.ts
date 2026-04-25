// Vitest substitute for `cloudflare:workers`. The real module exposes
// the Worker runtime's `env` global; in tests we let suites mutate
// this object to simulate whatever bindings each scenario expects.
//
// Tests should call `setEnv({...})` in beforeEach to install fresh
// fixtures, then read via the same `env` import the runtime uses.

interface MutableEnv extends Record<string, unknown> {}

let current: MutableEnv = {}

export const env = new Proxy(current, {
  get(_, prop: string) {
    return current[prop]
  },
  has(_, prop: string) {
    return prop in current
  },
  ownKeys() {
    return Reflect.ownKeys(current)
  },
  getOwnPropertyDescriptor(_, prop) {
    return Reflect.getOwnPropertyDescriptor(current, prop)
  },
})

export function setEnv(next: MutableEnv): void {
  current = next
}
