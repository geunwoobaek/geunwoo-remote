package com.slopus.happy.model

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.NormalizedMessage
import com.slopus.happy.chat.NormalizedMessage.AgentContent
import com.slopus.happy.chat.NormalizedMessage.Body

/**
 * What the home row reads out of a session's newest messages: [line], its
 * last answer or tool call, and [turnStartedAt], when the user's last
 * message went in (the Working clock). Null where none is stored.
 */
@Immutable
data class SessionPreview(val line: String?, val turnStartedAt: Long?)

/** The longest last line a row keeps; the row ellipsizes it further. */
const val SESSION_PREVIEW_MAX = 120

/**
 * [newestFirst] read from the newest: the first answer text (its first
 * non-blank line, markdown marks dropped) or tool call (its title, else its
 * name) outside a sub-agent; thinking, results and events are passed over.
 */
fun previewOf(newestFirst: List<NormalizedMessage>): SessionPreview {
    var line: String? = null
    var turnStartedAt: Long? = null
    for (message in newestFirst) {
        when (val body = message.body) {
            is Body.User -> if (turnStartedAt == null) turnStartedAt = message.createdAt
            is Body.Agent -> if (line == null && !message.isSidechain) {
                line = body.content.asReversed().firstNotNullOfOrNull { content ->
                    when (content) {
                        is AgentContent.Text -> previewLine(content.text)
                        is AgentContent.ToolUse -> (content.title?.takeIf { it.isNotBlank() } ?: content.name).let { previewLine(it, marks = false) }
                        else -> null
                    }
                }
            }
            else -> Unit
        }
        if (line != null && turnStartedAt != null) break
    }
    return SessionPreview(line, turnStartedAt)
}

private val leadingMarks = Regex("^(?:#{1,6}\\s+|>\\s*|[-*+]\\s+|\\d+[.)]\\s+)+")
// Underscores stay: they are in names (`user_id`, `mcp__x__create_issue`) far more often than emphasis.
private val inlineMarks = Regex("\\*+|`+|~~")
private val spaces = Regex("\\s+")

/** [text]'s first non-blank line as one plain line (markdown [marks] dropped), or null when it has none. */
private fun previewLine(text: String, marks: Boolean = true): String? {
    val first = text.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() } ?: return null
    val unmarked = if (marks) first.replace(leadingMarks, "").replace(inlineMarks, "") else first
    val plain = unmarked.replace(spaces, " ").trim()
    if (plain.isEmpty()) return null
    return if (plain.length <= SESSION_PREVIEW_MAX) plain else plain.take(SESSION_PREVIEW_MAX - 1).trimEnd() + "…"
}
