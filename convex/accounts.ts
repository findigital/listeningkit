import { ConvexError, v } from 'convex/values'
import { accountLimitMessage, atLimit, planLimits } from './lib/plan'
import { isPlatformEnabled, platformDisabledMessage } from './lib/platformConfig'
import { mutation, query, requireOwner, type MutationCtx } from './lib/server'
import { platform } from './schema'

function publicAccount(row: { _id: string; platform: 'facebook' | 'x' | 'reddit'; label: string; connectedAt: string | null }) {
  return { id: row._id, platform: row.platform, label: row.label, connectedAt: row.connectedAt }
}

export const list = query({
  args: {},
  handler: async ctx => {
    const owner = await requireOwner(ctx)
    const rows = await ctx.db.query('accounts').withIndex('by_owner', q => q.eq('owner', owner)).take(200)
    return { accounts: rows.map(publicAccount) }
  },
})

const createArgs = { platform, label: v.string() }
async function insertAccount(ctx: MutationCtx, args: { platform: 'facebook' | 'x' | 'reddit'; label: string }) {
  // Check if this platform is enabled on this deployment
  if (!isPlatformEnabled(args.platform)) {
    throw new ConvexError(platformDisabledMessage(args.platform))
  }
  const owner = await requireOwner(ctx)
  const label = args.label.trim()
  if (!label || label.length > 120) throw new ConvexError('Label must contain 1-120 characters')
  const rows = await ctx.db.query('accounts').withIndex('by_owner', q => q.eq('owner', owner)).take(200)
  if (rows.length >= 200) throw new ConvexError('Account limit reached')
  // The Free plan: one account per platform at a time. Accounts someone already has are left alone.
  const { accountsPerPlatform } = planLimits()
  if (atLimit(rows.filter(row => row.platform === args.platform).length, accountsPerPlatform)) {
    throw new ConvexError(accountLimitMessage(args.platform, accountsPerPlatform))
  }
  const record = { owner, platform: args.platform, label, connectedAt: null }
  const id = await ctx.db.insert('accounts', record)
  const account = publicAccount({ ...record, _id: id })
  return { id, account, accounts: [...rows.map(publicAccount), account] }
}

export const create = mutation({
  args: createArgs,
  handler: async (ctx, args) => (await insertAccount(ctx, args)).id,
})

/** Atomic frontend response; a concurrent request cannot hide the newly created row. */
export const createWithResponse = mutation({
  args: createArgs,
  handler: async (ctx, args) => {
    const { account, accounts } = await insertAccount(ctx, args)
    return { account, accounts }
  },
})
