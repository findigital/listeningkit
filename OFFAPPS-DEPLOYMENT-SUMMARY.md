# OffApps ListeningKit Deployment - Quick Reference

## PR Created
**Pull Request:** https://github.com/findigital/listeningkit/pull/1
**Status:** Draft PR (ready for review, do not merge yet until tested)

---

## What This Fork Does

This is a **Reddit-only** fork of ListeningKit specifically for OffApps to:
1. Monitor DC-area subreddits for people asking about singles events
2. Filter out X (Twitter) and Facebook completely (disabled server-side)
3. Skip the browser extension step (Reddit needs no login tokens)
4. Enable manual outreach based on AI-scored matches

---

## Required Environment Variables

### Convex Backend (Required)

```bash
# 1. Clerk Auth (get from Clerk dashboard → JWT Templates)
npx convex env set AUTH_ISSUER "https://your-clerk-domain.clerk.accounts.dev"
npx convex env set AUTH_AUDIENCE "convex"

# 2. Session Encryption (generate new)
npx convex env set SESSION_ENCRYPTION_KEY "$(openssl rand -base64 32)"

# 3. OpenAI for AI Scoring (STRONGLY RECOMMENDED - without this, no scores)
npx convex env set OPENAI_API_KEY "sk-..."
```

### Convex Backend (Optional but Recommended)

```bash
# Reddit API for reliable freshness (optional - falls back to public feeds)
# Create at https://www.reddit.com/prefs/apps (type: script)
npx convex env set REDDIT_CLIENT_ID "your-reddit-app-id"
npx convex env set REDDIT_CLIENT_SECRET "your-reddit-app-secret"

# AgentMail for email alerts (optional - from agentmail.com)
npx convex env set AGENTMAIL_API_KEY "your-agentmail-key"
npx convex env set AGENTMAIL_INBOX_ID "your-inbox-id"

# Raise phrase limit from 1 to 25 per person (optional)
npx convex env set PLAN_PHRASES_PER_PLATFORM "25"
```

### Frontend (Vercel or .env.local)

```bash
VITE_API_MODE=live
VITE_CONVEX_URL=https://your-convex-deployment.convex.cloud
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...  # or pk_test_ for testing
```

---

## Clerk Setup Steps

1. **Create Clerk Application** at https://dashboard.clerk.com
2. **Enable Google OAuth**: Settings → Authentication → Social Connections
3. **Disable username requirement**: 
   - Settings → Authentication → Email & Phone
   - Uncheck "Require username for sign up"
4. **Create JWT Template**:
   - Go to JWT Templates
   - Click "New template" → select "Convex" template
   - Name it exactly: `convex`
   - Save
5. **Get values**:
   - Publishable Key: API Keys section (starts with `pk_test_` or `pk_live_`)
   - Issuer URL: From JWT template details (format: `https://xxx.clerk.accounts.dev`)

---

## Deployment Steps (Production)

### 1. Deploy Convex Backend

```bash
# Install dependencies
pnpm install

# Login to Convex
npx convex login

# Create production deployment
npx convex deploy --cmd 'pnpm exec convex' --prod

# Set all environment variables (see above)
npx convex env set --prod AUTH_ISSUER "..."
npx convex env set --prod AUTH_AUDIENCE "convex"
npx convex env set --prod SESSION_ENCRYPTION_KEY "$(openssl rand -base64 32)"
npx convex env set --prod OPENAI_API_KEY "sk-..."
# ... etc for all variables

# Deploy functions
npx convex deploy --yes
```

### 2. Deploy Frontend to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel --prod

# Set environment variables in Vercel dashboard:
# - VITE_API_MODE=live
# - VITE_CONVEX_URL=https://your-prod-deployment.convex.cloud
# - VITE_CLERK_PUBLISHABLE_KEY=pk_live_...

# Redeploy after setting variables
vercel --prod
```

### 3. Verify Deployment

1. Visit your production URL
2. Sign in with Google
3. Go through onboarding (extension step should be skipped)
4. Only Reddit should be shown in platform selection
5. Add keyword: subreddit `washingtondc`, phrase `singles events`
6. Wait 10 minutes or manually trigger: `npx convex run watch:tick --prod`
7. Check feed for matches with AI scores

---

## Recommended DC Subreddits

### Primary
- r/washingtondc (800k+ members)
- r/nova (100k+ members)  
- r/DCEvents

### Dating/Singles Specific
- r/datingindmv
- r/DCSinglesMeetup
- r/novasocial

### Related
- r/DCforRent (people new to area)
- r/dcwhisky (social events)
- r/DCFood (restaurant meetups)

---

## Recommended Listening Phrases

### Direct Singles Queries
- "singles events"
- "speed dating"
- "where to meet singles"
- "singles meetup"
- "dating events"

### Meeting People
- "meet people"
- "making friends"
- "how to meet people"
- "new to DC"
- "just moved to DC"

### Dating App Burnout
- "dating apps"
- "tired of dating apps"
- "dating app burnout"
- "sick of bumble"
- "sick of hinge"

### Others
- "single in DC"
- "social events"
- "group activities"

See `docs/OFFAPPS-SETUP.md` for complete list.

---

## What's Blocked (By Design)

These are intentionally disabled for the Reddit-only fork:

❌ X (Twitter) reading  
❌ Facebook reading  
❌ Browser extension installation  
❌ Token pasting step  
❌ X/Facebook account creation  
❌ X/Facebook keyword creation  
❌ X/Facebook helpers  

Attempting to create X or Facebook keywords will return:  
`"X is not enabled on this deployment"` or  
`"Facebook is not enabled on this deployment"`

---

## AI Scoring

**Status:** Built and tested, but NEVER run live (no `OPENAI_API_KEY` set yet)

When `OPENAI_API_KEY` is set, each match gets:
- **Score (0-100)**: How likely person is looking for help
- **Intent**: What they're trying to do
- **Reason**: One-line explanation

High scores (80+) = people actively looking for solutions. Focus manual outreach here.

**Cost:** Uses `gpt-4o-mini` by default (cheap: ~$0.15 per 1M input tokens)

---

## Email Alerts

**Requires:** `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID`

When enabled:
- Sends automatically for matches at/above your threshold
- Max 5 matches per email
- Max 1 email per person per 10 minutes
- Test emails limited to 1 per minute

Configure in Settings → Notifications.

---

## Troubleshooting

### "No matches appearing"
1. Check Convex logs: `npx convex logs --prod --history 100`
2. Verify Reddit API credentials (if set)
3. Manually trigger: `npx convex run watch:tick --prod`
4. Check keyword status is "listening", not "paused"

### "No AI scores"
1. Verify `OPENAI_API_KEY` is set: `npx convex env list --prod`
2. Check Convex logs for scoring errors
3. Confirm `AI_SCORING` is not set to "off"

### "Clerk sign-in failing"
1. Verify `AUTH_ISSUER` matches Clerk domain exactly (with `https://`)
2. Confirm `AUTH_AUDIENCE` is `"convex"` (literal string)
3. Check JWT template named exactly `convex` in Clerk
4. Verify publishable key matches environment (dev vs prod)

### "Extension step still showing"
1. Verify `VITE_ENABLED_PLATFORMS=reddit` in frontend env
2. Rebuild frontend after setting variable
3. Clear browser cache and hard refresh

---

## Complete Documentation

- **Deployment Guide:** `/workspace/docs/DEPLOY.md`
- **OffApps Setup:** `/workspace/docs/OFFAPPS-SETUP.md`
- **Main README:** `/workspace/README.md`
- **PR Link:** https://github.com/findigital/listeningkit/pull/1

---

## Security Notes

🔒 **Never commit secrets to git**  
🔒 Generate unique `SESSION_ENCRYPTION_KEY` per deployment  
🔒 Use `pk_live_` Clerk keys in production, not `pk_test_`  
🔒 Rotate Firecrawl/AgentMail keys after testing (if used)  
🔒 Reddit API credentials should be "script" type, not "web app"  

---

## Next Steps

1. ✅ PR created and ready for review
2. ⏳ Follow deployment steps above
3. ⏳ Test production deployment
4. ⏳ Set up DC subreddits and phrases per `docs/OFFAPPS-SETUP.md`
5. ⏳ Monitor matches and refine phrases based on quality

**Do not merge PR until production testing is complete.**

---

## Contact

Questions about deployment? Check the troubleshooting sections in:
- `docs/DEPLOY.md`
- `docs/OFFAPPS-SETUP.md`

Or contact Marcus Finley via getoffapps.com.
