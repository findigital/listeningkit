import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { Button, Select, useToast } from '@listeningkit/ui'
import {
  createKeyword,
  getKeywords,
  saveKeyword,
  type Keyword
} from '../lib/keywords'
import { getAccounts, platformLabel, type ConnectionPlatform, type ConnectionRecord } from '../lib/connections'
import {
  getCommunities,
  joinCommunityByUrl,
  parseFacebookGroupUrl,
  resolveCommunityByUrl,
  resolveRedditCommunity,
  type Community
} from '../lib/communities'
import { getEnabledPlatforms } from '../lib/platformConfig'
import { SOCIAL_ICONS, SocialBadge, SocialGlyph, type SocialIcon } from '../lib/social-icons'
import { DashboardFormSheet } from './DashboardFormSheet'
import { EmptyLine, FormInput, LoadingLine, PickRow, PlatformPick } from './DashboardFormPrimitives'

function iconFor(platform: ConnectionPlatform): SocialIcon {
  return SOCIAL_ICONS.find((icon) => icon.id === platform) ?? SOCIAL_ICONS[0]
}

/**
 * Add a keyword. The step shape follows the platform relation:
 *  - x: platform → phrase (2 steps) — X is word-based; the words are
 *    combined into one phrase, there is no group to scope under.
 *  - reddit: platform → group → phrase (3 steps) — the group step is a
 *    dropdown of the joined subreddits plus a type-to-validate input
 *    (unknown names register and join on the spot), mirroring the groups
 *    form's reddit pick.
 *  - facebook: platform → account → group → phrase (4 steps) — the group
 *    step is a dropdown of the joined groups plus a paste-a-link validator
 *    (same dropdown pattern as reddit). An already-joined link scopes
 *    straight away; a new link resolves through
 *    `POST /communities/resolve` and its entry questions render inline —
 *    Continue joins (answers ride along) before scoping, using the account
 *    from the previous step.
 * Fetches on a step confirm drive the sheet's busy state until the data is
 * ready, so a step never unlocks half-loaded.
 *
 * Edit mode (`initialKeyword`): skips straight to the phrase step with the
 * scope fixed and the phrase pre-filled — Back is hidden and confirm saves
 * the record instead of creating one.
 */
export function DashboardKeywordsForm({
  open,
  onClose,
  onCreated,
  initialKeyword = null
}: {
  open: boolean
  onClose: () => void
  /** Fires after a successful create so the parent page can reconcile. */
  onCreated: () => void
  /** Edit this keyword instead of creating one: jumps to the phrase step. */
  initialKeyword?: Keyword | null
}) {
  const { success, error: notifyError } = useToast()
  const editing = initialKeyword ?? null
  const enabledPlatforms = getEnabledPlatforms()
  const [platform, setPlatform] = useState<ConnectionPlatform | null>(null)
  // Selecting a platform tile only marks the card — the sheet's Continue
  // button flips this and unlocks the next step, so step one never
  // auto-advances.
  const [platformConfirmed, setPlatformConfirmed] = useState(false)
  // Same gate for the group step: picking a group only marks the row;
  // Continue unlocks the phrase step.
  const [groupConfirmed, setGroupConfirmed] = useState(false)
  const [joinedGroups, setJoinedGroups] = useState<Community[] | null>(null)
  const [groupId, setGroupId] = useState<string | null>(null)
  const [existing, setExisting] = useState<Keyword[] | null>(null)
  const [phrase, setPhrase] = useState('')
  // Staged batch (create mode only): phrases queued with the dashed
  // "Add another keyword" button, all created together on the final
  // confirm so one pass through the form can add several keywords.
  const [staged, setStaged] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  // Facebook create flow (mirrors the groups form): account → group dropdown
  // with a paste-a-link validator. Each pick only marks; the sheet's
  // Continue flips the matching *Confirmed flag and fires the fetch that
  // unlocks the next step.
  const [accounts, setAccounts] = useState<ConnectionRecord[] | null>(null)
  const [accountId, setAccountId] = useState<string | null>(null)
  const [accountConfirmed, setAccountConfirmed] = useState(false)
  // Pasted group link (validator only) plus the resolved group and the typed
  // entry answers — answers reset only when the resolved group identity
  // changes, so validating again never wipes in-progress answers for the
  // same group.
  const [groupUrl, setGroupUrl] = useState('')
  const [resolvedGroup, setResolvedGroup] = useState<Community | null>(null)
  const [resolving, setResolving] = useState(false)
  const [groupAnswers, setGroupAnswers] = useState<string[]>([])
  const lastResolvedId = useRef<string | null>(null)
  // Reddit scope editor (edit mode only): typed subreddit + checking flag.
  // Validation feedback goes through toasts, not inline text.
  const [scopeName, setScopeName] = useState('')
  const [scopeChecking, setScopeChecking] = useState(false)

  useEffect(() => {
    if (!open) return
    // Edit mode pre-scopes everything and jumps to the phrase step; create
    // mode starts blank on the platform pick.
    setPlatform(editing?.platform ?? null)
    setPlatformConfirmed(editing !== null)
    setJoinedGroups(null)
    setGroupId(editing?.groupId ?? null)
    setGroupConfirmed(editing !== null && (editing.platform === 'x' || editing.groupId !== null))
    setExisting(null)
    setPhrase(editing?.phrase ?? '')
    setStaged([])
    setBusy(false)
    setAccounts(null)
    setAccountId(null)
    setAccountConfirmed(false)
    setGroupUrl('')
    setResolvedGroup(null)
    setResolving(false)
    setGroupAnswers([])
    lastResolvedId.current = null
    setScopeName('')
    setScopeChecking(false)
    // The phrase step's group chip + existing list need the roster even in
    // edit mode — fetch it up front like a pre-scoped open.
    if (editing && editing.platform !== 'x') loadRoster(editing.platform)
  }, [open, initialKeyword])

  const fbCreate = editing === null && platform === 'facebook'
  const stepCount = platform === null ? 0 : platform === 'x' ? 2 : fbCreate ? 4 : 3
  const step = !platformConfirmed
    ? 1
    : platform === 'x'
      ? 2
      : fbCreate
        ? (!accountConfirmed ? 2 : !groupConfirmed ? 3 : 4)
        : (!groupConfirmed ? 2 : 3)
  const pickingGroup =
    platform !== null &&
    platform !== 'x' &&
    platformConfirmed &&
    !groupConfirmed &&
    (!fbCreate || accountConfirmed)
  const onAccountStep = fbCreate && platformConfirmed && !accountConfirmed
  const composing = platform !== null && platformConfirmed && (platform === 'x' ? step === 2 : groupConfirmed)
  const selectedGroup = (joinedGroups ?? []).find((group) => group.id === groupId) ?? null
  const fbAccounts = (accounts ?? []).filter(
    (account) => account.platform === 'facebook' && account.connectedAt !== null
  )

  // Answers render only for the validated group; Join needs every one
  // answered.
  const answersValid =
    resolvedGroup !== null &&
    groupAnswers.length === resolvedGroup.entryQuestions.length &&
    groupAnswers.every((answer) => answer.trim() !== '')
  // The group Continue unlocks when a joined group is picked (dropdown or a
  // validated-accepted link) or when a validated new group has its entry
  // answers filled and a joining account chosen.
  const fbGroupReady =
    groupId !== null ||
    (resolvedGroup !== null &&
      resolvedGroup.joinState !== 'accepted' &&
      accountId !== null &&
      answersValid)

  // The keyword scope (platform + group) is fixed by the time we compose —
  // pull the phrases already listening there so the user can see them. In
  // edit mode the keyword itself is filtered out of that list.
  const editingId = editing?.id ?? null
  useEffect(() => {
    if (!open || !composing || !platform) {
      setExisting(null)
      return
    }
    let cancelled = false
    getKeywords({ platform, groupId: platform === 'x' ? null : groupId })
      .then((list) => {
        if (!cancelled) setExisting(editingId ? list.filter((keyword) => keyword.id !== editingId) : list)
      })
      .catch(() => {
        if (!cancelled) setExisting([])
      })
    return () => {
      cancelled = true
    }
  }, [open, composing, platform, groupId, editingId])

  const stepHint =
    step === 1
      ? 'Pick the platform, then press Continue.'
      : onAccountStep
        ? 'Choose the account, then press Continue.'
        : pickingGroup
          ? fbCreate
            ? 'Pick the group or paste a link, then press Continue.'
            : 'Pick the group, then press Continue.'
          : platform === 'x'
            ? 'Combine the words you want to see together — all of them must appear.'
            : `Phrase to watch in ${selectedGroup?.name ?? 'the group'}.`

  function back() {
    if (editing !== null) return
    if (composing && platform === 'facebook') {
      // Phrase → group step: un-confirm, keep the pick and the answers so
      // Continue re-confirms without re-validating or re-joining.
      setGroupConfirmed(false)
      setStaged([])
      return
    }
    if (composing && platform === 'reddit') {
      // Phrase → group step.
      setPhrase('')
      setExisting(null)
      setGroupId(null)
      setGroupConfirmed(false)
      setStaged([])
      return
    }
    if (pickingGroup && fbCreate) {
      // Group → account step: keep the roster, drop the pick.
      setAccountConfirmed(false)
      setAccountId(null)
      setGroupId(null)
      setGroupUrl('')
      setResolvedGroup(null)
      setResolving(false)
      setGroupAnswers([])
      lastResolvedId.current = null
      return
    }
    // Everything else collapses to the platform pick.
    setPlatform(null)
    setPlatformConfirmed(false)
    setAccountConfirmed(false)
    setAccountId(null)
    setAccounts(null)
    setGroupUrl('')
    setResolvedGroup(null)
    setResolving(false)
    setGroupAnswers([])
    lastResolvedId.current = null
    setGroupConfirmed(false)
    setJoinedGroups(null)
    setGroupId(null)
    setExisting(null)
    setPhrase('')
    setStaged([])
  }

  // Fetching the accepted roster happens on Continue: confirming the
  // platform tile flips the step immediately, so the group step shows its
  // loading line the whole time the fetch is in flight. Pending requests
  // aren't scopes yet — we're not listening there until the group accepts.
  function loadRoster(platformToLoad: ConnectionPlatform) {
    setBusy(true)
    getCommunities({ platform: platformToLoad })
      .then((list) => setJoinedGroups(list.filter((community) => community.joinState === 'accepted')))
      .catch((err: unknown) =>
        notifyError('Could not load groups', err instanceof Error ? err.message : 'Something went wrong.')
      )
      .finally(() => setBusy(false))
  }

  // Fetching the connected facebook accounts happens on the platform
  // Continue — never on select, since card picks only mark. The fetch
  // drives the busy state until it resolves, so the account step shows its
  // loading line the whole time data is in flight.
  async function loadFbAccounts() {
    setBusy(true)
    try {
      setAccounts(await getAccounts())
    } catch (err: unknown) {
      notifyError('Could not load accounts', err instanceof Error ? err.message : 'Something went wrong.')
      setAccounts([])
    } finally {
      setBusy(false)
    }
  }

  // Step one's Continue: confirm the platform pick and unlock the next
  // step. Reddit lands on the group step immediately, so fetch the roster
  // here — it drives the busy state until it resolves. Facebook lands on
  // the account step, so fetch the accounts and the accepted roster here.
  function continueFromPlatform() {
    if (platform === null || platformConfirmed || busy) return
    setPlatformConfirmed(true)
    if (platform === 'reddit') loadRoster(platform)
    if (platform === 'facebook') {
      loadRoster(platform)
      void loadFbAccounts()
    }
  }

  // Account step's Continue: confirm the account pick and unlock the group
  // step. Selecting an account only marks the card.
  function continueFromAccount() {
    if (accountId === null || accountConfirmed || busy) return
    setAccountConfirmed(true)
  }

  // Group step's Continue: confirm the group pick and unlock the phrase
  // step. Selecting from the dropdown only marks it — the existing-keywords
  // fetch for the phrase step fires off `composing`, which only flips here.
  // A validated new facebook group joins by URL (answers ride along) before
  // scoping; the fetch drives the busy state until the scoped group is
  // ready. Re-confirming an established scope (Back then Continue) flips
  // the flag with no second request.
  async function continueFromGroup() {
    if (groupConfirmed || busy || resolving) return
    if (platform === 'facebook' && editing === null && groupId === null) {
      if (
        resolvedGroup === null ||
        resolvedGroup.joinState === 'accepted' ||
        accountId === null ||
        !answersValid ||
        resolvedGroup.url === null
      ) {
        return
      }
      setBusy(true)
      try {
        const res = await joinCommunityByUrl(resolvedGroup.url, {
          accountId,
          answers: groupAnswers.map((answer) => answer.trim())
        })
        markScope(res.community)
        setGroupConfirmed(true)
        const joined = res.community
        if (joined.joinState === 'accepted') {
          success(`You're already in ${joined.name}`)
        } else {
          success(
            `Request sent to ${joined.name}`,
            'The keyword scopes here — signals arrive once the group accepts.'
          )
        }
      } catch (err: unknown) {
        notifyError('Could not send the request', err instanceof Error ? err.message : 'Something went wrong.')
      } finally {
        setBusy(false)
      }
      return
    }
    if (groupId === null) return
    setGroupConfirmed(true)
  }

  // Marking a scope only merges the roster + id — the sheet's Continue
  // unlocks the phrase step, and the keyword itself is created on the final
  // confirm.
  function markScope(community: Community) {
    setJoinedGroups((current) => {
      const list = current ?? []
      return list.some((row) => row.id === community.id)
        ? list.map((row) => (row.id === community.id ? community : row))
        : [...list, community]
    })
    setGroupId(community.id)
  }

  // Facebook link validator: resolve a pasted group URL through the route.
  // An already-joined group marks the scope straight away; a new group
  // stashes its entry questions inline for the group Continue to join
  // with. Validation feedback goes through toasts, not inline text.
  async function validateGroupUrl() {
    const raw = groupUrl.trim()
    if (!raw || resolving) return
    const parsed = parseFacebookGroupUrl(raw)
    if (!parsed) {
      notifyError('That doesn’t look like a group link', 'Paste a facebook.com/groups/… URL.')
      return
    }
    setResolving(true)
    try {
      const community = await resolveCommunityByUrl(parsed.url)
      if (community.joinState === 'accepted') {
        markScope(community)
        setGroupUrl('')
        setResolvedGroup(null)
        success(`Scoped to ${community.name}`, 'Validated — press Continue to scope it.')
      } else {
        setResolvedGroup(community)
        if (lastResolvedId.current !== community.id) {
          lastResolvedId.current = community.id
          setGroupAnswers(community.entryQuestions.map(() => ''))
        }
        success(
          `Found ${community.name}`,
          community.entryQuestions.length > 0
            ? 'Answer the entry questions below, then press Continue.'
            : 'Press Continue to send the join request and scope it.'
        )
      }
    } catch (err: unknown) {
      notifyError('Could not resolve the group', err instanceof Error ? err.message : 'Check the link and try again.')
    } finally {
      setResolving(false)
    }
  }

  // Reddit scope check: resolve a typed subreddit through the route —
  // unknown names register and join on the spot (subreddits don't gate),
  // so the returned community drops straight into the roster as scope.
  // A toast reports the outcome either way.
  async function checkScope() {
    const name = scopeName.trim()
    if (!name || scopeChecking) return
    setScopeChecking(true)
    try {
      const community = await resolveRedditCommunity(name)
      setJoinedGroups((current) => {
        const list = current ?? []
        return list.some((row) => row.id === community.id)
          ? list.map((row) => (row.id === community.id ? community : row))
          : [...list, community]
      })
      setGroupId(community.id)
      setScopeName('')
      success(
        `Scoped to ${community.name}`,
        editing !== null ? 'Validated — press Save changes to apply it.' : 'Validated — press Continue to scope it.'
      )
    } catch (err: unknown) {
      notifyError('Subreddit not found', err instanceof Error ? err.message : 'Could not find that subreddit.')
    } finally {
      setScopeChecking(false)
    }
  }

  // Stage the current input into the batch and clear it for the next
  // phrase — the sheet stays open so keywords accumulate. Staging only
  // queues; everything is created on the final confirm.
  function stagePhrase() {
    const trimmed = phrase.trim()
    if (!trimmed || busy || staged.includes(trimmed)) return
    setStaged((current) => [...current, trimmed])
    setPhrase('')
  }

  function removeStaged(item: string) {
    setStaged((current) => current.filter((row) => row !== item))
  }

  async function confirm() {
    // Confirm runs the final action: save the edit, or create the keyword.
    // Create mode creates the whole staged batch plus any un-staged input,
    // so one pass through the form can add several keywords.
    if (!composing || !platform || busy) return
    const trimmed = phrase.trim()
    if (editing) {
      if (!trimmed) return
      setBusy(true)
      try {
        await saveKeyword({ ...editing, phrase: trimmed, groupId: platform === 'x' ? null : groupId })
        success(`“${trimmed}” updated`, `${platformLabel(platform)} listening set updated.`)
        onCreated()
        onClose()
      } catch (err: unknown) {
        notifyError('Could not save the keyword', err instanceof Error ? err.message : 'Something went wrong.')
      } finally {
        setBusy(false)
      }
      return
    }
    const batch = [...staged, ...(trimmed ? [trimmed] : [])]
    if (batch.length === 0) return
    setBusy(true)
    try {
      for (const item of batch) {
        await createKeyword({ phrase: item, platform, groupId: platform === 'x' ? null : groupId })
      }
      success(
        batch.length === 1 ? `“${batch[0]}” added` : `${batch.length} keywords added`,
        `${platformLabel(platform)} listening set updated.`
      )
      setStaged([])
      onCreated()
      onClose()
    } catch (err: unknown) {
      notifyError('Could not add the keyword', err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <DashboardFormSheet
      open={open}
      title={editing ? 'Edit keyword' : 'Add a keyword'}
      subtitle="Phrases we listen for — grouped by where you're listening."
      step={step}
      stepCount={stepCount}
      stepHint={stepHint}
      busy={busy}
      confirmLabel={
        step === 1 || pickingGroup || onAccountStep
          ? 'Continue'
          : composing
            ? editing
              ? 'Save changes'
              : staged.length + (phrase.trim() ? 1 : 0) > 1
                ? `Add ${staged.length + (phrase.trim() ? 1 : 0)} keywords`
                : 'Add keyword'
            : undefined
      }
      confirmDisabled={
        step === 1
          ? platform === null
          : pickingGroup
            ? fbCreate
              ? !fbGroupReady
              : groupId === null
            : onAccountStep
              ? accountId === null
              : phrase.trim() === '' && staged.length === 0
      }
      onConfirm={
        step === 1
          ? continueFromPlatform
          : pickingGroup
            ? continueFromGroup
            : onAccountStep
              ? continueFromAccount
              : confirm
      }
      onBack={back}
      backDisabled={step === 1 || editing !== null}
      onClose={onClose}
    >
      {step === 1 ? (
        <PlatformPick
          value={platform}
          platforms={enabledPlatforms as ConnectionPlatform[]}
          onChange={(next) => {
            setPlatform(next)
            setJoinedGroups(null)
            setGroupId(null)
            setExisting(null)
            setStaged([])
            setAccounts(null)
            setAccountId(null)
            setAccountConfirmed(false)
            setGroupUrl('')
            setResolvedGroup(null)
            setResolving(false)
            setGroupAnswers([])
            lastResolvedId.current = null
          }}
        />
      ) : null}

      {pickingGroup && platform === 'reddit' ? (
        joinedGroups === null ? (
          <LoadingLine label="Loading reddit groups…" />
        ) : (
          <RedditScopeEditor
            groups={joinedGroups}
            value={groupId}
            onSelect={setGroupId}
            scopeName={scopeName}
            onScopeNameChange={setScopeName}
            onCheck={checkScope}
            checking={scopeChecking}
          />
        )
      ) : null}

      {pickingGroup && fbCreate ? (
        joinedGroups === null || accounts === null ? (
          <LoadingLine label="Loading Facebook groups…" />
        ) : (
          <div className="flex flex-col gap-4">
            <FacebookScopeEditor
              groups={joinedGroups}
              value={groupId}
              onSelect={(id) => {
                setGroupId(id)
                setResolvedGroup(null)
              }}
              groupUrl={groupUrl}
              onGroupUrlChange={setGroupUrl}
              onValidate={validateGroupUrl}
              validating={resolving}
            />
            {resolvedGroup !== null && resolvedGroup.joinState !== 'accepted' ? (
              <FacebookScopeQuestions
                groupName={resolvedGroup.name}
                questions={resolvedGroup.entryQuestions}
                answers={groupAnswers}
                onAnswerChange={(index, value) =>
                  setGroupAnswers((current) => current.map((answer, i) => (i === index ? value : answer)))
                }
              />
            ) : null}
          </div>
        )
      ) : null}

      {pickingGroup && editing !== null && platform === 'facebook' ? (
        joinedGroups === null ? (
          <LoadingLine label="Loading Facebook groups…" />
        ) : joinedGroups.length === 0 ? (
          <EmptyLine
            label="You aren't joined to any Facebook group yet — add one from the Groups page first."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {joinedGroups.map((group) => (
              <PickRow
                key={group.id}
                active={groupId === group.id}
                onClick={() => setGroupId(group.id)}
                label={group.name}
                sub={`${group.handle} · ${group.members}${group.accountLabel ? ` · joined as ${group.accountLabel}` : ''}`}
                icon={<SocialBadge icon={iconFor(group.platform)} />}
              />
            ))}
          </div>
        )
      ) : null}

      {onAccountStep ? (
        accounts === null ? (
          <LoadingLine label="Loading Facebook accounts…" />
        ) : fbAccounts.length === 0 ? (
          <EmptyLine label="No connected Facebook accounts yet — connect one in Settings first." />
        ) : (
          <div className="flex flex-col gap-2">
            {fbAccounts.map((account) => (
              <PickRow
                key={account.id}
                active={accountId === account.id}
                onClick={() => setAccountId(account.id)}
                label={account.label}
                tone="solid"
                icon={<SocialGlyph icon={iconFor('facebook')} className="size-8 shrink-0" />}
              />
            ))}
          </div>
        )
      ) : null}

      {composing && platform ? (
        <PhraseStep
          platform={platform}
          group={selectedGroup}
          phrase={phrase}
          existing={existing}
          onPhraseChange={setPhrase}
          onConfirm={confirm}
          staged={editing === null ? staged : undefined}
          onStage={editing === null ? stagePhrase : undefined}
          onRemoveStaged={editing === null ? removeStaged : undefined}
          scopeEditor={
            editing !== null && platform === 'reddit' ? (
              <RedditScopeEditor
                groups={joinedGroups ?? []}
                value={groupId}
                onSelect={setGroupId}
                scopeName={scopeName}
                onScopeNameChange={setScopeName}
                onCheck={checkScope}
                checking={scopeChecking}
              />
            ) : undefined
          }
        />
      ) : null}
    </DashboardFormSheet>
  )
}

/**
 * The facebook group step's dropdown: the joined groups plus a paste-a-link
 * validator in the footer — the same dropdown pattern as the reddit scope
 * editor. Picking marks the scope; validating an already-joined link marks
 * it too, while a new link stashes its entry questions for the group
 * Continue to join with. The sheet's Continue still confirms.
 */
function FacebookScopeEditor({
  groups,
  value,
  onSelect,
  groupUrl,
  onGroupUrlChange,
  onValidate,
  validating
}: {
  groups: Community[]
  value: string | null
  onSelect: (id: string) => void
  groupUrl: string
  onGroupUrlChange: (value: string) => void
  onValidate: () => void
  validating: boolean
}) {
  return (
    <div className="flex flex-col gap-3">
      <label className="block">
        <span className="mb-1.5 block text-sm font-semibold text-slate-700">Facebook group</span>
        <Select
          size="lg"
          value={value ?? undefined}
          onChange={onSelect}
          aria-label="Facebook group"
          placeholder="Pick a group…"
          icon={<SocialGlyph icon={iconFor('facebook')} className="size-4" />}
          options={groups.map((community) => ({
            value: community.id,
            label: `${community.name} · ${community.members}`,
            icon: <SocialBadge icon={iconFor(community.platform)} variant="blue" />
          }))}
          menuFooter={
            <div className="flex items-end gap-2">
              <label className="block min-w-0 flex-1">
                <span className="mb-1.5 block text-sm font-semibold text-slate-700">Or paste a link</span>
                <FormInput
                  type="text"
                  value={groupUrl}
                  onChange={(event) => onGroupUrlChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onValidate()
                  }}
                  placeholder="facebook.com/groups/…"
                  autoComplete="off"
                  inputMode="url"
                  className="h-9"
                  radius={8}
                />
              </label>
              <Button
                type="button"
                variant="gray"
                size="lg"
                disabled={groupUrl.trim() === '' || validating}
                onClick={onValidate}
                className="shrink-0"
              >
                {validating ? 'Checking…' : 'Validate'}
              </Button>
            </div>
          }
        />
      </label>
    </div>
  )
}

/**
 * The facebook entry questions: one input per question exactly as the
 * client returned them — the same questions step as the groups form, so a
 * gated group joins with answers attached before the keyword scopes to it.
 * Only renders for a validated new link; already-joined groups never reach
 * these inputs.
 */
function FacebookScopeQuestions({
  groupName,
  questions,
  answers,
  onAnswerChange
}: {
  groupName: string
  questions: string[]
  answers: string[]
  onAnswerChange: (index: number, value: string) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <p className="text-sm font-bold text-text-primary">
          Answer {questions.length} entry question{questions.length === 1 ? '' : 's'} for {groupName}
        </p>
        {questions.map((question, index) => (
          <label key={`${groupName}-${index}`} className="block">
            <span className="mb-1.5 block text-sm font-semibold text-slate-700">{question}</span>
            <FormInput
              type="text"
              value={answers[index] ?? ''}
              onChange={(event) => onAnswerChange(index, event.target.value)}
              placeholder="Type your answer"
              autoComplete="off"
            />
          </label>
        ))}
      </div>
    </div>
  )
}
/**
 * Reddit scope editor: a dropdown of the accepted subreddits plus a
 * type-to-validate input, used by the create-mode group step and the edit
 * phrase step. Typing a name resolves it through
 * `POST /communities/resolve-reddit` — tracked rows return as-is,
 * unknown-but-valid names register and join on the spot. Picking or
 * resolving only marks the scope; the sheet's Continue still confirms.
 */
function RedditScopeEditor({
  groups,
  value,
  onSelect,
  scopeName,
  onScopeNameChange,
  onCheck,
  checking
}: {
  groups: Community[]
  value: string | null
  onSelect: (id: string) => void
  scopeName: string
  onScopeNameChange: (value: string) => void
  onCheck: () => void
  checking: boolean
}) {
  return (
    <div className="flex flex-col gap-3">
      <label className="block">
        <span className="mb-1.5 block text-sm font-semibold text-slate-700">Subreddit scope</span>
        <Select
          size="lg"
          value={value ?? undefined}
          onChange={onSelect}
          aria-label="Subreddit scope"
          placeholder="Pick a subreddit…"
          icon={<SocialGlyph icon={iconFor('reddit')} className="size-4" />}
          options={groups.map((community) => ({
            value: community.id,
            label: `${community.name} · ${community.members}`,
            icon: <SocialBadge icon={iconFor(community.platform)} variant="blue" />
          }))}
          menuFooter={
            <div className="flex items-end gap-2">
              <label className="block min-w-0 flex-1">
                <span className="mb-1.5 block text-sm font-semibold text-slate-700">Or type one</span>
                <FormInput
                  type="text"
                  value={scopeName}
                  onChange={(event) => onScopeNameChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onCheck()
                  }}
                  placeholder="r/dallas"
                  autoComplete="off"
                  className="h-9"
                  radius={8}
                />
              </label>
              <Button
                type="button"
                variant="gray"
                size="lg"
                disabled={scopeName.trim() === '' || checking}
                onClick={onCheck}
                className="shrink-0"
              >
                {checking ? 'Checking…' : 'Validate'}
              </Button>
            </div>
          }
        />
      </label>
    </div>
  )
}

function PhraseStep({
  platform,
  group,
  phrase,
  existing,
  onPhraseChange,
  onConfirm,
  scopeEditor,
  staged,
  onStage,
  onRemoveStaged
}: {
  platform: ConnectionPlatform
  group: Community | null
  phrase: string
  existing: Keyword[] | null
  onPhraseChange: (value: string) => void
  onConfirm: () => void
  /** Reddit edit mode: scope dropdown + type-to-validate, replacing the chip. */
  scopeEditor?: ReactNode
  /** Create mode batch: queued phrases, staged with the dashed button. */
  staged?: string[]
  onStage?: () => void
  onRemoveStaged?: (item: string) => void
}) {
  const batching = staged !== undefined && onStage !== undefined && onRemoveStaged !== undefined
  const trimmed = phrase.trim()
  const stageDisabled = trimmed === '' || (staged ?? []).includes(trimmed)
  return (
    <div className="flex flex-col gap-4">
      {scopeEditor ?? (platform !== 'x' && group ? (
        <div className="flex items-center gap-4 rounded-xl bg-[#2A8CFF] px-4 py-3">
          <SocialGlyph icon={iconFor(group.platform)} className="size-12 shrink-0 text-white" />
          <span className="truncate text-base font-bold text-white">{group.name}</span>
          <span className="ml-auto shrink-0 text-sm text-white/75">{group.handle}</span>
        </div>
      ) : null)}
      <label className="block">
        <span className="mb-1.5 block text-sm font-semibold text-slate-700">
          {platform === 'x' ? 'Phrase (words are combined)' : 'Phrase'}
        </span>
        <input
          type="text"
          autoFocus
          value={phrase}
          onChange={(event) => onPhraseChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onConfirm()
          }}
          placeholder={platform === 'x' ? 'e.g. plumber needed near me' : 'e.g. leaking pipe'}
          autoComplete="off"
          className="h-14 w-full rounded-xl border border-slate-300 bg-white px-4 text-slate-900 placeholder:text-slate-400 focus:border-[#2a8cff] focus:outline-none disabled:opacity-60"
        />
      </label>
      {batching && staged.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {staged.map((item) => (
            <div key={item} className="flex items-center gap-2 rounded-xl bg-black/[0.03] px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
                “{item}”
              </span>
              <button
                type="button"
                onClick={() => onRemoveStaged(item)}
                aria-label={`Remove ${item}`}
                className="flex size-6 shrink-0 items-center justify-center rounded-full text-text-secondary hover:bg-black/[0.05] hover:text-text-primary"
              >
                <X size={14} strokeWidth={2.5} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {batching ? (
        <button
          type="button"
          onClick={onStage}
          disabled={stageDisabled}
          className="inline-flex h-9 items-center gap-1.5 self-start rounded-lg border-2 border-dashed border-slate-300 px-3 text-sm font-medium text-text-secondary hover:border-[#2a8cff] hover:text-[#2a8cff] disabled:opacity-50"
        >
          <Plus size={16} strokeWidth={2.25} aria-hidden="true" />
          Add another keyword
        </button>
      ) : null}
      {existing ? (
        existing.length > 0 ? (
          <p className="text-xs text-text-secondary">
            Already listening here:{' '}
            {existing.map((keyword, index) => (
              <span key={keyword.id}>
                <span className="font-semibold text-text-primary">“{keyword.phrase}”</span>
                {index < existing.length - 1 ? ', ' : ''}
              </span>
            ))}
          </p>
        ) : (
          <p className="text-xs text-text-secondary">No keywords in this scope yet — this is the first.</p>
        )
      ) : (
        <p className="text-xs text-text-secondary">Loading existing keywords…</p>
      )}
    </div>
  )
}