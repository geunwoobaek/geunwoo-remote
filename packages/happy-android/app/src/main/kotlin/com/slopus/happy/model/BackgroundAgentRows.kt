package com.slopus.happy.model

import androidx.compose.runtime.Immutable
import com.slopus.happy.sync.ClaudeAgentEntry
import com.slopus.happy.sync.ClaudeAgentsListing

// The Mac's `claude agents` background sessions folded into the home's one
// list of chats: a session already opened is its mirror's row, one not yet
// opened gets a row of the same shape, and a session still running on the Mac
// is never in the archive.

/** What the home list makes one row of: a stored Happy session, or a Mac background session not opened yet. */
@Immutable
sealed interface SessionRowSource {
    /**
     * A stored session. [liveAgent] is the Mac background session it mirrors
     * while that one still runs on the Mac: the row then stays in the live
     * list, even when the mirror itself was archived. [opening]: its mirror is
     * being opened again.
     */
    data class Stored(val session: Session, val liveAgent: ClaudeAgentEntry? = null, val opening: Boolean = false) : SessionRowSource

    /** A Mac background session with no mirror yet, as a row ([backgroundAgentRow]). */
    data class Agent(val row: SessionRowData) : SessionRowSource
}

private const val AGENT_ROW_PREFIX = "agent:"

/** The row id of [machineId]'s background session [agentId] while it has no mirror. */
fun backgroundAgentRowId(machineId: String, agentId: String): String = "$AGENT_ROW_PREFIX$machineId:$agentId"

/** Whether [id] is a row made for an unopened background session, not a Happy session. */
fun isBackgroundAgentRowId(id: String): Boolean = id.startsWith(AGENT_ROW_PREFIX)

/** A row made for an unopened background session: it has no chat, menu or swipe of its own. */
val SessionRowData.isBackgroundAgent: Boolean get() = isBackgroundAgentRowId(id)

/** The last path component of [cwd] (either slash), or [cwd] itself when it has none (`/`). */
fun folderTail(cwd: String): String = cwd.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\').ifEmpty { cwd }

/**
 * A background session as a row's state, grouped the way `claude agents`
 * groups it: by its [ClaudeAgentEntry.state] when that is one the app knows,
 * else by its status (busy shimmers, waiting shows the orange dot). Waiting
 * is input required, not a permission: the Mac does not say which (a
 * permission prompt is just an open dialog there), and only a running
 * mirror's own request can be approved from the phone.
 */
fun backgroundAgentState(agent: ClaudeAgentEntry): SessionState = when (agent.state) {
    "working" -> SessionState.Thinking
    "blocked" -> SessionState.InputRequired
    "done" -> SessionState.Waiting
    else -> when (agent.status) {
        "busy" -> SessionState.Thinking
        "waiting" -> SessionState.InputRequired
        else -> SessionState.Waiting
    }
}

/**
 * The state of a mirror of the running Mac session [agent]. A mirror that is
 * running and holds a request or question keeps it (answered from the phone).
 * Otherwise the Mac decides when it says how the session stands: the server
 * can still call a mirror active and thinking after its process is gone. A
 * running mirror of a daemon that sends no state keeps its own.
 */
fun mirrorState(session: Session, own: SessionState, agent: ClaudeAgentEntry): SessionState = when {
    session.active && (own == SessionState.PermissionRequired || own == SessionState.InputRequired) -> own
    session.active && agent.state == null -> own
    else -> backgroundAgentState(agent)
}

/**
 * The row of [machineId]'s [agent] before it is opened. Its avatar id is the
 * one its mirror will have (machine and folder), so opening it keeps the face.
 */
fun backgroundAgentRow(machineId: String, agent: ClaudeAgentEntry, opening: Boolean = false): SessionRowData = SessionRowData(
    id = backgroundAgentRowId(machineId, agent.id),
    name = agent.name ?: folderTail(agent.cwd),
    subtitle = agent.cwd,
    avatarId = "$machineId:${agent.cwd}",
    flavor = "claude",
    state = backgroundAgentState(agent),
    createdAt = agent.startedAt,
    lastActivityAt = agent.startedAt,
    active = true,
    archived = false,
    machineId = machineId,
    path = agent.cwd,
    opening = opening,
    preview = agent.lastLine?.let(::sessionPreviewLine),
)

private fun Session.agentKey(): Pair<String, String>? {
    val agentId = metadata?.claudeAgentId?.takeIf { it.isNotBlank() } ?: return null
    val machineId = metadata.machineId?.takeIf { it.isNotEmpty() } ?: return null
    return machineId to agentId
}

/**
 * Which of two mirrors of [agent] stands for it: the one the daemon names,
 * else a running one, else the one worked in last.
 */
private fun prefers(candidate: Session, current: Session, agent: ClaudeAgentEntry): Boolean {
    val named = (candidate.id == agent.mirrorSessionId).compareTo(current.id == agent.mirrorSessionId)
    if (named != 0) return named > 0
    val running = candidate.active.compareTo(current.active)
    if (running != 0) return running > 0
    return candidate.activityAt() > current.activityAt()
}

/**
 * [sessions] with the Mac background sessions of [listings] (by machine id)
 * folded in, so each one is one row. The two are matched by machine and
 * agent id (the mirror's `claudeAgentId`). A mirror of a session still
 * listed is kept live; when a session has several mirrors (an earlier one
 * archived) only one is, and the rest stay where they are. A listed session
 * with no mirror becomes a row of its own. [opening]: agent ids being opened.
 */
fun mergeBackgroundAgents(
    sessions: List<Session>,
    listings: Map<String, ClaudeAgentsListing>,
    opening: Set<String>,
): List<SessionRowSource> {
    val live = LinkedHashMap<Pair<String, String>, ClaudeAgentEntry>()
    for ((machineId, listing) in listings) {
        if (listing.unavailable != null) continue
        for (agent in listing.agents) live[machineId to agent.id] = agent
    }
    if (live.isEmpty()) return sessions.map { SessionRowSource.Stored(it) }

    val mirrors = HashMap<Pair<String, String>, Session>()
    for (session in sessions) {
        val key = session.agentKey() ?: continue
        val agent = live[key] ?: continue
        val current = mirrors[key]
        if (current == null || prefers(session, current, agent)) mirrors[key] = session
    }

    val result = ArrayList<SessionRowSource>(sessions.size + live.size)
    for (session in sessions) {
        val key = session.agentKey()
        result += if (key != null && mirrors[key] === session) {
            SessionRowSource.Stored(session, live.getValue(key), opening = key.second in opening)
        } else {
            SessionRowSource.Stored(session)
        }
    }
    for ((key, agent) in live) {
        if (key !in mirrors) result += SessionRowSource.Agent(backgroundAgentRow(key.first, agent, opening = agent.id in opening))
    }
    return result
}

/** What a tap on a home row does: open a chat, or open (or reopen) a Mac background session's mirror first. */
sealed interface HomeRowTarget {
    data class Chat(val sessionId: String) : HomeRowTarget

    data class Agent(val machineId: String, val agentId: String) : HomeRowTarget
}

/**
 * Where a tap on row [id] goes. An unopened background session is opened. A
 * mirror whose process is gone (a daemon restart) is opened again first,
 * while its session is still listed on the Mac; else its chat opens as it is.
 */
fun resolveHomeRowTarget(id: String, sessions: List<Session>, listings: Map<String, ClaudeAgentsListing>): HomeRowTarget {
    if (isBackgroundAgentRowId(id)) {
        val rest = id.removePrefix(AGENT_ROW_PREFIX)
        return HomeRowTarget.Agent(rest.substringBeforeLast(':'), rest.substringAfterLast(':'))
    }
    val session = sessions.find { it.id == id } ?: return HomeRowTarget.Chat(id)
    if (session.active) return HomeRowTarget.Chat(id)
    val (machineId, agentId) = session.agentKey() ?: return HomeRowTarget.Chat(id)
    val listing = listings[machineId]?.takeIf { it.unavailable == null } ?: return HomeRowTarget.Chat(id)
    return if (listing.agents.any { it.id == agentId }) HomeRowTarget.Agent(machineId, agentId) else HomeRowTarget.Chat(id)
}
