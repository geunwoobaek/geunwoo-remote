# Claude Code dialog screens

Real `claude attach` screens (120×40, `tmux capture-pane -p`) from Claude Code 2.1.319 with Haiku,
used by `dialogs.test.ts`. Nothing here is hand-written: every file is a capture, with paths, the
user name and the session name replaced by fake values (`/Users/tester/project`, `~/project`,
`demo-agent`). Replacing paths shortens some lines, so wrapping may look uneven.

Produced by `scripts/capture-claude-dialogs.mjs --run` (the `question-lone-multi*`,
`question-last-multi*`, `permission-read` and `permission-edit` files by a later
`--run --only multi-select,edit-read`), except the two `input-suggestion-*` files,
which come from the manual exploration run that preceded the script (same Claude Code version and
setup, scrubbed the same way). That run is where a session survey and a dim prompt suggestion
showed up on their own; the script cannot provoke them.

The two `input-draft-*-attach` files are `capture-pane -e` captures of `claude attach` to a throwaway
background session (Claude Code 2.1.322, Haiku, `claude --bg`) driven by the real `createInputDelivery`.
Rows above the first prompt held hook output from other sessions and were blanked (rows kept); the
session name became `demo-agent` (its rule padded back to full width) and the usage numbers were
replaced.

The `mode-*` and `model-*` files are `capture-pane -e` captures of `claude attach` to a throwaway
background session (Claude Code 2.1.322, Haiku, `claude --bg`), taken while switching its settings
the way the phone does: Shift+Tab for the permission mode, `/model` and the picker's `s` ("use this
session only") for the model and effort. Rows above the first prompt were blanked (rows kept), the
session name became `demo-agent` and the usage numbers were replaced.

`input-empty-bg-agents` is a `capture-pane -e` capture of a plain interactive session (Claude Code
2.1.322, Haiku, the same non-safe-mode setup as the `*-live` files) that had started three background
subagents; the session name was replaced by `demo-agent-background-1`.

The two `*-live` files come from one extra session started WITHOUT `--safe-mode` (the user's hooks,
plugins and custom two-line status line active; only `--settings` with an ask rule for Bash). They
check that a real everyday session looks the same at the bottom of the screen. Hook output above
the first prompt held the user's own notes and was blanked (rows kept, so the screen is still 40
rows).

| File | Screen |
| --- | --- |
| `input-empty` | idle, empty input box |
| `input-typed` | idle, text typed into the input box |
| `input-suggestion-and-survey` | idle with a session survey (`1: Bad 2: Fine …`) and a dim suggestion in the input box; plain capture, so the suggestion looks like typed text |
| `input-suggestion-ansi` | the same screen captured with `capture-pane -e` (the suggestion is drawn with SGR 2) |
| `input-empty-live` | idle, empty input box, non-safe-mode session with a two-line status line |
| `input-draft-attach` | `claude attach` to a background session, a Mac draft typed into the box; `capture-pane -e` |
| `input-draft-restored-attach` | the same session after a stash (Ctrl+S), a sent phone text and Claude Code's `Draft restored` |
| `input-empty-bg-agents` | idle with three background agents running: the agent list (`⏺ main`, `◯ local_agent …`) sits under the status lines; `capture-pane -e`, the box holds only a dim suggestion |
| `mode-manual` | attached background session in manual mode (`⏸ manual mode on` under the box) |
| `mode-accept-edits` | the same after one Shift+Tab (`⏵⏵ accept edits on`) |
| `mode-plan` | after two (`⏸ plan mode on`) |
| `mode-auto` | after three (`⏵⏵ auto mode on`); a fourth goes back to manual |
| `model-picker` | the `/model` picker: five rows with the cursor and `✔` on Haiku 5.5, the effort line and the `s to use this session only` footer |
| `model-switch-confirm` | `Switch model?` after `s` on another model in a session with cached history (`❯ 1. Yes, switch to Sonnet 5.5`) |
| `model-set-session-only` | the screen after confirming: `Set model to Sonnet 5.5 for this session only with xhigh effort` |
| `permission-bash-live` | Bash permission in the same non-safe-mode session |
| `permission-write` | Write permission for a new file (`1. Yes / 2. Yes, and … / 3. No`) |
| `permission-bash` | Bash permission for a long command that wraps (`1. Yes / 2. No`) |
| `permission-bash-short` | Bash permission for a one-line command |
| `permission-subagent` | Write permission asked by a subagent (`· from the general-purpose agent`) |
| `question-single` | lone single-select AskUserQuestion |
| `question-multi` | first of two questions, multi-select, untouched |
| `question-multi-toggled` | the same after toggling options 1 and 3 |
| `question-multi-second` | second question (single-select) after Tab |
| `question-review` | the review screen (`Ready to submit your answers?`) |
| `question-other` | multi-select with free text typed into `Type something` |
| `question-lone-multi` | lone multi-select question, untouched |
| `question-lone-multi-after-tab` | the review screen after toggling 1 and 3 and pressing Tab |
| `question-last-multi` | second of two questions (multi-select) after answering the first (single-select) with 3 |
| `question-last-multi-after-tab` | the review screen after toggling 1 and 2 and pressing Tab |
| `question-lone-multi-plan-mode` | lone multi-select question in a plan-mode session: a `Planning: <plan file>` line between two rules sits above the tab bar |
| `permission-read` | Read permission (`Read file`, block `Read(<path>)`, `Do you want to proceed?`) |
| `permission-edit` | Edit permission (`Edit file`, diff preview, `Do you want to make this edit to …?`) |
| `plan` | ExitPlanMode approval dialog |
| `plan-feedback-typed` | the same with rejection feedback typed into option 3 |
| `after-plan-approve`, `plan-after-empty-reject` | what follows a plan approval / an empty rejection |
| `write-perm-120` | the Write permission dialog, captured in a tmux 120×40 client while a 99-column cmux client was attached; Claude Code drew both at 99 columns |
| `write-perm-99` | the same dialog captured in cmux 99×35 (`cmux read-screen`) |
| `question-long-120` | a single-select question with a long question text, captured in a tmux 120×40 client while a 99-column cmux client was attached; Claude Code drew both at 99 columns |
| `question-long-99` | the same dialog captured in cmux 99×35 (`cmux read-screen`) |
| `outcomes.json` | keys pressed in each scenario and the `tool_result` that came back (scrubbed) |

`question-lone-multi-plan-mode` was captured by hand from a plan-mode session (the plan path, the user name and the session name are scrubbed), not by the capture script.

The capture session ran with `--safe-mode --permission-mode default --settings
'{"permissions":{"ask":["Bash","Write","Edit"]}}'` (the later run also asked for Reads inside the
scratch folder only, `Read(//<scratch>/**)`) so that prompts appear even though the user's
settings pre-allow Bash. That ask rule is why the Bash screens say `Permission rule Bash requires
confirmation for this command.` and offer only `1. Yes / 2. No`; a Bash prompt without such a rule
normally has a third option. The classifier does not depend on that line, and the deny key is read
from the screen by its `No` label rather than assumed.
