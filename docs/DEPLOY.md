# ListeningKit Deployment Guide (Reddit-Only Production)

This guide covers deploying the Reddit-only fork of ListeningKit for production use.

## Prerequisites

- Node.js 20+ and pnpm installed
- A Convex account (convex.dev)
- A Clerk account for authentication (clerk.com)
- (Optional but recommended) OpenAI API key for AI scoring
- (Optional) AgentMail account for email alerts
- (Optional) Reddit app credentials for reliable freshness

## Architecture Overview

```
User Browser → Convex Backend (queries/mutations) → Convex Cron (Reddit reading every 10 min)
                ↓
         Clerk Auth (JWT verification)
                ↓
         OpenAI (match scoring, optional)
                ↓
         AgentMail (email alerts, optional)
```

No bridge server needed. The frontend talks directly to Convex via `useQuery` and mutations.

## Step 1: Clone and Install

```bash
git clone <your-fork-url>
cd listeningkit-hackathon
pnpm install
```

## Step 2: Set Up Clerk Authentication

### Create Clerk Application

1. Go to https://dashboard.clerk.com
2. Create a new application (or use existing)
3. Enable **Google OAuth** provider (Settings → Authentication → Social Connections)
4. Disable username requirement:
   - Go to Settings → Authentication → Email & Phone
   - Uncheck "Require username for sign up"

### Create JWT Template for Convex

1. In Clerk dashboard, go to **JWT Templates**
2. Click **New template** → select **Convex** template
3. Name it exactly: `convex`
4. Leave default settings (Convex handles the claims)
5. Save the template

### Get Clerk Keys

From the Clerk dashboard:
- **Publishable Key**: Find in API Keys section (starts with `pk_test_` or `pk_live_`)
- **Issuer URL**: From the JWT template details (format: `https://xxx.clerk.accounts.dev`)

The Issuer URL is your Clerk frontend API URL with `https://` prepended.

## Step 3: Set Up Convex Backend

### Create Convex Project

```bash
npx convex login
npx convex init
```

This creates a dev deployment. For production, create a second deployment:

```bash
npx convex deploy --cmd 'pnpm exec convex' --prod
```

### Configure Convex Environment Variables

Set these on your Convex deployment (both dev and prod):

#### Required for Auth

```bash
# Get these from Clerk JWT template
npx convex env set AUTH_ISSUER "https://your-clerk-domain.clerk.accounts.dev"
npx convex env set AUTH_AUDIENCE "convex"

# Generate a random 32-byte key for session encryption
npx convex env set SESSION_ENCRYPTION_KEY "$(openssl rand -base64 32)"
```

#### Optional: OpenAI for AI Scoring (Strongly Recommended)

```bash
npx convex env set OPENAI_API_KEY "sk-..."
# Optional: override default model (gpt-4o-mini)
npx convex env set AI_MODEL "gpt-4o-mini"
# Kill switch if needed
# npx convex env set AI_SCORING "off"
```

Without this, matches will have no scores and email alerts will have nothing meaningful to send.

#### Optional: Reddit API for Reliable Freshness

Create a Reddit "script" app at https://www.reddit.com/prefs/apps:
- Type: **script**
- Redirect URI: `http://localhost:8080` (not actually used)

```bash
npx convex env set REDDIT_CLIENT_ID "your-client-id"
npx convex env set REDDIT_CLIENT_SECRET "your-secret"
```

Without these, Reddit reading falls back to public feeds and a mirror (which can be hours stale).

#### Optional: AgentMail for Email Alerts

Sign up at agentmail.com and create an inbox:

```bash
npx convex env set AGENTMAIL_API_KEY "your-api-key"
npx convex env set AGENTMAIL_INBOX_ID "your-inbox-id"
```

#### Optional: Adjust Plan Limits

Default is 1 phrase per platform (Reddit-only here). To raise it:

```bash
# Allow up to 25 Reddit phrases per person
npx convex env set PLAN_PHRASES_PER_PLATFORM "25"

# Webhooks are a Pro feature (default 0). To enable:
# npx convex env set PLAN_WEBHOOKS_PER_PERSON "5"
```

#### Platform Configuration (Already Set by Default)

The Reddit-only configuration is the default. To verify or change:

```bash
# Reddit-only (default, no need to set)
# npx convex env set ENABLED_PLATFORMS "reddit"

# To enable all platforms (reverts to full ListeningKit)
# npx convex env set ENABLED_PLATFORMS "reddit,x,facebook"
```

### Set Prod Environment Variables

Repeat all `convex env set` commands with `--prod` flag:

```bash
npx convex env set --prod AUTH_ISSUER "..."
npx convex env set --prod AUTH_AUDIENCE "convex"
npx convex env set --prod SESSION_ENCRYPTION_KEY "$(openssl rand -base64 32)"
npx convex env set --prod OPENAI_API_KEY "..."
# ... etc for all variables
```

### Deploy Convex Functions

```bash
# Dev deployment
npx convex dev --once --typecheck=disable

# Prod deployment
npx convex deploy --yes
```

## Step 4: Configure Frontend

### Create Environment File

Create `apps/web/.env.local`:

```bash
# Use Convex directly (required)
VITE_API_MODE=live

# Convex deployment URL (from `npx convex dashboard`)
VITE_CONVEX_URL=https://your-deployment.convex.cloud

# Clerk publishable key (from Clerk dashboard)
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...

# Optional: Platform configuration (defaults to reddit)
# VITE_ENABLED_PLATFORMS=reddit
```

For production build, pass these as environment variables instead (see Vercel config below).

## Step 5: Build and Test Locally

```bash
# Run frontend locally (connected to Convex)
pnpm --filter web dev

# Run full stack locally
pnpm dev
```

Test the flow:
1. Sign in with Google
2. Go through onboarding (extension step should be skipped)
3. Select Reddit only in platform selection
4. Add a phrase with a subreddit
5. Wait 10 minutes or manually trigger: `npx convex run watch:tick`
6. Check the feed for matches

## Step 6: Deploy Frontend to Vercel

### vercel.json Configuration

The repo already has a `vercel.json`. Verify it contains:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "installCommand": "pnpm install --frozen-lockfile",
  "buildCommand": "node scripts/build-site.mjs",
  "outputDirectory": "apps/web/dist",
  "rewrites": [{ "source": "/((?!docs/|assets/|logos/).*)", "destination": "/index.html" }]
}
```

### Deploy to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel --prod
```

### Set Vercel Environment Variables

In Vercel dashboard (Settings → Environment Variables), add:

```
VITE_API_MODE=live
VITE_CONVEX_URL=https://your-prod-deployment.convex.cloud
VITE_CLERK_PUBLISHABLE_KEY=pk_live_... (or pk_test_ for testing)
VITE_ENABLED_PLATFORMS=reddit
```

### Redeploy

After setting variables, trigger a redeploy from Vercel dashboard or:

```bash
vercel --prod
```

## Alternative: Deploy Frontend to Convex Static Hosting

Instead of Vercel, you can use Convex's built-in static hosting:

```bash
# Build and upload (production)
pnpm deploy:site

# Build and upload (dev)
pnpm deploy:site:dev
```

The site will be available at `https://your-deployment.convex.site`.

**Note**: Environment variables must be baked into the build. Edit `scripts/build-site.mjs` to pass them:

```javascript
const env = {
  VITE_API_MODE: 'live',
  VITE_CONVEX_URL: 'https://your-prod-deployment.convex.cloud',
  VITE_CLERK_PUBLISHABLE_KEY: 'pk_live_...',
  VITE_ENABLED_PLATFORMS: 'reddit'
}
```

Then run `pnpm deploy:site`.

## Step 7: Verify Deployment

1. **Sign In**: Visit your prod URL, sign in with Google
2. **Onboarding**: Confirm extension step is skipped, only Reddit shown
3. **Add Phrase**: Create a keyword for r/washingtondc with phrase "singles events"
4. **Wait for Cron**: Convex cron runs every 10 minutes (check Convex dashboard → Logs)
5. **Check Feed**: Matches should appear on the feed with scores (if OpenAI key is set)
6. **Test Alerts**: Set up email alerts in Settings, click "Send test email"

## Step 8: Monitor and Maintain

### Convex Dashboard

Monitor at `https://dashboard.convex.dev`:
- **Logs**: Track cron runs, ingestion, errors
- **Tables**: Browse keywords, posts, hits, accounts
- **Functions**: See query/mutation call counts

### Check Cron Status

```bash
# See last 100 log entries
npx convex logs --prod --history 100

# Watch live logs
npx convex logs --prod
```

### Reddit Reading Sources

The cron tries sources in order:
1. **Reddit API** (if `REDDIT_CLIENT_ID` set) — most reliable
2. **Reddit plain feed** (public RSS) — no auth needed, can be stale
3. **Public mirror** — fallback for blocked regions

Each keyword records `lastSource` and `lastCheckedAt`. Check the feed page for "last checked" times.

## Troubleshooting

### Matches Not Appearing

1. Check Convex logs for cron errors: `npx convex logs --prod --history 100`
2. Verify Reddit API credentials (if set)
3. Manually trigger cron: `npx convex run watch:tick --prod`
4. Check keyword status (must be "listening", not "paused")

### No AI Scores

1. Verify `OPENAI_API_KEY` is set: `npx convex env list --prod`
2. Check Convex logs for scoring errors
3. Confirm `AI_SCORING` is not set to "off"

### Email Alerts Not Sending

1. Verify `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID` are set
2. Check alerts are enabled in Settings → Notifications
3. Confirm matches have scores (AI scoring must work first)
4. Check Convex logs for email send errors

### Clerk Sign-In Failing

1. Verify `AUTH_ISSUER` matches your Clerk domain exactly (with `https://`)
2. Confirm `AUTH_AUDIENCE` is `"convex"` (literal string)
3. Check JWT template is named exactly `convex` in Clerk dashboard
4. Verify Clerk publishable key matches environment (dev vs prod)

### Platform Selection Showing X/Facebook

1. Verify `VITE_ENABLED_PLATFORMS=reddit` in frontend env
2. Rebuild frontend after setting the variable
3. Clear browser cache and hard refresh

## Environment Variables Summary

### Convex Backend (Required)

| Variable | Purpose | How to Get |
|----------|---------|------------|
| `AUTH_ISSUER` | Clerk issuer URL | Clerk dashboard → JWT Templates → convex template |
| `AUTH_AUDIENCE` | Clerk audience | Always `"convex"` (literal string) |
| `SESSION_ENCRYPTION_KEY` | Encrypt session tokens | `openssl rand -base64 32` |

### Convex Backend (Optional)

| Variable | Purpose | Default/Notes |
|----------|---------|---------------|
| `OPENAI_API_KEY` | AI match scoring | Without it, scores are null |
| `AI_MODEL` | Override OpenAI model | Default: `gpt-4o-mini` |
| `AI_SCORING` | Kill switch | Set to `"off"` to disable |
| `REDDIT_CLIENT_ID` | Reddit API access | Optional, improves freshness |
| `REDDIT_CLIENT_SECRET` | Reddit API secret | Required if `CLIENT_ID` set |
| `AGENTMAIL_API_KEY` | Email alerts | Optional, from agentmail.com |
| `AGENTMAIL_INBOX_ID` | Email inbox | Required if `API_KEY` set |
| `PLAN_PHRASES_PER_PLATFORM` | Phrase limit per person | Default: `1`, max: `1000` |
| `PLAN_WEBHOOKS_PER_PERSON` | Webhook limit | Default: `0` (Pro feature) |
| `ENABLED_PLATFORMS` | Which platforms to enable | Default: `reddit` |

### Frontend (Vercel or Build Time)

| Variable | Purpose | Example |
|----------|---------|---------|
| `VITE_API_MODE` | Use Convex directly | Always `live` |
| `VITE_CONVEX_URL` | Convex deployment URL | `https://xxx.convex.cloud` |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk public key | `pk_test_...` or `pk_live_...` |
| `VITE_ENABLED_PLATFORMS` | Frontend platform filter | `reddit` (default) |

## Security Checklist

- [ ] `SESSION_ENCRYPTION_KEY` is unique per deployment (never reuse)
- [ ] All secrets are set via `convex env set` (never committed to git)
- [ ] Clerk JWT template is named exactly `convex`
- [ ] Reddit API credentials (if used) are from a "script" type app
- [ ] Production uses `pk_live_` Clerk keys, not `pk_test_`
- [ ] Vercel/build environment variables match Convex prod deployment
- [ ] Never paste secrets in logs, chat, or public docs

## Rotating Secrets

If you need to rotate keys:

1. **SESSION_ENCRYPTION_KEY**: Rotating will invalidate all connected sessions (users must reconnect)
2. **OPENAI_API_KEY**: Safe to rotate anytime
3. **REDDIT credentials**: Safe to rotate anytime
4. **AGENTMAIL keys**: Safe to rotate anytime
5. **Clerk keys**: Rotating publishable key requires frontend redeploy

## Going Back to Full ListeningKit (X + Facebook)

To revert to all platforms:

```bash
# Backend
npx convex env set ENABLED_PLATFORMS "reddit,x,facebook"
npx convex env set --prod ENABLED_PLATFORMS "reddit,x,facebook"

# Frontend (Vercel or .env.local)
VITE_ENABLED_PLATFORMS=reddit,x,facebook

# Redeploy frontend
pnpm deploy:site
# or
vercel --prod
```

Then add X/Facebook helpers per the main README.

## Additional Resources

- Convex docs: https://docs.convex.dev
- Clerk docs: https://clerk.com/docs
- ListeningKit main README: `/workspace/README.md`
- OffApps setup guide: `/workspace/docs/OFFAPPS-SETUP.md`

## Support

For deployment issues, check:
1. Convex logs: `npx convex logs --prod`
2. Vercel build logs: Vercel dashboard → Deployments
3. Browser console: DevTools → Console (check for auth errors)
4. Convex dashboard: https://dashboard.convex.dev (table/function inspection)
