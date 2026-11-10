package com.slopus.happy.chat

import com.slopus.happy.chat.NormalizedMessage.AgentContent
import com.slopus.happy.chat.NormalizedMessage.Body
import com.slopus.happy.data.MessageRecord
import kotlinx.serialization.json.Json

/**
 * Where a chat's window of records starts. A long chat shows its newest
 * [SPAN] records or so, and each reach of the top adds about [SPAN] more;
 * either way the cut lands where a turn begins (the user's prompt), at most
 * [MAX_SPAN] records back, so a tool's call and its result are not split.
 * The Mac mirror's upload window (runClaudeAgentMirror.ts BACKFILL_LINES,
 * BACKFILL_MAX_LINES, isPromptLine) follows the same rule over transcript lines.
 */
object RecentWindow {
    const val SPAN = 300
    const val MAX_SPAN = 1000

    private val json = Json { ignoreUnknownKeys = true }
    private val interruptMarker = Regex("^\\[Request interrupted by user( for tool use)?\\]$")

    /**
     * A prompt the user typed, on the phone or on the Mac: not a tool result,
     * not the marker a stopped turn writes, not a sub-agent's echo of its prompt.
     */
    fun isTurnStart(record: MessageRecord): Boolean {
        val message = ChatNormalizer.normalize(record) ?: return false
        return isTurnStart(record, message)
    }

    private fun isTurnStart(record: MessageRecord, message: NormalizedMessage): Boolean {
        val body = message.body as? Body.User ?: return false
        if (message.isSidechain || interruptMarker.matches(body.text.trim())) return false
        // The normalizer leaves a user envelope's sub-agent unmarked: read it from the record.
        return !fromSubagent(record)
    }

    /** Whether a session envelope (direct, or wrapped as `{type: 'session', data}`) names a sub-agent. */
    private fun fromSubagent(record: MessageRecord): Boolean {
        val raw = record.contentJson?.let { runCatching { json.parseToJsonElement(it) }.getOrNull() }
        val content = raw.obj?.get("content").obj ?: return false
        val envelope = if (content["type"].str == "session") content["data"].obj ?: return false else content
        return !envelope["subagent"].isNullOrAbsent
    }

    /** A record the window may start on when no prompt is near: the main agent speaking, not a tool's result. */
    private fun isSafeStart(record: MessageRecord): Boolean {
        val message = ChatNormalizer.normalize(record) ?: return false
        if (isTurnStart(record, message)) return true
        val body = message.body as? Body.Agent ?: return false
        return !message.isSidechain && body.content.firstOrNull() !is AgentContent.ToolResult
    }

    /**
     * The seq the window starts at. [records] are oldest first: the newest
     * [MAX_SPAN] stored for a chat just opened, or the [MAX_SPAN] just below
     * the current floor. [atBeginning] says the first of them is the
     * conversation's first (nothing older here or on the server). Null when
     * there are no records.
     */
    fun floor(records: List<MessageRecord>, atBeginning: Boolean): Long? {
        val n = records.size
        if (n == 0) return null
        if (n <= SPAN && atBeginning) return records[0].seq
        val anchor = maxOf(0, n - SPAN)
        for (i in anchor downTo 0) if (isTurnStart(records[i])) return records[i].seq
        if (atBeginning) return records[0].seq
        for (j in anchor until n) if (isSafeStart(records[j])) return records[j].seq
        return records[anchor].seq
    }
}
