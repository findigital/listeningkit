/**
 * Adding, pausing and removing phrases, in one place. The dashboard (keywords.ts) and the public API (publicApi.ts) both
 * call these, so validation and the plan limits are the same for a click and for a program.
 */
import { ConvexError } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import { ensureAccount } from './accounts'
import { atLimit, phraseLimitMessage, planLimits } from './plan'
import { isPlatformEnabled, platformDisabledMessage, type Platform } from './platformConfig'
import type { MutationCtx } from './server'

export const MAX_KEYWORDS = 50
const SUBREDDIT = /^[A-Za-z0-9_]{1,21}$/

export function publicKeyword(row: {
  _id: string; _creationTime: number; phrase: string; platform: Platform
  status: 'listening' | 'paused'; subreddit?: string; signalsCount?: number
  lastCheckedAt?: number; lastSource?: 'reddit' | 'mirror' | 'helper'
}) {
  return {
    id: row._id, phrase: row.phrase, platform: row.platform, status: row.status,
    subreddit: row.subreddit ?? null, signalsCount: row.signalsCount ?? 0, addedAt: row._creationTime,
    lastCheckedAt: row.lastCheckedAt ?? null, lastSource: row.lastSource ?? null,
  }
}

/** Reddit keywords name the subreddit to watch; X and Facebook phrases listen wherever their account reads. */
export async function createKeywordCore(
  ctx: MutationCtx, owner: string, args: { phrase: string; platform: Platform; subreddit?: string },
): Promise<Doc<'keywords'>> {
  // Check if this platform is enabled on this deployment
  if (!isPlatformEnabled(args.platform)) {
    throw new ConvexError(platformDisabledMessage(args.platform))
  }
  const phrase = args.phrase.trim().replace(/\s+/g, ' ')
  if (phrase.length < 2 || phrase.length > 100) throw new ConvexError('A phrase needs 2-100 characters')
  let subreddit: string | undefined
  if (args.platform === 'reddit') {
    const name = (args.subreddit ?? '').trim().replace(/^\/?r\//i, '')
    if (!SUBREDDIT.test(name)) throw new ConvexError('Pick a subreddit: letters, numbers or underscores, up to 21')
    subreddit = name.toLowerCase()
  } else if (args.subreddit) {
    throw new ConvexError('Only Reddit phrases take a subreddit')
  }
  const rows = await ctx.db.query('keywords').withIndex('by_owner', q => q.eq('owner', owner)).take(MAX_KEYWORDS + 1)
  if (rows.length >= MAX_KEYWORDS) throw new ConvexError(`You can listen for up to ${MAX_KEYWORDS} phrases`)
  const duplicate = rows.some(row =>
    row.platform === args.platform && row.subreddit === subreddit && row.phrase.toLowerCase() === phrase.toLowerCase())
  if (duplicate) throw new ConvexError('You are already listening for that phrase there')
  // The Free plan: one phrase per platform at a time. Phrases someone already has are left alone; only a new one is refused.
  const { phrasesPerPlatform } = planLimits()
  if (atLimit(rows.filter(row => row.platform === args.platform).length, phrasesPerPlatform)) {
    throw new ConvexError(phraseLimitMessage(args.platform, phrasesPerPlatform))
  }
  const account = await ensureAccount(ctx, owner, args.platform)
  const id = await ctx.db.insert('keywords', {
    owner, accountId: account._id, platform: args.platform, phrase, status: 'listening',
    ...(subreddit === undefined ? {} : { subreddit }), signalsCount: 0,
  })
  const row = await ctx.db.get(id)
  if (!row) throw new ConvexError('Could not save the phrase')
  return row
}

export async function setKeywordStatusCore(
  ctx: MutationCtx, owner: string, id: Id<'keywords'>, status: 'listening' | 'paused',
): Promise<Doc<'keywords'>> {
  const row = await ctx.db.get(id)
  if (!row || row.owner !== owner) throw new ConvexError('Phrase not found')
  await ctx.db.patch(id, { status })
  return { ...row, status }
}

export async function removeKeywordCore(ctx: MutationCtx, owner: string, id: Id<'keywords'>): Promise<void> {
  const row = await ctx.db.get(id)
  if (!row || row.owner !== owner) throw new ConvexError('Phrase not found')
  // Its matches go with it; bounded per call so one transaction stays small.
  const hits = await ctx.db.query('hits').withIndex('by_keyword_and_post', q => q.eq('keywordId', id)).take(500)
  for (const hit of hits) await ctx.db.delete(hit._id)
  await ctx.db.delete(id)
}
