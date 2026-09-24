import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { siGithub, siGooglechrome } from 'simple-icons'
import { Button, useToast } from '@listeningkit/ui'
import { describeExpiry, saveSession, sessionsOnConvex, tokenPlatform } from '@/lib/live-sessions'
import { SOCIAL_ICONS, SocialGlyph } from '@/lib/social-icons'
import { extractBrandFromUrl, getBrand, saveBrand, skippedBrand, type BrandEntity } from '@/lib/brand'
import { applyWebsiteFacts, brandOnConvex, notSignedInYet, readingIsOff, readWebsite } from '@/lib/live-brand'
import { getEnabledPlatforms, needsExtensionStep } from '@/lib/platformConfig'
import { BrandRevealStep } from '@/components/onboarding/BrandRevealStep'
import { FunnelVideo } from '@/components/FunnelVideo'
import { ReadyFill } from '@/components/ReadyFill'
import { OnboardingLoading } from './OnboardingLoading'
import { readAuthSource, saveAuthSource, clearAuthSource, clearLandingWebsite, readLandingWebsite, saveOnboardingProgress, readOnboardingProgress } from './auth-handoff'
import { websiteError } from '@/lib/website'

/**
 * Step order: 0 website → 1 brand reveal → 2 extension install (optional, hidden for Reddit-only)
 * → 3 platforms → 4 connect tokens (optional, skipped when no platforms need tokens) → 5 ready.
 * Sign-in/sign-up is a route redirect between the extension and platform steps, never a step itself.
 */
type Step = 0 | 1 | 2 | 3 | 4 | 5

// Swap in your own footage via VITE_ONBOARDING_VIDEO_URL (e.g. an R2 public URL).
const VIDEO_URL =
  import.meta.env.VITE_ONBOARDING_VIDEO_URL || 'https://files.vidstack.io/sprite-fight/720p.mp4'

// Where to send the user to grab cookies, per platform.
const PLATFORM_SITES: Record<string, { label: string; url: string }> = {
  facebook: { label: 'facebook.com', url: 'https://facebook.com' },
  x: { label: 'x.com', url: 'https://x.com' },
  reddit: { label: 'reddit.com', url: 'https://reddit.com' }
}

const EXTENSION_ZIP = '/listeningkit-extension.zip'
const EXTENSION_SOURCE = 'https://github.com/matthewdonsemail-lab/log/tree/main/apps/extension'

export function OnboardingSteps({ requireSignIn = false }: { requireSignIn?: boolean }) {
  const navigate = useNavigate()
  const [authSource] = useState(readAuthSource)
  const enabledPlatforms = getEnabledPlatforms()
  const showExtensionStep = needsExtensionStep()
  // Landing arrivals carry a saved website and skip straight to the reveal
  // (the lookup runs on mount). Returning visitors with a saved brand resume
  // at the extension step (or platforms if extension is skipped); sign-in returns land on platform selection.
  const [step, setStep] = useState<Step>(() => {
    if (!requireSignIn && authSource) return 3
    if (readLandingWebsite().trim()) return 1
    if (getBrand()) {
      const progress = readOnboardingProgress()
      if (progress === 'platforms') return 3
      if (progress === 'tokens') return 4
      if (progress === 'done') return 5
      // Skip extension step if it's not needed
      return showExtensionStep ? 2 : 3
    }
    return 0
  })
  const [sources, setSources] = useState<string[]>(authSource ? [authSource] : [])
  useEffect(() => {
    if (!requireSignIn) clearAuthSource()
  }, [requireSignIn])
  const [tokens, setTokens] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showInstall, setShowInstall] = useState(false)
  // Platforms whose token the server has accepted, with a plain-words expiry.
  const [connected, setConnected] = useState<Record<string, string>>({})
  const { error: notifyError, success: notifySuccess } = useToast()
  // Restore the brand only inside the authenticated flow. Typing never
  // advances the step — only the Continue / Skip buttons move forward.
  const [profile, setProfile] = useState<BrandEntity | null>(null)
  // The website step only shows for direct arrivals; landing arrivals skip
  // it and go straight to the reveal (see the mount effect below).
  const [brandUrl, setBrandUrl] = useState('')
  const [looking, setLooking] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const revealScrollRef = useRef<HTMLDivElement>(null)
  // Exit transition 1 -> 2: Continue scrolls the reveal back up and slides it
  // out; only then does the extension step mount (no hard cut). Reduced
  // motion skips the beat and swaps immediately.
  const [revealLeaving, setRevealLeaving] = useState(false)
  const leaveTimer = useRef(0)

  useEffect(() => () => window.clearTimeout(leaveTimer.current), [])

  function handleRevealContinue() {
    if (revealLeaving) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    setRevealLeaving(true)
    // Skip extension step if it's not needed (Reddit-only deployments)
    const nextStep = showExtensionStep ? 2 : 3
    const nextProgress = showExtensionStep ? 'extension' : 'platforms'
    saveOnboardingProgress(nextProgress)
    revealScrollRef.current?.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
    leaveTimer.current = window.setTimeout(() => setStep(nextStep), reduce ? 0 : 750)
  }

  // Local-only debug skip: jump to any onboarding step. Stripped from
  // production builds (import.meta.env.DEV is false there).
  function debugGoTo(next: Step) {
    window.clearTimeout(leaveTimer.current)
    setRevealLeaving(false)
    if (next === 1 && !profile) {
      try {
        setProfile(saveBrand(extractBrandFromUrl('acmeplumbing.com')))
      } catch {
        // leave profile null; step 1 simply renders nothing without one
      }
    }
    setStep(next)
  }

  // Visiting onboarding never wipes the saved brand — a reset happens only
  // through an explicit start-over action, so data actually survives.
  useEffect(() => {
    if (requireSignIn || profile) return
    setProfile(getBrand())
  }, [requireSignIn])

  // Keep the reveal scrolled to the incoming stream: stickiness is tracked
  // from scroll position (pre-mutation), so big blocks landing at once —
  // like the whole sub-chain appearing — can't break the follow. If the
  // reader scrolls up, following pauses until they're back near the bottom.
  useEffect(() => {
    if (step !== 1) return
    const el = revealScrollRef.current
    if (!el) return
    let stick = true
    el.scrollTop = el.scrollHeight
    const onScroll = () => {
      stick = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    const observer = new MutationObserver(() => {
      if (stick) el.scrollTop = el.scrollHeight
    })
    observer.observe(el, { childList: true, subtree: true, characterData: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [step])

  function toggleSource(id: string) {
    setSources((prev) => (prev.includes(id) ? [] : [id]))
  }

  function continueFromSources() {
    if (sources.length === 0) return
    // If no platforms need tokens (Reddit-only), skip to ready
    const needsTokens = sources.some(id => id === 'x' || id === 'facebook')
    if (!needsTokens) {
      saveOnboardingProgress('done')
      setStep(5)
      return
    }
    if (requireSignIn) {
      saveAuthSource(sources[0])
      navigate('/sign-in')
      return
    }
    saveOnboardingProgress('tokens')
    setStep(4)
  }

  // Leaving the extension step always records platform selection as next:
  // signed-out visitors go through sign-in first and resume there.
  function finishExtension() {
    saveOnboardingProgress('platforms')
    if (requireSignIn) {
      navigate('/sign-in')
      return
    }
    setStep(3)
  }

  async function saveTokens() {
    if (saving) return
    if (!sessionsOnConvex()) {
      setSaving(true)
      setSaved(false)
      window.setTimeout(() => {
        setSaving(false)
        setSaved(true)
        window.setTimeout(() => {
          saveOnboardingProgress('done')
          setStep(5)
          setSaved(false)
        }, 900)
      }, 1500)
      return
    }
    const waiting = sources.filter((id) => connected[id] === undefined)
    const filled = waiting.filter((id) => (tokens[id] ?? '').trim())
    if (filled.length === 0) {
      notifyError('Paste a token first', 'Copy it with the ListeningKit extension, then paste it here.')
      return
    }
    setSaving(true)
    setSaved(false)
    const done = new Set(sources.filter((id) => connected[id] !== undefined))
    for (const id of filled) {
      const label = SOCIAL_ICONS.find((icon) => icon.id === id)?.label ?? id
      const meant = tokenPlatform(tokens[id])
      if (meant && meant !== id) {
        const other = SOCIAL_ICONS.find((icon) => icon.id === meant)?.label ?? meant
        notifyError(`That is a ${other} token`, `This box is for ${label}. Copy the token while you are on ${PLATFORM_SITES[id]?.label ?? label}.`)
        continue
      }
      try {
        const result = await saveSession(tokens[id])
        setConnected((prev) => ({ ...prev, [id]: describeExpiry(result.expiresAt) }))
        setTokens((prev) => ({ ...prev, [id]: '' }))
        done.add(id)
        notifySuccess(`${label} connected`, 'Your login is saved and encrypted.')
      } catch (err) {
        notifyError(`${label} was not connected`, err instanceof Error ? err.message : 'Try copying the token again.')
      }
    }
    setSaving(false)
    if (sources.every((id) => done.has(id))) {
      setSaved(true)
      window.setTimeout(() => {
        saveOnboardingProgress('done')
        setStep(5)
        setSaved(false)
      }, 900)
    }
  }

  // Runs the brand lookup for an explicit site (landing arrivals skip the
  // website step, so the site comes from the handoff, not the input).
  async function lookupBrand(site?: string) {
    const raw = (site ?? brandUrl).trim()
    if (looking) return
    const problem = websiteError(raw)
    if (problem) {
      setLookupError(problem)
      return
    }
    setLooking(true)
    setLookupError(null)
    try {
      // Validates the address and seeds the defaults; on the live backend Firecrawl then reads the real site over them.
      const base = extractBrandFromUrl(raw)
      let entity = base
      if (brandOnConvex()) {
        try {
          entity = applyWebsiteFacts(base, await readWebsite(raw))
        } catch (err) {
          // Reading is not switched on, or nobody has signed in yet (the normal case for a landing arrival,
          // which runs this lookup before sign-in): keep the name guessed from the domain rather than blocking sign-up.
          if (!readingIsOff(err) && !notSignedInYet(err)) throw err
        }
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, 700)) // the demo's fetch beat
      }
      setProfile(saveBrand(entity))
      clearLandingWebsite()
      saveOnboardingProgress('reveal')
      setStep(1)
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : 'Could not read that URL.')
      setStep(0)
    } finally {
      setLooking(false)
    }
  }

  // No website to give, or doesn't want to: move on with a placeholder brand, same shape a failed read would leave.
  function skipWebsite() {
    if (looking) return
    setLookupError(null)
    setProfile(saveBrand(skippedBrand()))
    clearLandingWebsite()
    saveOnboardingProgress('reveal')
    setStep(1)
  }

  // Landing arrivals skip the website step: run the saved site's lookup on
  // mount and land directly on the reveal. Failures fall back to step 0.
  const autoLookupRan = useRef(false)
  useEffect(() => {
    if (autoLookupRan.current) return
    const saved = readLandingWebsite().trim()
    if (!saved || profile) return
    autoLookupRan.current = true
    setBrandUrl(saved)
    void lookupBrand(saved)
    // Runs once on mount; lookupBrand is stable for this purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The clouds hero lives in OnboardingShell above this content, so every
  // onboarding screen opens identically — steps never render their own copy.
  return (
    <div className="relative mx-auto flex w-full max-w-7xl flex-1 flex-col items-center justify-center px-6 pb-16 text-center sm:px-10">
      {import.meta.env.DEV && !requireSignIn ? (
        <div className="fixed left-2 top-2 z-[60] flex items-center gap-0.5 rounded-full bg-black/60 px-2 py-1 text-[11px] text-white backdrop-blur">
          <span className="px-1 font-bold text-amber-300">DEV</span>
          {(['Website', 'Reveal', 'Extension', 'Platforms', 'Tokens', 'Ready'] as const).map((label, index) => (
            <button
              key={label}
              type="button"
              onClick={() => debugGoTo(index as Step)}
              aria-current={step === index ? 'step' : undefined}
              className={`rounded-full px-2 py-0.5 transition-colors ${
                step === index ? 'bg-white font-bold text-slate-900' : 'hover:bg-white/20'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {step === 3 && (
        <div className="mt-8 w-full">
          <h1 className="text-4xl font-bold leading-tight sm:text-5xl">Where should we listen?</h1>
          <p className="mt-4 text-lg text-white/85">
            Pick the platforms you care about. We&apos;ll cluster what customers keep repeating.
          </p>
          <div className="mx-auto mt-8 flex w-full max-w-4xl flex-wrap justify-center gap-4">
            {SOCIAL_ICONS.filter(icon => enabledPlatforms.includes(icon.id as 'reddit' | 'x' | 'facebook')).map((icon) => {
              const active = sources.includes(icon.id)
              return (
                <Button
                  key={icon.id}
                  type="button"
                  onClick={() => toggleSource(icon.id)}
                  aria-pressed={active}
                  className={`h-auto min-h-44 w-full flex-row items-center gap-5 whitespace-normal rounded-3xl border p-6 text-left sm:w-[calc(50%-0.5rem)] ${
                    active
                      ? 'border-white bg-white text-[#2a8cff]'
                      : 'border-white/30 bg-white/10 text-white hover:bg-white/20'
                  }`}
                >
                  <SocialGlyph icon={icon} className="size-20 shrink-0" />
                  <span className="flex-1">
                    <span className="block text-3xl font-bold">{icon.label}</span>
                    <span className={`mt-1 block text-base ${active ? 'text-[#2a8cff]/70' : 'text-white/70'}`}>
                      {active ? 'Selected — tap to remove' : 'Tap to select'}
                    </span>
                  </span>
                </Button>
              )
            })}
          </div>
          <Button
            type="button"
            onClick={continueFromSources}
            disabled={sources.length === 0}
            size="xl"
            shadow="hard"
            className="mt-6 h-14 gap-3 rounded-xl bg-white px-10 font-bold text-slate-900 hover:bg-white/90"
          >
            Continue with {sources.length === 0 ? '…' : (SOCIAL_ICONS.find((icon) => icon.id === sources[0])?.label ?? '…')}
            {sources.length > 0 && (
              <span className="flex items-center">
                {sources.map((id) => {
                  const icon = SOCIAL_ICONS.find((i) => i.id === id)
                  if (!icon) return null
                  return (
                    <span
                      key={id}
                      title={icon.label}
                      className="-ml-2 flex size-8 items-center justify-center rounded-full bg-[#2a8cff] ring-2 ring-white first:ml-0"
                    >
                      <SocialGlyph icon={icon} className="size-4 text-white" />
                    </span>
                  )
                })}
              </span>
            )}
          </Button>
        </div>
      )}

      {step === 3 && requireSignIn && (
        <p className="mt-6 text-sm text-white/70">
          Already have a workspace?{' '}
          <a href="/sign-in" className="font-semibold text-white underline decoration-dashed underline-offset-4">Sign in</a>
          {' · '}
          <a href="/sign-up" className="font-semibold text-white underline decoration-dashed underline-offset-4">Create account</a>
        </p>
      )}

      {step === 2 && (
        <div className="mt-8 w-full">
          <h1 className="text-4xl font-bold leading-tight sm:text-5xl">
             Watch this here quick video
           </h1>
          <div className="mx-auto mt-6 w-full max-w-3xl overflow-hidden rounded-3xl border border-white/30 bg-white/10" style={{ aspectRatio: '16/10' }}>
            <FunnelVideo src={VIDEO_URL} title="How ListeningKit works" variant="controls" />
          </div>
          <h2 className="mt-10 text-2xl font-bold sm:text-3xl">
            Install the Chrome Extension
          </h2>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setShowInstall((open) => !open)}
              aria-expanded={showInstall}
              className="flex items-center gap-4 rounded-3xl border border-white/30 bg-white/10 p-5 text-left text-white transition-colors hover:bg-white/20"
            >
              <svg viewBox="0 0 24 24" role="img" aria-label="Google Chrome" className="size-12 shrink-0" fill="currentColor">
                <path d={siGooglechrome.path} />
              </svg>
              <span>
                <span className="block text-xl font-bold">Install the Chrome Extension</span>
                <span className="mt-0.5 block text-sm text-white/70">Works in Chrome, Edge and Brave. Takes a minute.</span>
              </span>
            </button>
            <a
              href={EXTENSION_SOURCE}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-4 rounded-3xl border border-white/30 bg-white/10 p-5 text-left text-white transition-colors hover:bg-white/20"
            >
              <svg viewBox="0 0 24 24" role="img" aria-label="GitHub" className="size-12 shrink-0" fill="currentColor">
                <path d={siGithub.path} />
              </svg>
              <span>
                <span className="block text-xl font-bold">Install from Github</span>
                <span className="mt-0.5 block text-sm text-white/70">Read the source, or build it yourself</span>
              </span>
            </a>
          </div>
          {showInstall && (
            <div className="mx-auto mt-4 w-full max-w-3xl rounded-3xl border border-white/30 bg-white/10 p-6 text-left">
              <p className="text-lg font-bold">Four steps, one time</p>
              <ol className="mt-3 flex flex-col gap-3 text-white/90">
                <li className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white text-xs font-bold text-[#2a8cff]">1</span>
                  <span>
                    <a href={EXTENSION_ZIP} download className="font-bold underline decoration-dashed underline-offset-4">Download the extension</a>{' '}
                    and unzip it anywhere you like.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white text-xs font-bold text-[#2a8cff]">2</span>
                  <span>
                    In your browser&apos;s address bar, type <code className="rounded bg-black/20 px-1.5 py-0.5">chrome://extensions</code> and press Enter.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white text-xs font-bold text-[#2a8cff]">3</span>
                  <span>Turn on <strong>Developer mode</strong> (top right).</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white text-xs font-bold text-[#2a8cff]">4</span>
                  <span>
                    Click <strong>Load unpacked</strong> and choose the unzipped <strong>listeningkit-extension</strong> folder. Then pin it with the puzzle icon.
                  </span>
                </li>
              </ol>
              <p className="mt-4 text-sm text-white/70">
                We ask for cookie access only on reddit.com, x.com and facebook.com. The extension sends nothing anywhere. It just copies a token to your clipboard.
              </p>
            </div>
          )}
          <Button
            type="button"
            onClick={finishExtension}
            size="xl"
            shadow="hard"
            className="mt-6 h-14 rounded-xl bg-white px-10 font-bold text-slate-900 hover:bg-white/90"
          >
            Continue
          </Button>
          <div className="mt-4 text-center">
            <button
              type="button"
              onClick={finishExtension}
              className="bg-transparent p-0 text-sm font-semibold text-white/70 underline decoration-dashed underline-offset-4 transition-colors hover:text-white"
            >
              Skip getting the extension, although it&apos;s highly recommended.
            </button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="mt-8 flex w-full flex-col items-center">
          <h1 className="text-4xl font-bold leading-tight sm:text-5xl">
            Connect your accounts
          </h1>
          <div className="mt-6 w-[min(100vw-4rem,96rem)] rounded-[32px] bg-white p-6 text-slate-900 sm:p-10">
          <div className="grid grid-cols-1 items-stretch gap-6 text-left lg:grid-cols-[minmax(0,9fr)_minmax(0,8fr)]">
            <div className="flex h-full min-h-80 flex-col justify-center overflow-hidden rounded-3xl border border-slate-200 bg-black">
              <div className="aspect-video w-full">
                <FunnelVideo src={VIDEO_URL} title="How ListeningKit works" variant="controls" />
              </div>
            </div>
            <div className="w-full rounded-3xl border border-slate-200 bg-slate-50 p-6 sm:p-8">
              <p className="text-2xl font-bold">Paste your tokens</p>
              <p className="mt-1 text-sm text-slate-600">
                {sessionsOnConvex()
                  ? 'We check your token, then keep it encrypted so ListeningKit can listen as you. You can disconnect anytime in Settings.'
                  : 'Tokens stay in your browser for this hackathon demo — nothing is uploaded.'}
              </p>
              <div className="mt-5 flex flex-col gap-5">
                {SOCIAL_ICONS.filter((icon) => sources.includes(icon.id)).map((icon) => (
                  <div key={icon.id}>
                    <span className="flex items-center gap-2 text-sm font-bold text-slate-900">
                      <SocialGlyph icon={icon} className="size-5 text-slate-700" />
                      What we need from {icon.label}
                    </span>
                    <ol className="ml-6 mt-3 flex flex-col gap-2">
                      <li className="flex gap-2.5 text-sm text-slate-600">
                        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#eaf0f6] text-[11px] font-bold text-slate-900">
                          1
                        </span>
                        <span>
                          Make sure you&apos;ve got the{' '}
                          <a
                            href={EXTENSION_ZIP}
                            target="_blank"
                            rel="noreferrer"
                            className="font-semibold underline decoration-dashed underline-offset-4 hover:text-[#2a8cff]"
                          >
                            ListeningKit Chrome extension
                          </a>{' '}
                          installed.
                        </span>
                      </li>
                      <li className="flex gap-2.5 text-sm text-slate-600">
                        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#eaf0f6] text-[11px] font-bold text-slate-900">
                          2
                        </span>
                        <span>
                          Navigate to{' '}
                          <a
                            href={PLATFORM_SITES[icon.id]?.url ?? '#'}
                            target="_blank"
                            rel="noreferrer"
                            className="font-semibold underline decoration-dashed underline-offset-4 hover:text-[#2a8cff]"
                          >
                            {PLATFORM_SITES[icon.id]?.label ?? icon.label}
                          </a>{' '}
                          and log in.
                        </span>
                      </li>
                      <li className="flex gap-2.5 text-sm text-slate-600">
                        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#eaf0f6] text-[11px] font-bold text-slate-900">
                          3
                        </span>
                        <span>Click the ListeningKit Connect icon in your browser, then press &ldquo;Copy your {icon.label} token&rdquo;.</span>
                      </li>
                      <li className="flex gap-2.5 text-sm text-slate-600">
                        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#eaf0f6] text-[11px] font-bold text-slate-900">
                          4
                        </span>
                        <span>Paste it below.</span>
                      </li>
                    </ol>
                    <label className="mt-3 block">
                      <span className="mb-1.5 block text-sm font-semibold text-slate-700">
                        {icon.label} token
                      </span>
                      <input
                        type="password"
                        value={tokens[icon.id] ?? ''}
                        onChange={(e) => {
                          setTokens((prev) => ({ ...prev, [icon.id]: e.target.value }))
                          setSaved(false)
                        }}
                        disabled={connected[icon.id] !== undefined}
                        placeholder={connected[icon.id] !== undefined ? 'Connected' : `Paste your ${icon.label} token`}
                        autoComplete="off"
                        className="h-14 w-full rounded-xl border border-slate-300 bg-white px-4 text-slate-900 placeholder:text-slate-400 focus:border-[#2a8cff] focus:outline-none disabled:bg-slate-100"
                      />
                    </label>
                    {connected[icon.id] !== undefined && (
                      <p className="mt-2 text-sm font-semibold text-emerald-600">
                        Connected &middot; {connected[icon.id]}
                      </p>
                    )}
                  </div>
                ))}
              </div>
<Button
                type="button"
                onClick={saveTokens}
                disabled={saving}
                size="xl"
                shadow="hard"
                variant={saved && !saving ? 'default' : 'blue'}
                className={`mt-6 h-14 w-full rounded-xl px-10 font-bold text-white disabled:opacity-80 ${
                  saved && !saving ? 'bg-emerald-600 hover:bg-emerald-600' : ''
                }`}
              >
                {saving ? (
                  <>
                    <svg className="size-5 animate-spin" viewBox="0 0 24 24" fill="none" aria-label="Saving">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
                    </svg>
                    Saving…
                  </>
                ) : saved ? (
                  'Saved'
                ) : (
'Save tokens'
)}
                </Button>
                {sessionsOnConvex() && (
                  <div className="mt-3 text-center">
                    <button
                      type="button"
                      onClick={() => {
                        saveOnboardingProgress('done')
                        setStep(5)
                      }}
                      className="bg-transparent p-0 text-sm font-semibold text-slate-500 underline decoration-dashed underline-offset-4 hover:text-slate-800"
                    >
                      Skip for now. You can connect later in Settings.
                    </button>
                  </div>
                )}
              </div>
           </div>
           </div>
         </div>
       )}

      {step === 0 && (
        <div className="mt-8 w-full">
          <h1 className="text-4xl font-bold leading-tight sm:text-5xl">Whose brand are we listening for?</h1>
          <p className="mt-4 text-lg text-white/85">
            Paste your website and we&apos;ll pull your brand profile — drafts and replies will sound like you.
          </p>
          <div className="mx-auto mt-8 w-full max-w-4xl text-left">
            {profile ? (
              <div className="rounded-2xl bg-white p-5 text-slate-900">
                <p className="text-xs font-bold uppercase text-[#2a8cff]">Brand profile</p>
                <p className="mt-1 text-2xl font-bold">{profile.identity.name}</p>
                <p className="mt-0.5 text-sm text-slate-600">{profile.identity.tagline}</p>
                <p className="mt-2 text-sm text-slate-600">
                  <span className="font-semibold text-slate-900">Site:</span> {profile.identity.website}
                </p>
                <p className="mt-1 text-sm text-slate-600">
                  <span className="font-semibold text-slate-900">Voice:</span> {profile.voice.tone}
                </p>
                <p className="mt-1 text-sm text-slate-600">
                  <span className="font-semibold text-slate-900">Offerings:</span>{' '}
                  {profile.offerings.length > 0 ? profile.offerings.map((offering) => offering.name).join(', ') : 'None detected yet'}
                </p>
                <button
                  type="button"
                  onClick={() => setProfile(null)}
                  className="mt-3 bg-transparent p-0 text-sm font-semibold text-slate-500 underline decoration-dashed underline-offset-4 hover:text-slate-800"
                >
                  Use a different website
                </button>
              </div>
            ) : (
              <>
                <div className="rounded-2xl bg-white p-5">
                  <label className="block">
                    <textarea
                      value={brandUrl}
                      onChange={(e) => {
                        setBrandUrl(e.target.value)
                        setLookupError(null)
                      }}
                      placeholder={'Paste your website URL here, e.g. acmeplumbing.com'}
                      rows={1}
                      autoComplete="off"
                      inputMode="url"
                      className="w-full resize-none overflow-hidden whitespace-nowrap rounded-xl border border-slate-200 bg-white px-5 py-4 text-3xl font-bold text-slate-900 placeholder:font-normal placeholder:text-slate-400 focus:border-[#2a8cff] focus:outline-none"
                    />
                  </label>
                  {lookupError ? <p className="mt-2 text-sm font-semibold text-red-600">{lookupError}</p> : null}
                </div>
                <div className="mt-4 flex justify-center">
                  <Button
                    type="button"
                    onClick={() => lookupBrand()}
                    disabled={looking || brandUrl.trim().length === 0}
                    size="xl"
                    shadow="hard"
                    className="h-14 w-full max-w-md rounded-xl bg-white px-10 font-bold text-slate-900 hover:bg-white/90 disabled:opacity-60"
                  >
                    {looking ? 'Looking up…' : 'Continue'}
                  </Button>
                </div>
                <div className="mt-4 text-center">
                  <button
                    type="button"
                    onClick={skipWebsite}
                    disabled={looking}
                    className="bg-transparent p-0 text-sm font-semibold text-white/70 underline decoration-dashed underline-offset-4 transition-colors hover:text-white disabled:opacity-60"
                  >
                    Skip for now.
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {step === 1 && !profile && (
        <div className="mt-8 flex w-full flex-col items-center">
          {looking ? (
            <OnboardingLoading message="Reading your website…" tone="dark" />
          ) : (
            <>
              <p className="text-lg font-bold text-white">We could not read that website.</p>
              <button
                type="button"
                onClick={() => setStep(0)}
                className="mt-4 bg-transparent p-0 text-sm font-semibold text-white/70 underline decoration-dashed underline-offset-4 transition-colors hover:text-white"
              >
                Enter your website
              </button>
            </>
          )}
        </div>
      )}

      {step === 1 && profile && (
        <div
          className={`relative mt-8 w-full transition-all duration-700 ease-out ${
            revealLeaving ? '-translate-y-10 opacity-0' : ''
          }`}
        >
          <div ref={revealScrollRef} className="lk-no-scrollbar max-h-[68vh] overflow-y-auto pb-28 pt-20">
            <BrandRevealStep profile={profile} onContinue={handleRevealContinue} leaving={revealLeaving} />
          </div>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 z-30 h-24 bg-gradient-to-b from-[#2a8cff] to-transparent"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 z-30 h-24 bg-gradient-to-t from-[#2a8cff] to-transparent"
          />
        </div>
      )}

      {step === 5 && <ReadyFill />}
    </div>
  )
}
