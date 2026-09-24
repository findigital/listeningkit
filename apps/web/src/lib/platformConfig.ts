/**
 * Client-side platform configuration: which platforms are available in this deployment.
 * Reads from a Convex-side query or falls back to environment variable checking.
 */

export type Platform = 'facebook' | 'x' | 'reddit'

const DEFAULT_PLATFORMS: Platform[] = ['reddit']

/**
 * Get enabled platforms from environment. Defaults to reddit only.
 * This matches the server-side logic in convex/lib/platformConfig.ts
 */
export function getEnabledPlatforms(): Platform[] {
  const value = import.meta.env.VITE_ENABLED_PLATFORMS
  if (!value || typeof value !== 'string') return DEFAULT_PLATFORMS
  
  const parts = value.split(',').map(s => s.trim()).filter(Boolean)
  const valid: Platform[] = []
  for (const part of parts) {
    if (part === 'reddit' || part === 'x' || part === 'facebook') {
      if (!valid.includes(part)) valid.push(part)
    }
  }
  return valid.length > 0 ? valid : DEFAULT_PLATFORMS
}

/** Is this platform enabled? */
export function isPlatformEnabled(platform: Platform): boolean {
  return getEnabledPlatforms().includes(platform)
}

/** Should the extension step be shown? Reddit-only deployments don't need it. */
export function needsExtensionStep(): boolean {
  const platforms = getEnabledPlatforms()
  return platforms.includes('x') || platforms.includes('facebook')
}
