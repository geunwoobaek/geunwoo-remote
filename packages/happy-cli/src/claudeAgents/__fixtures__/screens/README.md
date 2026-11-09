# Claude Code dialog screens

Real `claude attach` screens (120×40, `tmux capture-pane -p`) from Claude Code 2.1.319 with Haiku,
used by `dialogs.test.ts`. Nothing here is hand-written: every file is a capture, with paths, the
user name and the session name replaced by fake values (`/Users/tester/project`, `~/project`,
`demo-agent`). Replacing paths shortens some lines, so wrapping may look uneven.

Produced by `scripts/capture-claude-dialogs.mjs --run`, except the two `input-suggestion-*` files,
which come from the manual exploration run that preceded the script (same Claude Code version and
setup, scrubbed the same way). That run is where a session survey and a dim prompt suggestion
showed up on their own; the script cannot provoke them.

| File | Screen |
| --- | --- |
| `input-empty` | idle, empty input box |
| `input-typed` | idle, text typed into the input box |
| `input-suggestion-and-survey` | idle with a session survey (`1: Bad 2: Fine …`) and a dim suggestion in the input box; plain capture, so the suggestion looks like typed text |
| `input-suggestion-ansi` | the same screen captured with `capture-pane -e` (the suggestion is drawn with SGR 2) |
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
| `plan` | ExitPlanMode approval dialog |
| `plan-feedback-typed` | the same with rejection feedback typed into option 3 |
| `after-plan-approve`, `plan-after-empty-reject` | what follows a plan approval / an empty rejection |
| `outcomes.json` | keys pressed in each scenario and the `tool_result` that came back (scrubbed) |

The capture session ran with `--safe-mode --permission-mode default --settings
'{"permissions":{"ask":["Bash","Write","Edit"]}}'` so that prompts appear even though the user's
settings pre-allow Bash. That ask rule is why the Bash screens say `Permission rule Bash requires
confirmation for this command.` and offer only `1. Yes / 2. No`; a Bash prompt without such a rule
normally has a third option. The classifier does not depend on that line, and the deny key is read
from the screen by its `No` label rather than assumed.
