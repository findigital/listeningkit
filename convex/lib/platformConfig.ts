/**
 * Platform configuration: which platforms are enabled for this deployment.
 * Set ENABLED_PLATFORMS=reddit (or facebook,x,reddit) to control what people can use.
 * Defaults to reddit only when unset (Reddit-only production mode for OffApps).
 */

export type Platform = 'facebook' | 'x' | 'reddit'

const DEFAULT_PLATFORMS: Platform[] = ['reddit']

function parseEnabledPlatforms(env: { ENABLED_PLATFORMS?: string } = process.env): Platform[] {
  const value = (env.ENABLED_PLATFORMS || '').trim()
  if (!value) return DEFAULT_PLATFORMS
  
  const parts = value.split(',').map(s => s.trim()).filter(Boolean)
  const valid: Platform[] = []
  for (const part of parts) {
    if (part === 'reddit' || part === 'x' || part === 'facebook') {
      if (!valid.includes(part)) valid.push(part)
    }
  }
  return valid.length > 0 ? valid : DEFAULT_PLATFORMS
}

/** The platforms this deployment allows. Defaults to reddit only. */
export function enabledPlatforms(env?: { ENABLED_PLATFORMS?: string }): Platform[] {
  return parseEnabledPlatforms(env)
}

/** Is this platform enabled? */
export function isPlatformEnabled(platform: Platform, env?: { ENABLED_PLATFORMS?: string }): boolean {
  return enabledPlatforms(env).includes(platform)
}

/** The plain-words refusal when a platform is disabled. */
export function platformDisabledMessage(platform: Platform): string {
  const names: Record<Platform, string> = { reddit: 'Reddit', x: 'X', facebook: 'Facebook' }
  return `${names[platform]} is not enabled on this deployment.`
}
