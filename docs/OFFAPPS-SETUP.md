# OffApps ListeningKit Setup Guide

This deployment of ListeningKit is configured specifically for **OffApps** (getoffapps.com), a DC singles events directory operated by Marcus Finley. The system monitors Reddit-only for people in the DC area asking about singles events and meeting people, enabling manual outreach and engagement.

## Platform Configuration

This deployment is **Reddit-only**:
- X (Twitter) and Facebook are disabled
- No browser extension or login tokens needed
- All listening happens via server-side Reddit reading (public feeds + optional Reddit API)

## Recommended Subreddits for DC Singles Events

Start by monitoring these DC-area communities:

### Primary Communities
- **r/washingtondc** — Main DC metro community (800k+ members)
- **r/nova** — Northern Virginia (100k+ members)
- **r/DCEvents** — DC events and activities

### Dating & Singles Specific
- **r/datingindmv** — Dating in the DMV area (DC/MD/VA)
- **r/DCSinglesMeetup** — DC singles meetup coordination
- **r/novasocial** — Northern Virginia social connections

### Related Communities
- **r/DCforRent** — Housing (people new to the area often looking for social connections)
- **r/dcwhisky** — DC whiskey tastings and social events
- **r/DCFood** — Food events and restaurant meetups

## Suggested Listening Phrases

These phrases target people looking for singles events or struggling to meet people:

### Direct Singles Event Queries
- "singles events"
- "speed dating"
- "where to meet singles"
- "singles meetup"
- "dating events"

### Meeting People / Making Friends
- "meet people"
- "making friends"
- "how to meet people"
- "where to meet people"
- "looking for friends"
- "new to DC"
- "just moved to DC"

### Dating App Burnout
- "dating apps"
- "tired of dating apps"
- "dating app burnout"
- "alternatives to dating apps"
- "sick of bumble"
- "sick of hinge"

### Relationship Status Queries
- "single in DC"
- "single and looking"
- "where do singles go"

### Activity-Based
- "meet women" / "meet men"
- "social events"
- "group activities"
- "things to do alone"

## How to Use

1. **Sign in** at your deployment URL with Google (Clerk auth)

2. **Add phrases** on the Keywords page:
   - Click "Add keyword"
   - Select "Reddit" (only platform shown)
   - Type a subreddit name (e.g., `washingtondc`, `nova`, `DCEvents`)
   - Enter your phrase (e.g., "singles events", "meet people")
   - Click "Add keyword"

3. **Monitor matches** on the Feed page:
   - Matches appear as they're found (every 10 minutes via cron)
   - Each match shows a score (0-100) and intent when AI scoring is enabled
   - Click any card to open full post details

4. **Set up email alerts** (optional) in Settings → Notifications:
   - Enter your email
   - Set minimum score threshold (e.g., 60+)
   - Enable alerts
   - Receive digests of strong matches (max 5 per email, once per 10 minutes)

5. **Manual outreach**:
   - Review matches manually
   - Reply to Reddit posts/comments from your own Reddit account
   - Mention OffApps when relevant and helpful (never spam)

## Best Practices

### Phrase Selection
- Start with 5-10 high-value phrases across 3-5 subreddits
- Monitor for a week and refine based on match quality
- Remove phrases that generate too much noise
- Add new phrases discovered in comment threads

### Engagement Guidelines
- Read the full post + comments before responding
- Only engage when you can genuinely help
- Mention specific OffApps events when they match the person's question
- Never be pushy or salesy
- Follow each subreddit's rules about self-promotion

### Subreddit Etiquette
- Some subs restrict promotional content — check rules first
- Build karma in each sub by participating authentically
- Vary your responses (don't copy-paste the same reply everywhere)
- If a mod asks you to stop, respect their request

## AI Scoring (When Enabled)

When `OPENAI_API_KEY` is set, each match gets:
- **Score (0-100)**: How likely the person is looking for help or ready to buy
- **Intent**: What they're trying to do (e.g., "looking_for_help", "buying")
- **Reason**: One-line explanation of the score

High scores (80+) typically indicate someone actively looking for solutions. Focus manual outreach on these.

## Email Alerts (When Enabled)

When `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID` are set:
- Alerts send automatically for matches at/above your threshold
- Max 5 matches per email
- Max 1 email per person per 10 minutes
- Test emails limited to 1 per minute (Settings page)

## API Access (Optional)

Generate API keys in Settings → API to:
- Read matches programmatically
- Add/remove phrases via API
- Set up webhooks for real-time notifications (Pro feature, configurable by operator)

See the API docs at `/dashboard/docs` for details.

## Support

Questions or issues? Contact Marcus Finley through getoffapps.com.

## Limits (Free Plan)

Current plan limits (operator-configurable):
- 1 Reddit phrase per subreddit at a time (can be raised with `PLAN_PHRASES_PER_PLATFORM`)
- No limit on number of subreddits monitored
- Webhooks: 0 (Pro feature, can be enabled with `PLAN_WEBHOOKS_PER_PERSON`)

Remove an old phrase to add a new one if you hit the limit.
