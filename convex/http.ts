import { registerStaticRoutes } from '@convex-dev/static-hosting'
import { httpActionGeneric, httpRouter, type GenericActionCtx, type GenericDataModel } from 'convex/server'
import { ConvexError } from 'convex/values'
import { components, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { RATE_LIMIT_PER_MINUTE } from './apiKeys'
import { MAX_POSTS_PER_BATCH } from './feed'
import { decryptText } from './lib/crypto'
import { sha256Hex } from './lib/hash'
import { normalizePushedPost, type NormalizedPost } from './lib/posts'
import { mayRead, proxyState } from './lib/proxy'
import { handleMcp } from './lib/mcp'
import { hasScope, type Scope } from './lib/scopes'
import { isPlatformEnabled } from './lib/platformConfig'
import { DEFAULT_MATCHES_PER_PAGE, MAX_MATCHES_PER_PAGE } from './publicApi'

const PLATFORMS = ['facebook', 'x', 'reddit'] as const
type Platform = typeof PLATFORMS[number]

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

const http = httpRouter()

// Server-to-server push for the platform clients: Authorization: Bearer lk_ingest_…
http.route({
  path: '/ingest',
  method: 'POST',
  handler: httpActionGeneric(async (ctx, req) => {
    const secret = req.headers.get('Authorization')?.match(/^Bearer (lk_ingest_[A-Za-z0-9]{20,100})$/)?.[1]
    if (!secret) return json({ error: 'Authentication required' }, 401)
    const input: unknown = await req.json().catch(() => null)
    if (typeof input !== 'object' || input === null) return json({ error: 'Expected a JSON object' }, 400)
    const { platform, posts } = input as { platform?: unknown; posts?: unknown }
    if (!PLATFORMS.includes(platform as Platform)) return json({ error: 'platform must be facebook, x, or reddit' }, 400)
    // Check if this platform is enabled on this deployment
    if (!isPlatformEnabled(platform as Platform)) return json({ error: `${platform} is not enabled on this deployment` }, 403)
    if (!Array.isArray(posts) || posts.length < 1 || posts.length > MAX_POSTS_PER_BATCH) {
      return json({ error: `posts must be an array of 1-${MAX_POSTS_PER_BATCH} items` }, 400)
    }
    const valid = posts.map(normalizePushedPost).filter((post): post is NormalizedPost => post !== null)
    const skipped = posts.length - valid.length
    if (valid.length === 0) return json({ error: 'No valid posts in the batch', skipped }, 422)
    try {
      const result = await ctx.runMutation(internal.ingest.commit, {
        keyHash: await sha256Hex(secret), platform: platform as Platform, posts: valid,
      })
      return json({ accountId: result.accountId, ingested: result.processed, skipped }, 200)
    } catch (error) {
      if (error instanceof ConvexError && error.data === 'Invalid ingest key') return json({ error: 'Invalid ingest key' }, 401)
      return json({ error: 'Ingest failed' }, 500)
    }
  }),
})

// Local platform clients fetch the login you connected in the dashboard, instead of a cookies file.
http.route({
  path: '/session',
  method: 'GET',
  handler: httpActionGeneric(async (ctx, req) => {
    const secret = req.headers.get('Authorization')?.match(/^Bearer (lk_ingest_[A-Za-z0-9]{20,100})$/)?.[1]
    if (!secret) return json({ error: 'Authentication required' }, 401)
    const platform = new URL(req.url).searchParams.get('platform')
    if (!PLATFORMS.includes(platform as Platform)) return json({ error: 'platform must be facebook, x, or reddit' }, 400)
    // Check if this platform is enabled on this deployment
    if (!isPlatformEnabled(platform as Platform)) return json({ error: `${platform} is not enabled on this deployment` }, 403)
    try {
      const sealed = await ctx.runQuery(internal.sessions.sealedForKey, { keyHash: await sha256Hex(secret), platform: platform as Platform })
      if (!sealed) return json({ error: `No ${platform} account is connected` }, 404)
      const cookies = JSON.parse(await decryptText(sealed)) as unknown
      return json({ platform, cookies, expiresAt: sealed.expiresAt }, 200)
    } catch (error) {
      if (error instanceof ConvexError && error.data === 'Invalid ingest key') return json({ error: 'Invalid ingest key' }, 401)
      return json({ error: 'Could not read the saved login' }, 500)
    }
  }),
})

// The phrases the local helper should search for, so it needs no login of its own beyond the ingest key.
http.route({
  path: '/phrases',
  method: 'GET',
  handler: httpActionGeneric(async (ctx, req) => {
    const secret = req.headers.get('Authorization')?.match(/^Bearer (lk_ingest_[A-Za-z0-9]{20,100})$/)?.[1]
    if (!secret) return json({ error: 'Authentication required' }, 401)
    const platform = new URL(req.url).searchParams.get('platform')
    if (!PLATFORMS.includes(platform as Platform)) return json({ error: 'platform must be facebook, x, or reddit' }, 400)
    // Check if this platform is enabled on this deployment
    if (!isPlatformEnabled(platform as Platform)) return json({ error: `${platform} is not enabled on this deployment` }, 403)
    try {
      const phrases = await ctx.runQuery(internal.keywords.forKey, { keyHash: await sha256Hex(secret), platform: platform as Platform })
      return json({ platform, phrases }, 200)
    } catch (error) {
      if (error instanceof ConvexError && error.data === 'Invalid ingest key') return json({ error: 'Invalid ingest key' }, 401)
      return json({ error: 'Could not load phrases' }, 500)
    }
  }),
})

// The proxy the helper must browse through. Only a valid ingest key gets it, and it is never logged or returned elsewhere.
http.route({
  path: '/proxy',
  method: 'GET',
  handler: httpActionGeneric(async (ctx, req) => {
    const secret = req.headers.get('Authorization')?.match(/^Bearer (lk_ingest_[A-Za-z0-9]{20,100})$/)?.[1]
    if (!secret) return json({ error: 'Authentication required' }, 401)
    try {
      await ctx.runQuery(internal.ingest.verifyKey, { keyHash: await sha256Hex(secret) })
    } catch (error) {
      if (error instanceof ConvexError && error.data === 'Invalid ingest key') return json({ error: 'Invalid ingest key' }, 401)
      return json({ error: 'Could not check the key' }, 500)
    }
    const state = proxyState({ PROXY_URL: process.env.PROXY_URL, PROXY_REQUIRED: process.env.PROXY_REQUIRED })
    if (!mayRead(state)) return json({ error: 'Reading is paused until the operator sets up the proxy' }, 503)
    return json({ required: state.required, proxy: state.proxy }, 200)
  }),
})

const MAX_DM_INGEST_BODY = 65_536

// Real direct messages, read and (on X, today) sent by the helper on the person's own computer, with an ingest key.
http.route({
  path: '/dm/ingest',
  method: 'POST',
  handler: httpActionGeneric(async (ctx, req) => {
    const secret = req.headers.get('Authorization')?.match(/^Bearer (lk_ingest_[A-Za-z0-9]{20,100})$/)?.[1]
    if (!secret) return json({ error: 'Authentication required' }, 401)
    const text = await req.text()
    if (text.length > MAX_DM_INGEST_BODY) return json({ error: 'Batch is too large' }, 413)
    let input: unknown
    try { input = JSON.parse(text) } catch { return json({ error: 'Expected a JSON object' }, 400) }
    if (typeof input !== 'object' || input === null) return json({ error: 'Expected a JSON object' }, 400)
    const { platform: p, threads } = input as { platform?: unknown; threads?: unknown }
    if (!PLATFORMS.includes(p as Platform)) return json({ error: 'platform must be facebook, x, or reddit' }, 400)
    if (!Array.isArray(threads) || threads.length < 1) return json({ error: 'threads must be a non-empty array' }, 400)
    try {
      const result = await ctx.runMutation(internal.messages.ingestDms, {
        keyHash: await sha256Hex(secret), platform: p as Platform, threads,
      })
      return json(result, 200)
    } catch (error) {
      if (error instanceof ConvexError) return json({ error: typeof error.data === 'string' ? error.data : 'Invalid request' }, error.data === 'Invalid ingest key' ? 401 : 400)
      return json({ error: 'DM ingest failed' }, 500)
    }
  }),
})

http.route({
  path: '/dm/pending',
  method: 'GET',
  handler: httpActionGeneric(async (ctx, req) => {
    const secret = req.headers.get('Authorization')?.match(/^Bearer (lk_ingest_[A-Za-z0-9]{20,100})$/)?.[1]
    if (!secret) return json({ error: 'Authentication required' }, 401)
    const p = new URL(req.url).searchParams.get('platform')
    if (!PLATFORMS.includes(p as Platform)) return json({ error: 'platform must be facebook, x, or reddit' }, 400)
    try {
      const pending = await ctx.runQuery(internal.messages.pendingForKey, { keyHash: await sha256Hex(secret), platform: p as Platform })
      return json({ pending }, 200)
    } catch (error) {
      if (error instanceof ConvexError && error.data === 'Invalid ingest key') return json({ error: 'Invalid ingest key' }, 401)
      return json({ error: 'Could not load pending messages' }, 500)
    }
  }),
})

http.route({
  path: '/dm/sent',
  method: 'POST',
  handler: httpActionGeneric(async (ctx, req) => {
    const secret = req.headers.get('Authorization')?.match(/^Bearer (lk_ingest_[A-Za-z0-9]{20,100})$/)?.[1]
    if (!secret) return json({ error: 'Authentication required' }, 401)
    const body = await req.json().catch(() => null) as { messageId?: unknown; externalId?: unknown } | null
    if (!body || typeof body.messageId !== 'string') return json({ error: 'messageId is required' }, 400)
    try {
      await ctx.runMutation(internal.messages.markSent, {
        keyHash: await sha256Hex(secret), messageId: body.messageId as Id<'dmMessages'>,
        ...(typeof body.externalId === 'string' ? { externalId: body.externalId } : {}),
      })
      return json({ ok: true }, 200)
    } catch (error) {
      if (error instanceof ConvexError) return json({ error: error.data }, error.data === 'Invalid ingest key' ? 401 : 404)
      return json({ error: 'Could not update the message' }, 500)
    }
  }),
})

http.route({
  path: '/dm/failed',
  method: 'POST',
  handler: httpActionGeneric(async (ctx, req) => {
    const secret = req.headers.get('Authorization')?.match(/^Bearer (lk_ingest_[A-Za-z0-9]{20,100})$/)?.[1]
    if (!secret) return json({ error: 'Authentication required' }, 401)
    const body = await req.json().catch(() => null) as { messageId?: unknown; error?: unknown } | null
    if (!body || typeof body.messageId !== 'string' || typeof body.error !== 'string') return json({ error: 'messageId and error are required' }, 400)
    try {
      await ctx.runMutation(internal.messages.markFailed, { keyHash: await sha256Hex(secret), messageId: body.messageId as Id<'dmMessages'>, error: body.error })
      return json({ ok: true }, 200)
    } catch (error) {
      if (error instanceof ConvexError) return json({ error: error.data }, error.data === 'Invalid ingest key' ? 401 : 404)
      return json({ error: 'Could not update the message' }, 500)
    }
  }),
})

// ---- The public API: /api/v1, authenticated with a key made in the dashboard (Authorization: Bearer lk_api_...). ----
// Every key can read. Writing phrases and managing webhooks need the matching scope, ticked when the key was made.

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retry?: string) { super(message) }
}

/** A successful answer that is not a plain 200 (a 201 on create, extra headers). */
class ApiResult {
  constructor(readonly body: unknown, readonly status = 200, readonly headers: Record<string, string> = {}) {}
}

function apiJson(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  })
}

function apiFailure(error: ApiError, extra: Record<string, string> = {}): Response {
  return apiJson({ error: { code: error.code, message: error.message } }, error.status, extra)
}

/** A plain-words failure from the shared phrase and webhook code, as the right HTTP status. */
function fromConvex(error: { data: unknown }): ApiError {
  const message = typeof error.data === 'string' ? error.data : 'The request could not be completed'
  if (/not found$/i.test(message)) return new ApiError(404, 'not_found', message)
  if (/^The Free plan|are part of the Pro plan/.test(message)) return new ApiError(403, 'plan_limit', message)
  if (/already listening|already has|already have/.test(message)) return new ApiError(409, 'conflict', message)
  return new ApiError(400, 'invalid_request', message)
}

/** A whole number within a range, or a plain-words 400. */
function wholeParam(url: URL, name: string, min: number, max: number): number | undefined {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiError(400, 'invalid_parameter', `${name} must be a whole number from ${min} to ${max}`)
  return n
}

/** A non-negative number (the cursor: a creation time, which has fractions of a millisecond), or a plain-words 400. */
function cursorParam(url: URL): number | undefined {
  const raw = url.searchParams.get('before')
  if (raw === null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) throw new ApiError(400, 'invalid_parameter', 'before must be the nextCursor from the previous page')
  return n
}

/** The JSON object in the request body, small and well formed, or a plain-words 400. */
async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text()
  if (text.length > 4096) throw new ApiError(413, 'payload_too_large', 'The request body is too large')
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new ApiError(400, 'invalid_json', 'The request body must be a JSON object') }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ApiError(400, 'invalid_json', 'The request body must be a JSON object')
  return parsed as Record<string, unknown>
}

function text(body: Record<string, unknown>, name: string, required = true): string | undefined {
  const value = body[name]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string') throw new ApiError(400, 'invalid_parameter', `${name} must be a string`)
  return value
}

/** The id in /api/v1/<thing>/<id>, or a 404 when the address has anything else after it. */
function idAfter(url: URL, prefix: string): string {
  const rest = url.pathname.slice(prefix.length)
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(rest)) throw new ApiError(404, 'not_found', 'No such address')
  return rest
}

/** Checks the API key in the request and counts the request against its allowance. Throws an ApiError when it fails. */
async function authenticateKey(ctx: GenericActionCtx<GenericDataModel>, req: Request): Promise<{ owner: string; remaining: number; scopes: string[] }> {
  const secret = req.headers.get('Authorization')?.match(/^Bearer (lk_api_[A-Za-z0-9]{20,100})$/)?.[1]
  if (!secret) throw new ApiError(401, 'unauthorized', 'Send your API key as: Authorization: Bearer lk_api_...')
  const now = Date.now()
  try {
    return await ctx.runMutation(internal.apiKeys.authenticate, { keyHash: await sha256Hex(secret), now })
  } catch (error) {
    if (error instanceof ConvexError && error.data === 'Rate limited') {
      throw new ApiError(429, 'rate_limited', `Too many requests: ${RATE_LIMIT_PER_MINUTE} per minute per key`, String(60 - Math.floor((now % 60_000) / 1000)))
    }
    if (error instanceof ConvexError && error.data === 'Invalid API key') throw new ApiError(401, 'unauthorized', 'That API key is not valid, or it was revoked')
    throw new ApiError(500, 'server_error', 'Could not check the key')
  }
}

/** Checks the key and its scope, counts the request against its allowance, runs the handler, and shapes every failure the same way. */
async function apiRoute(
  ctx: GenericActionCtx<GenericDataModel>, req: Request, needs: Scope,
  handler: (owner: string, url: URL) => Promise<unknown>,
): Promise<Response> {
  try {
    const { owner, remaining, scopes } = await authenticateKey(ctx, req)
    if (!hasScope(scopes, needs)) {
      throw new ApiError(403, 'forbidden', `This key does not have the "${needs}" scope. Make a new key with it ticked.`)
    }
    const result = await handler(owner, new URL(req.url))
    const headers = { 'X-RateLimit-Limit': String(RATE_LIMIT_PER_MINUTE), 'X-RateLimit-Remaining': String(remaining) }
    return result instanceof ApiResult ? apiJson(result.body, result.status, { ...headers, ...result.headers }) : apiJson(result, 200, headers)
  } catch (error) {
    if (error instanceof ConvexError) return fromConvexResponse(error)
    if (error instanceof ApiError) return apiFailure(error, error.retry ? { 'Retry-After': error.retry } : {})
    console.error('api: request failed', error instanceof Error ? error.message : error)
    return apiFailure(new ApiError(500, 'server_error', 'Something went wrong on our side'))
  }
}

function fromConvexResponse(error: { data: unknown }): Response {
  return apiFailure(fromConvex(error))
}

// ---- reading (scope: read) ----
http.route({
  path: '/api/v1/me',
  method: 'GET',
  handler: httpActionGeneric(async (ctx, req) => apiRoute(ctx, req, 'read', async owner => ({ data: await ctx.runQuery(internal.publicApi.meFor, { owner }) }))),
})

http.route({
  path: '/api/v1/keywords',
  method: 'GET',
  handler: httpActionGeneric(async (ctx, req) => apiRoute(ctx, req, 'read', async owner => ({ data: await ctx.runQuery(internal.publicApi.keywordsFor, { owner }) }))),
})

http.route({
  pathPrefix: '/api/v1/keywords/',
  method: 'GET',
  handler: httpActionGeneric(async (ctx, req) => apiRoute(ctx, req, 'read', async (owner, url) => ({
    data: await ctx.runQuery(internal.publicApi.keywordById, { owner, id: idAfter(url, '/api/v1/keywords/') }),
  }))),
})

http.route({
  path: '/api/v1/matches',
  method: 'GET',
  handler: httpActionGeneric(async (ctx, req) => apiRoute(ctx, req, 'read', async (owner, url) => {
    const platform = url.searchParams.get('platform')
    if (platform !== null && !PLATFORMS.includes(platform as Platform)) throw new ApiError(400, 'invalid_parameter', 'platform must be reddit, x or facebook')
    const minScore = wholeParam(url, 'min_score', 0, 100)
    const before = cursorParam(url)
    return await ctx.runQuery(internal.publicApi.matchesFor, {
      owner,
      ...(platform === null ? {} : { platform: platform as Platform }),
      ...(minScore === undefined ? {} : { minScore }),
      ...(before === undefined ? {} : { before }),
      limit: wholeParam(url, 'limit', 1, MAX_MATCHES_PER_PAGE) ?? DEFAULT_MATCHES_PER_PAGE,
    })
  })),
})

http.route({
  pathPrefix: '/api/v1/matches/',
  method: 'GET',
  handler: httpActionGeneric(async (ctx, req) => apiRoute(ctx, req, 'read', async (owner, url) => ({
    data: await ctx.runQuery(internal.publicApi.matchById, { owner, id: idAfter(url, '/api/v1/matches/') }),
  }))),
})

// ---- MCP: the same data and the same rules, as tools for agents (Claude, Cursor, ChatGPT, Hermes, any MCP client). ----
// One JSON-RPC message per POST to /mcp, authenticated with the same API keys. Each tool needs the scope its REST twin needs.
http.route({
  path: '/mcp',
  method: 'POST',
  handler: httpActionGeneric(async (ctx, req) => {
    try {
      const { owner, remaining, scopes } = await authenticateKey(ctx, req)
      const raw = await req.text()
      if (raw.length > 16_384) return apiJson({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'The message is too large' } }, 413)
      let message: unknown
      try { message = JSON.parse(raw) } catch { return apiJson({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: send one JSON-RPC message' } }, 400) }
      const reply = await handleMcp(message, {
        scopes,
        run: async (tool, args) => {
          try {
            switch (tool.name) {
              case 'get_plan': return await ctx.runQuery(internal.publicApi.meFor, { owner })
              case 'list_keywords': return await ctx.runQuery(internal.publicApi.keywordsFor, { owner })
              case 'list_matches':
                return await ctx.runQuery(internal.publicApi.matchesFor, {
                  owner,
                  ...(args.platform === undefined ? {} : { platform: args.platform as Platform }),
                  ...(args.min_score === undefined ? {} : { minScore: args.min_score as number }),
                  ...(args.before === undefined ? {} : { before: args.before as number }),
                  limit: (args.limit as number | undefined) ?? 10,
                })
              case 'get_match': return await ctx.runQuery(internal.publicApi.matchById, { owner, id: args.id as string })
              case 'add_keyword': {
                const made = await ctx.runMutation(internal.publicApi.createKeyword, {
                  owner, phrase: args.phrase as string, platform: args.platform as Platform,
                  ...(args.community === undefined ? {} : { community: args.community as string }), now: Date.now(),
                })
                return made.keyword
              }
              case 'set_keyword_status': return await ctx.runMutation(internal.publicApi.setKeywordStatus, { owner, id: args.id as string, status: args.status as 'listening' | 'paused' })
              case 'remove_keyword': return await ctx.runMutation(internal.publicApi.deleteKeyword, { owner, id: args.id as string })
              default: throw new Error('Unknown tool')
            }
          } catch (error) {
            // Plain-words failures from the shared code (plan limit, not found, invalid) go back to the agent as they are.
            if (error instanceof ConvexError) throw new Error(fromConvex(error).message)
            console.error('mcp: tool failed', tool.name, error instanceof Error ? error.message : error)
            throw new Error('Something went wrong on our side. Try again.')
          }
        },
      })
      const headers = { 'X-RateLimit-Limit': String(RATE_LIMIT_PER_MINUTE), 'X-RateLimit-Remaining': String(remaining) }
      return reply === null ? new Response(null, { status: 202, headers }) : apiJson(reply, 200, headers)
    } catch (error) {
      if (error instanceof ApiError) {
        const headers: Record<string, string> = error.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="listeningkit"' } : error.retry ? { 'Retry-After': error.retry } : {}
        return apiJson({ jsonrpc: '2.0', id: null, error: { code: -32001, message: error.message } }, error.status, headers)
      }
      console.error('mcp: request failed', error instanceof Error ? error.message : error)
      return apiJson({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Something went wrong on our side' } }, 500)
    }
  }),
})

// This server keeps no stream open, so a GET has nothing to offer (the MCP spec allows 405 here).
http.route({
  path: '/mcp',
  method: 'GET',
  handler: httpActionGeneric(async () => apiJson({ error: { code: 'method_not_allowed', message: 'POST JSON-RPC messages to /mcp' } }, 405, { Allow: 'POST' })),
})

// ---- writing phrases (scope: write:phrases). The plan limits apply exactly as they do in the dashboard. ----
http.route({
  path: '/api/v1/keywords',
  method: 'POST',
  handler: httpActionGeneric(async (ctx, req) => apiRoute(ctx, req, 'write:phrases', async owner => {
    const body = await jsonBody(req)
    const platform = text(body, 'platform')
    if (!PLATFORMS.includes(platform as Platform)) throw new ApiError(400, 'invalid_parameter', 'platform must be reddit, x or facebook')
    const community = text(body, 'community', false)
    const key = req.headers.get('Idempotency-Key')
    if (key !== null && !/^[A-Za-z0-9_.:-]{1,64}$/.test(key)) throw new ApiError(400, 'invalid_parameter', 'Idempotency-Key must be 1 to 64 letters, numbers or _ . : -')
    const made = await ctx.runMutation(internal.publicApi.createKeyword, {
      owner, phrase: text(body, 'phrase') as string, platform: platform as Platform,
      ...(community === undefined ? {} : { community }), ...(key === null ? {} : { idempotencyKey: key }), now: Date.now(),
    })
    return new ApiResult({ data: made.keyword }, made.created ? 201 : 200, made.created ? {} : { 'Idempotent-Replayed': 'true' })
  })),
})

http.route({
  pathPrefix: '/api/v1/keywords/',
  method: 'PATCH',
  handler: httpActionGeneric(async (ctx, req) => apiRoute(ctx, req, 'write:phrases', async (owner, url) => {
    const id = idAfter(url, '/api/v1/keywords/')
    const status = text(await jsonBody(req), 'status')
    if (status !== 'listening' && status !== 'paused') throw new ApiError(400, 'invalid_parameter', 'status must be listening or paused')
    return { data: await ctx.runMutation(internal.publicApi.setKeywordStatus, { owner, id, status }) }
  })),
})

http.route({
  pathPrefix: '/api/v1/keywords/',
  method: 'DELETE',
  handler: httpActionGeneric(async (ctx, req) => apiRoute(ctx, req, 'write:phrases', async (owner, url) => ({
    data: await ctx.runMutation(internal.publicApi.deleteKeyword, { owner, id: idAfter(url, '/api/v1/keywords/') }),
  }))),
})

// ---- webhooks (scope: webhooks). A Pro feature: the plan check lives in the shared code, so the dashboard and the API agree. ----

/** The optional platform list in a webhook body. */
function platformList(body: Record<string, unknown>): Platform[] | undefined {
  const value = body.platforms
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !PLATFORMS.includes(item as Platform))) {
    throw new ApiError(400, 'invalid_parameter', 'platforms must be a list of reddit, x and facebook')
  }
  return value as Platform[]
}

function minScoreField(body: Record<string, unknown>): number | undefined {
  const value = body.min_score
  if (value === undefined) return undefined
  if (typeof value !== 'number') throw new ApiError(400, 'invalid_parameter', 'min_score must be a whole number from 0 to 100')
  return value
}

/** /api/v1/webhooks/<id> or /api/v1/webhooks/<id>/<action>. */
function webhookPath(url: URL): { id: string; action: string | null } {
  const parts = url.pathname.slice('/api/v1/webhooks/'.length).split('/')
  if (parts.length > 2 || !/^[A-Za-z0-9_-]{8,64}$/.test(parts[0])) throw new ApiError(404, 'not_found', 'No such address')
  return { id: parts[0], action: parts[1] ?? null }
}

http.route({
  path: '/api/v1/webhooks',
  method: 'GET',
  handler: httpActionGeneric(async (ctx, req) => apiRoute(ctx, req, 'webhooks', async owner => ({ data: await ctx.runQuery(internal.webhooks.listFor, { owner }) }))),
})

http.route({
  path: '/api/v1/webhooks',
  method: 'POST',
  handler: httpActionGeneric(async (ctx, req) => apiRoute(ctx, req, 'webhooks', async owner => {
    const body = await jsonBody(req)
    const minScore = minScoreField(body)
    const platforms = platformList(body)
    const made = await ctx.runMutation(internal.webhooks.createFor, {
      owner, url: text(body, 'url') as string, ...(minScore === undefined ? {} : { minScore }), ...(platforms === undefined ? {} : { platforms }),
    })
    return new ApiResult({ data: { ...made.webhook, secret: made.secret } }, 201)
  })),
})

http.route({
  pathPrefix: '/api/v1/webhooks/',
  method: 'GET',
  handler: httpActionGeneric(async (ctx, req) => apiRoute(ctx, req, 'webhooks', async (owner, url) => {
    const { id, action } = webhookPath(url)
    if (action !== 'deliveries') throw new ApiError(404, 'not_found', 'No such address')
    return { data: await ctx.runQuery(internal.webhooks.deliveriesFor, { owner, id }) }
  })),
})

http.route({
  pathPrefix: '/api/v1/webhooks/',
  method: 'POST',
  handler: httpActionGeneric(async (ctx, req) => apiRoute(ctx, req, 'webhooks', async (owner, url) => {
    const { id, action } = webhookPath(url)
    if (action !== 'test') throw new ApiError(404, 'not_found', 'No such address')
    return { data: await ctx.runAction(internal.webhooks.testFor, { owner, id }) }
  })),
})

http.route({
  pathPrefix: '/api/v1/webhooks/',
  method: 'PATCH',
  handler: httpActionGeneric(async (ctx, req) => apiRoute(ctx, req, 'webhooks', async (owner, url) => {
    const { id, action } = webhookPath(url)
    if (action !== null) throw new ApiError(404, 'not_found', 'No such address')
    const body = await jsonBody(req)
    if (body.active !== undefined && typeof body.active !== 'boolean') throw new ApiError(400, 'invalid_parameter', 'active must be true or false')
    const minScore = minScoreField(body)
    const platforms = platformList(body)
    return {
      data: await ctx.runMutation(internal.webhooks.updateFor, {
        owner, id, ...(body.active === undefined ? {} : { active: body.active as boolean }),
        ...(minScore === undefined ? {} : { minScore }), ...(platforms === undefined ? {} : { platforms }),
      }),
    }
  })),
})

http.route({
  pathPrefix: '/api/v1/webhooks/',
  method: 'DELETE',
  handler: httpActionGeneric(async (ctx, req) => apiRoute(ctx, req, 'webhooks', async (owner, url) => {
    const { id, action } = webhookPath(url)
    if (action !== null) throw new ApiError(404, 'not_found', 'No such address')
    return { data: await ctx.runMutation(internal.webhooks.removeFor, { owner, id }) }
  })),
})

// The website itself. Exact routes above win over this catch-all.
registerStaticRoutes(http, components.staticHosting)

export default http
