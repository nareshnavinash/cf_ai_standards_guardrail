/** Run `fn` up to `attempts` times, waiting `delayMs` between tries. */
export async function retry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 200): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {}
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs))
  }
  throw new Error(`gave up after ${attempts} attempts`)
}
