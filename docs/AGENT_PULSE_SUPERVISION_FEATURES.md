# Agent Pulse Supervision Feature Requirements

## Summary

These requirements cover the next Agent Pulse features for supervising local agents from a
phone, tablet, or browser while away from the Mac.

The main product idea is simple:

- show what each project needs now
- let the user answer waiting agents quickly
- let one agent hand work to another with enough context
- make the tablet UI touch-first, not keyboard-first
- keep advanced browser preview comments as a later phase

This document is requirements only. It does not implement the features.

## Research Notes

### Current Agent Pulse State

The repo already has useful building blocks:

- Providers are modeled as `codex`, `claude-code`, and `copilot`.
- Threads already include `workspace`, `workspacePath`, `status`, `lastTurnSummary`, `model`,
  and `reasoningEffort`.
- Thread transcripts already include messages, active turn state, send state, usage, model,
  and reasoning effort.
- The helper already exposes project list, thread list, transcript, send message, stop work,
  model change, approval decision, pending approvals, new thread, and open-on-Mac routes.
- The tablet UI already has workspace grouping, search, thread detail, transcript view, pending
  approval cards, model picker, stop button, open Codex button, and a new-thread dialog.
- Remote access already fits the use case: the user may check Agent Pulse from a phone while
  away from the Mac.

### Codex Memory Pattern

Codex's local memory shape gives Agent Pulse a useful pattern to copy:

- A top-level memory registry points to the useful summaries.
- Each detailed rollout summary has metadata such as `thread_id`, `updated_at`, `rollout_path`,
  `cwd`, and sometimes `git_branch`.
- Summaries are grouped by task, then split into preference signals, reusable knowledge, failures,
  and references.
- Older details are not deleted. Newer summaries point to the newer truth and include enough source
  information to re-check when needed.

Plain lesson:

```text
Keep a current summary for fast reading.
Keep append-only history for truth and recovery.
Use timestamps, ids, source thread ids, and supersedes/invalidates links so agents know what is
latest.
```

### Subspace Comparison

Subspace publicly describes these relevant ideas:

- workspace memory that stores decisions, blockers, progress, and recent state
- shared context across agents
- a keyboard-first command palette
- comments on selected text in terminals, docs, and browser
- browser comments that can attach source component/file/line context

Agent Pulse should not copy the keyboard-first shape directly. Agent Pulse should adapt the
ideas into a phone/tablet control surface.

## Product Goal

When several agents are working, the user should be able to open Agent Pulse and quickly answer:

- What changed?
- What decision was made?
- What is blocked?
- What should happen next?
- Which agent needs me?
- Can I move this work to another agent?

Plain example:

```text
OpenAssist
What happened: Claude fixed settings UI.
Decision: Keep setup controls inside Assistant settings.
Blocker: Codex is waiting for approval.
Next: Run build.
```

## Non-Goals

- Do not build a full Subspace clone.
- Do not require all agents to share one private database.
- Do not expose raw provider files directly to the browser.
- Do not make browser preview comments part of the first release.
- Do not make the phone UI depend on keyboard shortcuts.
- Do not auto-send risky handoff prompts without showing the user what will be sent.
- Do not store handoff notes in project Markdown files.

## Handoff Transfer Design

Use an ephemeral handoff package:

- source chat summary
- user instruction for the target agent
- workspace/branch/thread metadata
- linked source and target thread ids
- live handoff status

Important: this is not meant to update after every chat turn. The primary flow is user-triggered.
The user taps a handoff action inside a chat, adds what they want the other agent to do, Agent
Pulse generates a short AI summary, then that accepted handoff package is sent to the target agent.

The handoff package is temporary. Agent Pulse should keep it only while the handoff relationship is
active. After the target work is returned to the source agent, handed forward to another agent,
stopped, completed, or dismissed, Agent Pulse should destroy the handoff package.

### Why Not Save Handoffs To Markdown?

Saving handoffs will create too much clutter. Most handoffs are only useful for one task. After the
work is handed back to the main agent or handed forward to the next agent, the handoff package is
no longer needed.

Plain rule:

```text
Handoff package = temporary transfer context
Target thread = real work history
Source thread = real work history
No handoff Markdown files
```

### Write Rules For Handoff State

- Agent Pulse owns normal handoff state.
- The primary trigger is a user action such as "Hand off to Codex" or "Hand off to Claude Code."
- Agents do not write handoff Markdown files.
- Agent Pulse does not create `.agent-pulse/HANDOFF.md` or `.agent-pulse/handoffs/`.
- Keep temporary handoff state until the task is handed back, handed forward, done, stopped, or
  dismissed.
- After that, destroy the handoff package and remove any linked handoff status card.
- Keep each handoff package short enough to read on a phone.

### AI Summary Generation

Agent Pulse should generate the handoff summary with AI, but the source data should come from real
workspace evidence:

- current chat transcript
- latest user goal
- workspace path
- branch name, if available
- thread id/session id
- final answer or latest assistant message
- failed command or waiting approval, if available
- files mentioned or changed, if available
- user-entered target instruction

The summary generator must use fixed sections:

- User asks target agent to
- What happened
- Decisions
- Blockers
- Next
- Files touched
- Evidence

The summary should be short. If a fact is not known, it should say "unknown" or leave the section
empty. It must not invent test results, file changes, approvals, or branch names.

The user instruction is separate from the generated summary. Example:

```text
User asks target agent to:
Review the failing build only. Do not change UI styling unless needed.

Summary of source work:
Codex changed the settings UI and is blocked on `pnpm build` approval.
```

### Ephemeral Summary Sessions

Summary generation should not create normal visible agent threads by default.

The preferred behavior is:

```text
User taps handoff
Agent Pulse builds evidence bundle
Agent Pulse asks a summarizer model for a short draft
User reviews or edits the draft
Agent Pulse starts the target agent with the accepted summary
Agent Pulse keeps the accepted handoff package in temporary handoff state
Agent Pulse discards or deletes temporary summarizer state
```

This avoids filling the thread list with "summary-only" conversations.

Requirements:

- Summary-only AI calls should be hidden from the normal thread list.
- If the provider supports a one-shot, non-resumed, or non-persistent call, use that for summary
  generation.
- If a provider can only summarize by creating a normal session, Agent Pulse should mark that
  session as internal and hide or clean it up when the accepted handoff is sent.
- The temporary handoff package is the runtime record. It should expire when the handoff is done,
  returned, stopped, or dismissed.
- There is no durable handoff file. The real durable history lives in the source and target agent
  threads.
- "Delete the summary" means delete the temporary draft/session and destroy the temporary handoff
  package after it is handed back, handed forward, done, stopped, or dismissed.
- If the user cancels the handoff, Agent Pulse should discard the draft and create no handoff
  package.
- Agent Pulse may keep a small local audit event such as "summary draft generated" without keeping
  the full temporary transcript.

## Confirmed Handoff Decisions

These handoff rules are decided and should not be implemented as optional behavior:

- Destroy the handoff package immediately after the work is returned to the source agent.
- Destroy the previous handoff package when a handoff agent hands the work forward to another
  agent.
- Keep only normal source/target thread messages after the package is destroyed.
- Open a review screen first. Do not create the target thread until the user accepts the summary.

## Questions To Confirm Before Implementation

These are not blockers for requirements, but they should be answered before coding.

1. Should Approval Inbox allow approvals directly on phone for every provider, or should some
   approval types still say "Open on Mac"? Recommended: allow only approval types Agent Pulse can
   represent clearly and safely.
2. Should comments on transcript text be saved as local notes, or only used to send a reply back
   to the agent? Recommended: send reply first, saving comments can be phase 2.
3. For Browser Preview Comments later, should Agent Pulse target React apps first? Recommended:
   yes, because source mapping through component metadata is most realistic there.

## Feature 1: Workspace Memory Card

### User Story

As a user checking from my phone, I want one small card per project so I know what happened,
what was decided, what is blocked, and what to do next.

### Screen Placement

- Show cards on the home dashboard.
- Group by project/workspace.
- Put projects with waiting approvals, blockers, or running work first.
- Keep each card short enough for phone viewing.

### Card Fields

Each project card should have:

- `workspaceName`
- `workspacePath`
- `providersActive`
- `latestActivityAt`
- `whatHappened`
- `decisions`
- `blockers`
- `next`
- `sourceThreadIds`
- `confidence`
- `updatedAt`

### Requirements

- The helper should build the card from recent threads in the same workspace.
- The first version can use deterministic extraction from existing fields:
  - `Thread.lastTurnSummary`
  - transcript final assistant messages
  - pending approval state
  - error or waiting status
  - latest failed command text when available
- The card must say when information is missing instead of pretending.
- The card must link back to the source thread.
- The card must be refreshable.
- The card must not overwrite provider-owned history.
- The card must work across Codex, Claude Code, and Copilot threads.
- If temporary handoff state conflicts with live thread state, show live blockers first.

### Acceptance Criteria

- A workspace with recent activity shows one memory card.
- A workspace with a waiting approval shows that blocker clearly.
- Temporary handoff packages can influence the card only while the handoff is active.
- A workspace with no useful summary says "No recent summary yet."
- Tapping a card opens the most relevant thread.
- The card updates after a live thread status or transcript update.

## Feature 2: Cross-Agent Handoff

### User Story

As a user inside a chat, I want to tap "Hand off to Codex" or "Hand off to Claude Code," write what
I want that agent to do, and let Agent Pulse include a short summary of the current work.

Plain example:

```text
Codex is stuck. Tap "Hand off to Claude Code."
User writes: "Please inspect the failing build and only change what is needed."
Agent Pulse summarizes the chat, shows a review screen, then starts Claude Code with the user's ask
plus the summary.
```

### Handoff Entry Points

- Thread detail header action.
- Thread composer/action menu.
- Workspace Memory Card action.
- Approval or blocker card action.
- Touch Command Sheet action.

### Handoff Context

The handoff payload should include:

- source provider
- target provider
- workspace name
- workspace path
- handoff id, if available
- current branch, if available
- source thread title
- source thread id
- user instruction for target agent
- short summary
- decisions
- blockers
- failed command, if available
- files mentioned, if available
- latest user goal
- suggested next prompt

### Requirements

- Handoff is user-triggered. Agent Pulse should not write a new handoff file after every turn.
- The handoff form must include a user message field for what the target agent should do.
- Agent Pulse should generate the handoff summary from the current chat transcript and workspace
  evidence.
- Summary generation should use an ephemeral or hidden summarizer path so it does not create extra
  visible user-facing agent threads.
- Agent Pulse must show a review screen before creating or sending the handoff.
- The user can edit the prompt before sending.
- The target provider list must only show providers that are available for that workspace.
- The first version should support creating a new thread in the target provider.
- If a provider cannot create a thread, Agent Pulse should copy the handoff prompt and say why.
- Handoff must never silently include secrets, tokens, or full raw logs.
- Include enough context to be useful, but keep the default prompt short.
- When a target agent starts from a handoff, its first prompt should include the current
  user instruction, generated summary, and source thread link.
- After the target agent starts, Agent Pulse should keep the handoff package as temporary linked
  handoff state, not as a permanent Markdown note.
- The source thread should keep a visible linked handoff status card showing the target agent's
  progress.

### Acceptance Criteria

- From a Codex thread, the user can prepare a Claude Code handoff prompt.
- From a Claude Code thread, the user can prepare a Codex handoff prompt.
- The review screen shows workspace, source thread, target provider, user's instruction, and
  generated summary.
- The review screen shows the temporary handoff id and linked source thread.
- Sending creates a target-provider thread when supported.
- Sending keeps temporary linked handoff state.
- Sending does not create `.agent-pulse/HANDOFF.md` or `.agent-pulse/handoffs/`.
- Generating the summary does not leave an extra visible summary thread in the main thread list.
- After sending, the source thread shows a handoff status card linked to the target thread.
- If thread creation fails, the user sees the failed reason and can copy the prompt.
- The new thread links back to the source thread in Agent Pulse state.

### Linked Handoff Status Card

When a thread hands off work to another agent, Agent Pulse should show a compact status card inside
the source thread.

Example:

```text
Handed off to Claude Code
Status: Working
Progress: edited 2 files, running tests
Next: waiting for test result
```

Card fields:

- target provider
- target thread id
- target title
- target status
- latest progress summary
- last activity time
- blockers or approvals
- open target thread action
- stop target work action, when supported

Status values:

- `starting`
- `working`
- `waiting_approval`
- `blocked`
- `done`
- `stopped`
- `error`
- `unknown`

Requirements:

- The card should update from the same live thread status events used by the dashboard.
- The card should be visible in the source thread even after navigating away and back.
- The card should not duplicate the full target transcript.
- Tapping the card should open the target thread.
- If the target thread is deleted or unavailable, the card should say that plainly.
- If the target agent stops or fails, the source thread card should show the latest known reason.

### Return Handoff To Source Agent

The target agent thread should also know where it came from. After the target agent finishes or
stops, the user should be able to send a reviewed result summary back to the source agent.

Example:

```text
Codex hands off to Claude Code.
Claude Code works.
User opens the Claude Code thread and checks the result.
User taps "Send result back to Codex."
Agent Pulse creates a short summary of Claude Code's result.
User reviews it.
Agent Pulse sends the accepted summary back to the original Codex thread.
```

Requirements:

- The target thread should show "Started from Codex" or similar source context.
- The target thread should offer a "Send result back" action when the source thread still exists.
- The return summary should use the same ephemeral summary rules: temporary draft/session is
  deleted or hidden after use, and the handoff package is destroyed after the return is sent.
- The return summary must show what changed, what was verified, what failed, and what Codex should
  do next.
- The source thread should receive the return summary as a normal message so it can continue work.
- If the source thread is missing or unavailable, Agent Pulse should let the user copy the return
  summary instead.

## Feature 3: Approval Inbox

### User Story

As a user, I want one screen for every agent waiting on me.

Simple screen wording:

```text
These agents need you.
```

### Screen Placement

- Add a top-level "Approvals" screen or drawer.
- Make it reachable from the home dashboard, command sheet, and attention badges.
- Show total count in the dashboard chrome.

### Inbox Item Fields

Each approval item should show:

- provider
- project/workspace
- thread title
- approval type
- short reason
- command or file summary when available
- age
- risk level
- available actions

### Requirements

- The inbox should merge pending approval requests across Codex, Claude Code, and Copilot.
- Items must be grouped by risk and recency, not only by provider.
- Low-risk actions can show direct buttons if Agent Pulse has the exact provider decision route.
- Unclear or high-risk actions should show "Open on Mac" or "Open thread" instead of guessing.
- The inbox must update live when approvals appear or clear.
- The wording should be calm and direct.

### Acceptance Criteria

- If two different providers need input, both appear in one inbox.
- Clearing an approval removes it from the inbox without needing a refresh.
- Unsupported approval types still show with a useful fallback action.
- The home dashboard visibly shows that approvals are waiting.

## Feature 4: Touch Command Sheet

### User Story

As a phone/tablet user, I want one big action sheet for common actions instead of a small
keyboard command palette.

### Initial Actions

The first command sheet should include:

- New thread
- Open on Mac
- Stop work
- Change model
- Show approvals
- Search threads

### Requirements

- Use a large touch target layout.
- Actions should be context-aware.
- Disabled actions must explain why they are disabled.
- The sheet should be available from every main screen.
- It should not hide the existing sidebar search or thread-level controls.
- It should prefer icons plus short labels.

### Acceptance Criteria

- On the dashboard, the sheet can start a new thread, show approvals, and search threads.
- On a thread, the sheet can open on Mac, stop work, change model, and search threads.
- If no active thread exists, thread-only actions are disabled with clear wording.
- The sheet works on phone-sized screens without clipped text.

## Feature 5: Comment On Transcript

### User Story

As a user, I want to select part of an agent response and reply about exactly that text.

Plain example:

```text
Selected text: "I skipped tests."
Reply: "Please run the tests now."

Agent Pulse sends:
About this part of your response:
"I skipped tests."

Please run the tests now.
```

### Requirements

- The user can select text inside assistant transcript messages.
- Agent Pulse shows a small "Reply about this" action.
- The reply composer includes the selected quote automatically.
- The user can edit before sending.
- The selected quote should include message id and thread id in local UI state.
- The provider only receives the final message text, unless future provider APIs support richer
  anchored comments.
- Keep selected text length capped so the prompt stays readable.

### Acceptance Criteria

- Selecting assistant text reveals a reply action.
- Tapping the action opens the composer with the selected text quoted.
- Sending the reply uses the existing thread message route.
- The feature works on touch selection and mouse selection.
- If selection is too long, Agent Pulse trims it and tells the user.

## Feature 6: Later Browser Preview Comments

### User Story

As a user reviewing a localhost preview on tablet, I want to tap a UI problem and send a comment
that points the agent to the likely source code.

### Phase

This is later, after the first five features are useful.

### Requirements

- Show a localhost preview in Agent Pulse or a paired preview panel.
- Let the user tap/select an element and write a comment.
- Attach URL, viewport size, screenshot or crop, selected text, DOM selector, and source hint
  when available.
- For React apps, investigate source hints from React component metadata and sourcemaps.
- If source mapping is unavailable, still send the visual comment with URL and screenshot.
- Keep browser preview comments separate from transcript comments in the data model.

### Acceptance Criteria

- A user can comment on visible preview UI.
- The generated agent prompt includes enough visible context to reproduce the issue.
- If source mapping is present, the prompt includes source file/component hints.
- If source mapping is missing, the UI says source file is unknown and still sends the comment.

## Suggested Delivery Order

### Phase 1: Supervision Basics

Build first:

- Workspace Memory Card
- Approval Inbox
- Touch Command Sheet

Reason: these help the user check work from phone quickly.

### Phase 2: Better Steering

Build next:

- Cross-Agent Handoff
- Comment On Transcript

Reason: these help the user redirect work without retyping context.

### Phase 3: Visual Feedback

Build later:

- Browser Preview Comments

Reason: this is powerful but needs more browser/source-map research.

## Shared Data Model Additions

Recommended new shared schemas:

- `WorkspaceMemoryCard`
- `WorkspaceMemoryCardResponse`
- `HandoffPackage`
- `HandoffSummaryDraft`
- `LinkedHandoffStatus`
- `ReturnHandoffRequest`
- `HandoffDraftRequest`
- `HandoffDraftResponse`
- `HandoffSendRequest`
- `ApprovalInboxItem`
- `ApprovalInboxResponse`
- `TranscriptCommentDraft`
- `TouchCommand`

Keep these schemas provider-neutral. Provider-specific details should stay in optional metadata
objects.

## API Requirements

Recommended helper routes:

- `GET /workspaces/memory-cards`
- `POST /workspaces/:workspaceId/memory-card/refresh`
- `GET /approvals/inbox`
- `GET /handoffs`
- `POST /handoffs/summary-draft`
- `POST /handoffs/send`
- `POST /handoffs/:handoffId/return`
- `DELETE /handoffs/:handoffId`
- `POST /threads/:threadId/comment-draft`
- `GET /commands/touch-sheet`

Live events to add:

- `workspace/memory-card/changed`
- `approval-inbox/changed`
- `handoff/changed`
- `handoff/removed`

## Safety Requirements

- Do not expose raw provider files to the tablet.
- Do not include secrets in handoff summaries.
- Do not auto-approve high-risk actions.
- Keep provider-specific approval decisions explicit.
- Record enough local audit data to answer "what did I send and where?"
- Respect existing pairing and remote-access security rules.

## Open Implementation Notes

- Branch detection can start with `git rev-parse --abbrev-ref HEAD` for workspace paths, with a
  timeout and safe fallback to "unknown branch."
- Failed command detection can start from transcript activity/command messages.
- Memory cards can start as helper-generated summaries and later become agent-maintained notes.
- Approval Inbox can reuse existing pending approval data first, then improve provider adapters.
- Transcript comments can be implemented without new provider APIs because they are sent as normal
  thread messages.

## References

- Current Agent Pulse README and shared schemas in this repo.
- `docs/TOUCH_APP_REQUIREMENTS.md`
- `docs/REMOTE_ACCESS_REQUIREMENTS.md`
- Subspace public product page, accessed 2026-05-02: https://www.subspace.build/
