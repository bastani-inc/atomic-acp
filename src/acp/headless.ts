/** ATOMIC_ACP_HEADLESS=1 (or true) says no person is available to answer questions. */
export function isHeadlessFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true)$/i.test(env.ATOMIC_ACP_HEADLESS?.trim() ?? '')
}
