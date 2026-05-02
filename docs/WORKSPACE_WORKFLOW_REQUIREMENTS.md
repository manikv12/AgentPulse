# Agent Pulse Workspace Workflow Requirements

## Summary

These requirements cover the next Agent Pulse workflow layer:

- workspace memory cards
- cross-agent handoff
- approval inbox
- touch command sheet
- transcript comments
- later browser preview comments

Simple version: Agent Pulse should not only show agent threads. It should help the user understand what needs attention, move work between agents, and reply from a phone or tablet with less typing.

## Questions To Confirm

These are the main product questions before implementation:

1. Should Workspace Memory Cards be generated automatically by Agent Pulse, or should agents explicitly write/update them?
2. When using Cross-Agent Handoff, should Agent Pulse send the message immediately, or show a preview first?
3. Should transcript comments be saved as local notes, sent only as a reply, or both?
4. For the Approval Inbox, should Agent Pulse allow approvals directly from the phone for every provider, or only show a shortcut into the thread for risky approvals?
5. For browser preview comments, should the first version only support localhost pages opened by Agent Pulse, or any browser tab on the Mac?

Recommended defaults:

- Generate memory cards automatically, but allow manual edits later.
- Show a preview before cross-agent handoff.
- For v1, send transcript comments as replies and also keep a small local comment record.
- Approval Inbox should support direct approval only when the provider exposes a safe approval API.
- Browser preview comments should start with localhost pages launched from Agent Pulse.

## Data Gathered From Current Project

Current Agent Pulse already has useful building blocks:

- The README says Agent Pulse supports Codex, Claude Code, and GitHub Copilot.
- The README says Agent Pulse is for tablet, phone, and browser control of local agents.
- Existing thread data already includes `provider`, `title`, `workspace`, `workspacePath`, `status`, `lastActivityAt`, `lastTurnSummary`, `model`, and `reasoningEffort`.
- Existing status values include `idle`, `running`, `compacting`, `waiting_approval`, `error`, `connection`, and `unknown`.
- Existing transcript data includes messages, active turn, send state, model, reasoning effort, usage, and provider.
- Existing approval support already includes Codex approval methods, request-user-input, plan implementation, MCP elicitation, and Claude approval kinds.
- Existing helper routes already support thread list, project list, thread creation, transcript loading, sending messages, stopping work, opening Codex, pending approvals, approval responses, model changes, and provider settings.
- Existing docs already define Agent Pulse as a touch-first dashboard for seeing active, waiting, approval-needed, error, and workspace-specific work.
- Prior research found Claude Code can be shown, resumed, and monitored using Claude's own CLI/session model. Live control is strongest when Agent Pulse owns the Claude process.

Important gap:

- Current thread data has `workspacePath`, but it does not expose git branch, dirty state, last failed command, or a structured per-project memory summary. These need new helper-side summarization fields.

## Data Gathered From Subspace Benchmark

Source checked: https://www.subspace.build/

Subspace is useful as a comparison because it is solving a similar multi-agent workflow problem, but from a keyboard-first Mac app angle.

Useful benchmark notes:

- Subspace describes itself as a Mac app for Claude Code, Codex, OpenCode, and other agents.
- It creates workspaces from folders and worktrees.
- It builds memory automatically from recent agent sessions.
- Its memory is structured around decisions, blockers, progress, workspace, and timeline.
- It supports cross-agent memory so another agent can know what was already tried.
- It has a keyboard-first command palette for launching agents, switching workspaces, opening files, running shell commands, and searching browser history.
- It supports comments on terminal, doc, and browser text.
- Its browser comments can point agents to source component/file/line data when available.

Agent Pulse difference:

- Subspace is keyboard-first.
- Agent Pulse should be touch-first and remote-friendly.
- So Agent Pulse should not copy Cmd+K directly. It should turn the same idea into big phone/tablet actions, approval counts, and simple cards.

## Product Principles

- Keep the wording short because this is used from a phone.
- Show the next needed action first.
- Do not make the user open every thread just to find the one waiting on them.
- Keep provider-specific behavior honest. Example: if Copilot cannot approve something directly, show that clearly.
- Keep local-first privacy. The helper summarizes local agent state; the browser does not read raw provider files directly.

## Feature 1: Workspace Memory Card

### User Story

As a user checking Agent Pulse from my phone, I want one small card per project that tells me what happened, what was decided, what is blocked, and what to do next.

Example:

```text
OpenAssist
What happened: Claude fixed settings UI.
Decisions: Keep assistant settings inside the assistant view.
Blockers: Codex is waiting for approval.
Next: Run build.
```

### Requirements

- Show one memory card per workspace/project.
- Card sections:
  - `What happened`
  - `Decisions`
  - `Blockers`
  - `Next`
- Show provider badges for agents that contributed to the summary.
- Show freshness, for example `Updated 8 min ago`.
- Show attention state:
  - normal
  - needs approval
  - blocked
  - stale
  - error
- Tapping the card opens the most relevant thread for that workspace.
- If multiple threads matter, show a short list sorted by attention.

### Data Requirements

Add a normalized workspace summary model:

```ts
type WorkspaceMemoryCard = {
  workspaceId: string;
  workspaceName: string;
  workspacePath?: string;
  providers: AgentProvider[];
  status: 'normal' | 'needs_approval' | 'blocked' | 'stale' | 'error';
  happened: string[];
  decisions: string[];
  blockers: string[];
  next: string[];
  sourceThreadIds: string[];
  updatedAt: string;
};
```

Suggested helper sources:

- `Thread.lastTurnSummary`
- transcript messages
- pending approval state
- failed command/tool messages
- explicit agent plan/checklist messages when available

### Acceptance Criteria

- A project with active work shows a memory card.
- A project with an approval shows `needs approval` on the card.
- A project with a failed command shows the failed command as a blocker if known.
- A project with no recent activity either hides the card or shows a stale state.
- The card uses simple language and does not show raw log noise.

## Feature 2: Cross-Agent Handoff

### User Story

As a user, I want to tap `Ask another agent with this context` when one agent gets stuck, so another agent can continue with the important context already included.

Example:

```text
Send summary to Claude Code
Context:
- Workspace: OpenAssist
- Branch: feature/settings-ui
- Current agent: Codex
- Problem: build failed
- Failed command: swift test
- Summary: Codex changed settings UI but needs help fixing tests.
```

### Requirements

- Add a handoff button in thread detail and workspace memory card actions.
- Let the user choose the target provider:
  - Codex
  - Claude Code
  - GitHub Copilot
- Show a preview before sending.
- Handoff state is temporary runtime state only.
- Do not create `.agent-pulse/HANDOFF.md`, `.agent-pulse/handoffs/`, or any other saved handoff
  Markdown file.
- Destroy the temporary handoff package after the work is handed back, handed forward to another
  agent, completed, stopped, or dismissed.
- Do not send an empty handoff. If Agent Pulse cannot summarize enough useful context, show a warning and ask the user to add a short note.
- Keep the handoff short. The default handoff should fit on one phone screen when possible.
- Prefer concrete facts over generic AI wording. Example: say `Failed command: pnpm test` instead of `There may be test issues`.
- Include:
  - source provider
  - source thread id
  - workspace name
  - workspace path
  - git branch, if available
  - dirty git status summary, if available
  - latest thread summary
  - pending approval/question summary
  - failed command, if available
  - selected transcript quote, if started from a transcript selection
- After sending, link the new target thread back to the source thread.

### Handoff Quality Rules

Agent Pulse should build the handoff from evidence it already has, not from a long generic summary.

Good handoff:

```text
Workspace: CodexPulse
Branch: feature/workspace-flow
From: Codex thread abc123
Problem: Approval Inbox requirements are drafted, but no implementation started.
Useful context: Current doc is docs/WORKSPACE_WORKFLOW_REQUIREMENTS.md.
Next ask: Please review the requirements and suggest missing edge cases.
```

Bad handoff:

```text
The user is working on a project and needs help. Please continue.
```

Length limits:

- Default handoff: max 8 bullets.
- Selected transcript quote: max 1,000 characters by default.
- Full transcript is not included by default.
- If more context exists, ask the user to add a short instruction instead of saving a larger
  handoff file.

Empty-state behavior:

- If no useful summary exists, still include workspace, branch if known, source thread, and selected text if available.
- If even those are missing, block the send and ask the user for a short instruction.

### Data Requirements

Current thread data does not include git branch. Add helper-side workspace metadata:

```ts
type WorkspaceRuntimeContext = {
  workspacePath: string;
  gitBranch?: string;
  gitDirtySummary?: string;
  lastFailedCommand?: string;
};
```

Add a handoff request:

```ts
type CrossAgentHandoffRequest = {
  sourceThreadId: string;
  targetProvider: AgentProvider;
  selectedText?: string;
  userInstruction: string;
};
```

### Acceptance Criteria

- User can create a handoff from an existing thread.
- User can preview and edit the handoff message.
- New target thread starts in the same workspace.
- Temporary handoff context is destroyed after return, forward, stop, completion, or dismissal.
- If branch is unavailable, the preview says `Branch unknown` instead of guessing.
- If the target provider cannot start a thread, Agent Pulse shows a clear error.

## Feature 3: Approval Inbox

### User Story

As a user away from my Mac, I want one screen that shows all waiting approvals and questions across Codex, Claude Code, and Copilot.

Simple screen title:

```text
These agents need you
```

### Requirements

- Add a global Approval Inbox screen.
- Show all waiting approvals/questions across providers.
- Group by:
  - provider
  - workspace
  - urgency/status
- Each item shows:
  - provider
  - workspace
  - thread title
  - plain-English request summary
  - age
  - action buttons when supported
- Actions:
  - open thread
  - approve/allow
  - deny
  - answer question
  - stop work
- If direct approval is not supported for that provider/request, show `Open thread` only.

### Data Requirements

Add an aggregate endpoint:

```text
GET /approvals/list
```

Response:

```ts
type ApprovalInboxItem = {
  id: string;
  provider: AgentProvider;
  threadId: string;
  workspace: string;
  workspacePath?: string;
  title: string;
  kind: 'approval' | 'question' | 'plan' | 'tool';
  summary: string;
  createdAt?: string;
  canApprove: boolean;
  canDeny: boolean;
  canAnswer: boolean;
};
```

### Acceptance Criteria

- A Codex pending approval appears in the global inbox.
- A Claude Code tool approval appears when Claude exposes it.
- The inbox count is visible from the dashboard and command sheet.
- Clearing an approval removes it from the inbox without needing a full refresh.
- The inbox never shows duplicate entries for the same provider request.

## Feature 4: Touch Command Sheet

### User Story

As a tablet/phone user, I want a big touch-friendly command sheet instead of a desktop-style `Cmd+K` palette.

Actions:

- New thread
- Open on Mac
- Stop work
- Change model
- Show approvals
- Search threads

### Requirements

- Add a global command button that opens the action sheet.
- Use large touch targets.
- Show only actions that make sense in the current context.
- Keep dangerous actions separated, especially `Stop work`.
- Support both dashboard context and thread context.
- The command sheet should be usable with one thumb on a phone.

### Acceptance Criteria

- On dashboard, the sheet shows `New thread`, `Show approvals`, and `Search threads`.
- On a thread, the sheet also shows `Open on Mac`, `Stop work`, and `Change model` when supported.
- Disabled actions explain why they are disabled.
- The sheet closes after a successful action.

## Feature 5: Comment On Transcript

### User Story

As a user, I want to select part of an agent response and reply about that exact text.

Example:

User selects:

```text
I skipped tests.
```

Agent Pulse prepares:

```text
About this part:
> I skipped tests.

Please run the tests now.
```

### Requirements

- Allow selecting text from assistant messages.
- Show a small `Reply about this` action.
- Insert the selected text into the composer as quoted context.
- Let the user edit before sending.
- Keep the quote short by default.
- If selection is too long, truncate and offer `include full selection`.
- Save a local comment record if the user sends it.

### Data Requirements

Add optional comment metadata:

```ts
type TranscriptComment = {
  id: string;
  threadId: string;
  messageId: string;
  selectedText: string;
  commentText: string;
  createdAt: string;
  sentTurnId?: string;
};
```

### Acceptance Criteria

- User can select text from an assistant response on tablet/phone.
- User can tap `Reply about this`.
- Composer includes the selected quote automatically.
- Sending the message works through the existing thread message endpoint.
- Agent Pulse does not send the comment without user confirmation.

## Feature 6: Later Browser Preview Comments

### User Story

As a user reviewing a localhost app on a tablet, I want to tap a UI problem and comment on it, so the agent receives useful feedback tied to the page and maybe source code.

Example:

```text
This button overlaps the title on mobile.
URL: http://localhost:5173/settings
Viewport: 390x844
Clicked element: button.save
Screenshot attached.
```

### Later Requirements

- Show a localhost preview inside Agent Pulse or alongside Agent Pulse.
- Let user tap an element or screen area.
- Capture:
  - URL
  - viewport size
  - screenshot
  - clicked coordinates
  - DOM element info when possible
  - source code link when available
- Send that context to the selected agent thread.

### Non-Goals For First Version

- Full browser devtools replacement.
- Perfect source mapping for every framework.
- Remote public web review.
- Multi-person comments.

### Acceptance Criteria For Later Version

- User can open a localhost preview from Agent Pulse.
- User can mark a visual problem and send it to an agent.
- The receiving agent gets enough context to reproduce the issue.
- If source mapping fails, Agent Pulse still sends URL, screenshot, and viewport.

## Suggested Build Order

1. Approval Inbox
2. Touch Command Sheet
3. Workspace Memory Card
4. Comment On Transcript
5. Cross-Agent Handoff
6. Browser Preview Comments

Why this order:

- Approval Inbox uses data Agent Pulse mostly already has.
- Touch Command Sheet mostly organizes existing actions.
- Workspace Memory Card needs summarization work.
- Transcript comments need new selection/comment UX.
- Cross-Agent Handoff needs workspace runtime context and safe preview.
- Browser Preview Comments are valuable, but they are a bigger feature.

## MVP Recommendation

The strongest first release is:

- Approval Inbox with `These agents need you`
- Touch Command Sheet
- Basic Workspace Memory Card

This gives the biggest phone/tablet value quickly:

- user sees what needs attention
- user can act without hunting through threads
- user can understand project state in one glance

## Open Implementation Notes

- Add shared schemas before UI work so helper and tablet stay consistent.
- Keep aggregation in the helper, not the browser.
- Do not expose raw provider files to the browser.
- Make provider capability explicit. Example: `canApprove`, `canStop`, `canChangeModel`.
- Use simple fallback text when a provider cannot provide details.
- Prefer live event updates for counts and status, with polling as a backup.
