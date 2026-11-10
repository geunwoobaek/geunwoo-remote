package com.slopus.happy.ui.home

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.HomeRowTarget
import com.slopus.happy.sync.CLAUDE_AGENTS_UNSUPPORTED
import com.slopus.happy.sync.ClaudeAgentsListing
import com.slopus.happy.sync.MachineOps
import com.slopus.happy.sync.OpenClaudeAgentResult
import com.slopus.happy.ui.components.HomeCardSpec
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

object ClaudeAgentsTags {
    const val NOTICE = "claudeAgents.notice"
}

/** Why a machine has no background sessions to list, said in one line. */
enum class ClaudeAgentsNotice { TmuxMissing, ClaudeMissing, CouldNotList }

/**
 * The line for an `unavailable` reason; null for none, and for `unsupported`
 * (a daemon from before the feature), which says nothing.
 */
fun claudeAgentsNotice(unavailable: String?): ClaudeAgentsNotice? = when (unavailable) {
    null, CLAUDE_AGENTS_UNSUPPORTED -> null
    "tmux-missing" -> ClaudeAgentsNotice.TmuxMissing
    "claude-missing" -> ClaudeAgentsNotice.ClaudeMissing
    else -> ClaudeAgentsNotice.CouldNotList
}

/** The one line over the home list saying why a machine lists no background sessions; [machineName] when there are several. */
@Immutable
data class ClaudeAgentsNoticeLine(val notice: ClaudeAgentsNotice, val machineName: String?)

/**
 * The first of [machines] (id to name, in order) that could not list, as one
 * line; null when every one listed, or knows no listing. The machine is named
 * only when there is more than one.
 */
fun claudeAgentsNoticeLine(machines: List<Pair<String, String>>, listings: Map<String, ClaudeAgentsListing>): ClaudeAgentsNoticeLine? {
    for ((id, name) in machines) {
        val notice = claudeAgentsNotice(listings[id]?.unavailable) ?: continue
        return ClaudeAgentsNoticeLine(notice, name.takeIf { machines.size > 1 })
    }
    return null
}

/** The notice line, set as the home's archive toggle is, over the list. */
@Composable
fun ClaudeAgentsNoticeText(line: ClaudeAgentsNoticeLine) {
    val text = stringResource(
        when (line.notice) {
            ClaudeAgentsNotice.TmuxMissing -> R.string.session_claude_agents_tmux_missing
            ClaudeAgentsNotice.ClaudeMissing -> R.string.session_claude_agents_claude_missing
            ClaudeAgentsNotice.CouldNotList -> R.string.session_claude_agents_could_not_list
        },
    )
    Text(
        text = line.machineName?.let { "$it · $text" } ?: text,
        style = HomeSpec.archiveToggleText,
        color = HappyTheme.colors.textSecondary,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .contentMaxWidth(LocalWindowLayout.current)
            .padding(start = HomeCardSpec.inset + 8.dp, end = HomeCardSpec.inset + 8.dp, top = 4.dp, bottom = HomeSpec.sectionPaddingBottom)
            .testTag(ClaudeAgentsTags.NOTICE),
    )
}

/** How often the home lists the Mac's background sessions again while it is on screen. */
const val CLAUDE_AGENTS_RELIST_MS = 10_000L

/**
 * What the home asks of the Mac's background sessions: what each online machine
 * listed, and which session is being opened. Listing runs while the home is on screen
 * ([keepListed]: at once, then every [CLAUDE_AGENTS_RELIST_MS], so a session started
 * on the Mac shows up by itself) and on pull to refresh; never while the home is hidden.
 */
class ClaudeAgentsModel(private val ops: () -> MachineOps?) {
    private val listingsState = MutableStateFlow<Map<String, ClaudeAgentsListing>>(emptyMap())
    private val openingState = MutableStateFlow<Set<String>>(emptySet())

    /** Each machine's listing, by machine id. */
    val listings: StateFlow<Map<String, ClaudeAgentsListing>> = listingsState.asStateFlow()

    /** Ids of the agents whose open is in flight. */
    val opening: StateFlow<Set<String>> = openingState.asStateFlow()

    /** Lists every machine of [machineIds] at once; what an earlier read said of any other machine is dropped. */
    suspend fun refresh(machineIds: List<String>) {
        val machineOps = ops() ?: return
        listingsState.update { known -> known.filterKeys { it in machineIds } }
        coroutineScope {
            machineIds.map { id ->
                async { listingsState.update { known -> known + (id to machineOps.listClaudeAgents(id)) } }
            }.awaitAll()
        }
    }

    /** Lists [machineIds] now and again every [everyMs] until cancelled: run it only while the home is on screen. */
    suspend fun keepListed(machineIds: List<String>, everyMs: Long = CLAUDE_AGENTS_RELIST_MS) {
        while (true) {
            refresh(machineIds)
            delay(everyMs)
        }
    }

    /** Lists one machine again, as after opening one of its sessions; a machine not among the listed ones stays unlisted. */
    suspend fun refreshMachine(machineId: String) {
        val machineOps = ops() ?: return
        val listing = machineOps.listClaudeAgents(machineId)
        listingsState.update { known -> if (machineId in known) known + (machineId to listing) else known }
    }

    /** Opens [agentId]; null when that row is already being opened, so a repeat tap does nothing. */
    suspend fun open(machineId: String, agentId: String): OpenClaudeAgentResult? {
        var started = false
        openingState.update { current ->
            started = agentId !in current
            if (started) current + agentId else current
        }
        if (!started) return null
        return try {
            ops()?.openClaudeAgent(machineId, agentId) ?: OpenClaudeAgentResult.Error("")
        } finally {
            openingState.update { it - agentId }
        }
    }
}

/**
 * Carries out a tap on a home row ([com.slopus.happy.model.resolveHomeRowTarget]):
 * a chat opens at once; a Mac background session's mirror is opened (or
 * opened again) first, then its chat, and the machine is listed again so the
 * row turns into the mirror's. A failed open is [fail]ed with the daemon's words.
 */
suspend fun openHomeRow(
    target: HomeRowTarget,
    open: suspend (machineId: String, agentId: String) -> OpenClaudeAgentResult?,
    navigate: (sessionId: String) -> Unit,
    relist: suspend (machineId: String) -> Unit,
    fail: (message: String) -> Unit,
) {
    when (target) {
        is HomeRowTarget.Chat -> navigate(target.sessionId)
        is HomeRowTarget.Agent -> when (val result = open(target.machineId, target.agentId)) {
            null -> Unit
            is OpenClaudeAgentResult.Success -> {
                navigate(result.sessionId)
                relist(target.machineId)
            }
            is OpenClaudeAgentResult.Error -> fail(result.message)
        }
    }
}
