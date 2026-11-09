package com.slopus.happy.ui.home

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.sync.CLAUDE_AGENTS_UNSUPPORTED
import com.slopus.happy.sync.ClaudeAgentEntry
import com.slopus.happy.sync.ClaudeAgentsListing
import com.slopus.happy.sync.MachineOps
import com.slopus.happy.sync.OpenClaudeAgentResult
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.components.HomeCardRow
import com.slopus.happy.ui.components.HomeCardSpec
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

object ClaudeAgentsTags {
    const val SECTION = "claudeAgents.section"
    const val TITLE = "claudeAgents.title"
    const val ROW = "claudeAgents.row"
    const val NOTICE = "claudeAgents.notice"
    const val PROGRESS = "claudeAgents.progress"
}

/** Why a machine has no background sessions to list, said in one line. */
enum class ClaudeAgentsNotice { TmuxMissing, ClaudeMissing, CouldNotList }

/**
 * The line for an `unavailable` reason; null for none, and for `unsupported`
 * (a daemon from before the feature), which hides the section instead.
 */
fun claudeAgentsNotice(unavailable: String?): ClaudeAgentsNotice? = when (unavailable) {
    null, CLAUDE_AGENTS_UNSUPPORTED -> null
    "tmux-missing" -> ClaudeAgentsNotice.TmuxMissing
    "claude-missing" -> ClaudeAgentsNotice.ClaudeMissing
    else -> ClaudeAgentsNotice.CouldNotList
}

/** How a row says what the session is doing; a status this app does not know is shown as the daemon wrote it. */
sealed interface ClaudeAgentStatusLabel {
    data object Working : ClaudeAgentStatusLabel

    data object Idle : ClaudeAgentStatusLabel

    data object Waiting : ClaudeAgentStatusLabel

    data class Other(val raw: String) : ClaudeAgentStatusLabel
}

fun claudeAgentStatusLabel(status: String): ClaudeAgentStatusLabel = when (status) {
    "busy" -> ClaudeAgentStatusLabel.Working
    "idle" -> ClaudeAgentStatusLabel.Idle
    "waiting" -> ClaudeAgentStatusLabel.Waiting
    else -> ClaudeAgentStatusLabel.Other(status)
}

/** The last path component of [cwd] (either slash), or [cwd] itself when it has none (`/`). */
fun folderTail(cwd: String): String = cwd.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\').ifEmpty { cwd }

/**
 * [listing]'s agents that the home does not already show: one whose mirror
 * session is among [homeSessionIds] has its own row.
 */
fun visibleAgents(listing: ClaudeAgentsListing, homeSessionIds: Set<String>): List<ClaudeAgentEntry> =
    listing.agents.filter { it.mirrorSessionId == null || it.mirrorSessionId !in homeSessionIds }

/** One machine's part of the section: its agents, or the one line saying why it has none. */
@Immutable
data class ClaudeAgentsBlock(
    val machineId: String,
    val machineName: String?,
    val agents: List<ClaudeAgentEntry>,
    val notice: ClaudeAgentsNotice?,
)

/**
 * The machines of [machineIds], in that order, that have something to show:
 * agents not already on the home, or a notice. A machine not listed yet, one
 * whose daemon does not know the feature and one with nothing to open have no
 * block.
 */
fun claudeAgentBlocks(
    machineIds: List<String>,
    names: Map<String, String>,
    listings: Map<String, ClaudeAgentsListing>,
    homeSessionIds: Set<String>,
): List<ClaudeAgentsBlock> = machineIds.mapNotNull { id ->
    val listing = listings[id] ?: return@mapNotNull null
    val notice = claudeAgentsNotice(listing.unavailable)
    when {
        listing.unavailable != null ->
            notice?.let { ClaudeAgentsBlock(id, names[id], emptyList(), it) }
        else -> visibleAgents(listing, homeSessionIds).takeIf { it.isNotEmpty() }
            ?.let { ClaudeAgentsBlock(id, names[id], it, null) }
    }
}

/**
 * What the home asks of the Mac's background sessions: what each online machine
 * listed, and which row is being opened. Listing is on demand ([refresh], on
 * entering home and on pull to refresh), never on a timer.
 */
class ClaudeAgentsModel(private val ops: () -> MachineOps?) {
    private val listingsState = MutableStateFlow<Map<String, ClaudeAgentsListing>>(emptyMap())
    private val openingState = MutableStateFlow<Set<String>>(emptySet())

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

/** What the home list draws of the section and what its rows do. */
@Immutable
class ClaudeAgentsUi(
    val blocks: List<ClaudeAgentsBlock>,
    val opening: Set<String>,
    val onOpen: (machineId: String, agentId: String) -> Unit,
)

/**
 * "Claude background sessions": under a heading, one card of rows per machine
 * (a name or the folder's end, the folder's end, how it is doing; a spinner
 * while it opens), as the home's chat rows are laid out. A machine that cannot
 * list says why in a line instead. Nothing is drawn when [ui] has no block.
 */
@Composable
fun ClaudeAgentsSection(ui: ClaudeAgentsUi) {
    if (ui.blocks.isEmpty()) return
    val colors = HappyTheme.colors
    val title = stringResource(R.string.session_claude_agents_title)
    Column(Modifier.testTag(ClaudeAgentsTags.SECTION)) {
        for (block in ui.blocks) {
            val heading = if (ui.blocks.size > 1 && block.machineName != null) "$title · ${block.machineName}" else title
            Text(
                text = heading,
                style = HomeSpec.sectionHeader,
                color = colors.grouped.sectionTitle,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .contentMaxWidth(LocalWindowLayout.current)
                    .padding(start = HomeCardSpec.inset + 8.dp, end = HomeCardSpec.inset + 8.dp, top = 4.dp, bottom = HomeSpec.sectionPaddingBottom)
                    .testTag(ClaudeAgentsTags.TITLE),
            )
            block.notice?.let { notice ->
                Text(
                    text = stringResource(
                        when (notice) {
                            ClaudeAgentsNotice.TmuxMissing -> R.string.session_claude_agents_tmux_missing
                            ClaudeAgentsNotice.ClaudeMissing -> R.string.session_claude_agents_claude_missing
                            ClaudeAgentsNotice.CouldNotList -> R.string.session_claude_agents_could_not_list
                        },
                    ),
                    style = HomeSpec.archiveToggleText,
                    color = colors.textSecondary,
                    modifier = Modifier
                        .contentMaxWidth(LocalWindowLayout.current)
                        .padding(horizontal = HomeCardSpec.inset + 8.dp)
                        .testTag(ClaudeAgentsTags.NOTICE),
                )
            }
            block.agents.forEachIndexed { index, agent ->
                val last = index == block.agents.lastIndex
                HomeCardRow(
                    place = HomeCardPlace(first = index == 0, last = last),
                    height = FlatRowSpec.cardRowHeight(),
                    dividerStart = FlatRowSpec.paddingLeft,
                    tag = ClaudeAgentsTags.ROW,
                ) {
                    ClaudeAgentRow(agent, opening = agent.id in ui.opening, onClick = { ui.onOpen(block.machineId, agent.id) })
                }
            }
            Spacer(Modifier.height(HomeCardSpec.gap))
        }
    }
}

/** A row as [FlatSessionRow] lays one out: 16 in, 10 above and below, title 17, folder 15, then the status line 13. */
@Composable
private fun ClaudeAgentRow(agent: ClaudeAgentEntry, opening: Boolean, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    val folder = folderTail(agent.cwd)
    val status = when (val label = claudeAgentStatusLabel(agent.status)) {
        ClaudeAgentStatusLabel.Working -> stringResource(R.string.session_claude_agent_working)
        ClaudeAgentStatusLabel.Idle -> stringResource(R.string.session_claude_agent_idle)
        ClaudeAgentStatusLabel.Waiting -> stringResource(R.string.session_claude_agent_waiting)
        is ClaudeAgentStatusLabel.Other -> label.raw
    }
    val waiting = claudeAgentStatusLabel(agent.status) == ClaudeAgentStatusLabel.Waiting
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = !opening, role = Role.Button, onClick = onClick)
            .padding(
                start = FlatRowSpec.paddingLeft,
                end = FlatRowSpec.paddingRight,
                top = FlatRowSpec.paddingVertical,
                bottom = FlatRowSpec.paddingVertical,
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(FlatRowSpec.avatarGap),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = agent.name ?: folder,
                style = FlatRowSpec.title,
                color = colors.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = folder,
                style = FlatRowSpec.project,
                color = colors.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = status,
                style = FlatRowSpec.workspace,
                color = if (waiting) BlockedDotColor else colors.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 1.dp).heightIn(min = FlatRowSpec.workspaceMinHeight),
            )
        }
        if (opening) {
            Box(Modifier.size(FlatRowSpec.topRightDot).testTag(ClaudeAgentsTags.PROGRESS), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(modifier = Modifier.size(FlatRowSpec.topRightDot), color = colors.textSecondary, strokeWidth = 2.dp)
            }
        }
    }
}
