package com.slopus.happy.ui.session

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.data.HappyStore
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.sync.SavedWorkflow
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.chat.SessionRoute
import com.slopus.happy.ui.components.HeaderIconButton
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.files.SessionFileRoute
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.settings.SettingsTile
import com.slopus.happy.ui.settings.SettingsTiles
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** Session info's "Skills & tools" row opens this. */
@Serializable data class SessionSkillsRoute(val id: String)

object SessionSkillsTags {
    const val SCREEN = "sessionSkills"
    const val SEARCH = "sessionSkills.search"
    const val NOT_REPORTED = "sessionSkills.notReported"
    const val NO_MATCH = "sessionSkills.noMatch"
    const val WORKFLOWS_STATUS = "sessionSkills.workflows.status"
    fun skill(name: String) = "sessionSkills.skill.$name"
    fun command(name: String) = "sessionSkills.command.$name"
    fun server(name: String) = "sessionSkills.server.$name"
    fun tool(name: String) = "sessionSkills.tool.$name"
    fun workflow(path: String) = "sessionSkills.workflow.$path"
}

/** More rows than this and the screen offers a search field. */
private const val SEARCH_ABOVE = 12

/** What the screen does when a row is tapped; tests use their own. */
@Immutable
class SessionSkillsActions(
    val onBack: () -> Unit,
    /** A skill or command, without its slash: put `/name ` in the session's composer and go back to the chat. */
    val onInsert: (String) -> Unit,
    /** A workflow script inside the session's folder, opened in the file viewer. */
    val onOpenWorkflow: (SavedWorkflow) -> Unit,
    val onRetryWorkflows: () -> Unit,
)

/**
 * What a session can use right now: its skills, saved workflows, other
 * slash commands, MCP servers with their state, and built-in tools, each in
 * its own group, searchable by name once there are more than a dozen rows.
 *
 * Skills and commands come from the session's metadata ([SkillsCatalog]);
 * until Claude has reported them the screen says so rather than showing
 * empty groups. Workflows are asked of the computer ([WorkflowsState]); a
 * CLI from before that question gets a note to start a new session instead
 * of an error. Tapping a skill or command starts the chat's message with it;
 * tapping a workflow inside the session's folder opens its script, one
 * outside shows only its description.
 */
@Composable
fun SessionSkillsScreen(
    /** Null while the session's stored metadata is still being read. */
    known: SkillsCatalog?,
    workflows: WorkflowsState,
    actions: SessionSkillsActions,
    modifier: Modifier = Modifier,
) {
    val colors = HappyTheme.colors
    val catalog = known ?: SkillsCatalog(reported = true, emptyList(), emptyList(), emptyList(), emptyList())
    var query by rememberSaveable { mutableStateOf("") }
    val workflowList = (workflows as? WorkflowsState.Loaded)?.workflows.orEmpty()
    val rowCount = catalog.skills.size + catalog.commands.size + catalog.servers.size + catalog.tools.size + workflowList.size
    val searchable = rowCount > SEARCH_ABOVE
    val shown = if (searchable) catalog.filter(query) else catalog
    val shownWorkflows = (workflows as? WorkflowsState.Loaded)?.let { if (searchable) it.filter(query) else it.workflows }
    val searching = searchable && query.isNotBlank()

    Screen(
        modifier = modifier.testTag(SessionSkillsTags.SCREEN),
        header = { StackHeader(stringResource(R.string.skills_title), actions.onBack) },
        avoidKeyboard = true,
    ) {
        ItemList {
            if (searchable) SearchField(query) { query = it }
            if (searching && shown.isEmpty && shownWorkflows.isNullOrEmpty()) {
                ItemGroup {
                    Item(
                        title = stringResource(R.string.skills_none_match, query.trim()),
                        modifier = Modifier.testTag(SessionSkillsTags.NO_MATCH),
                    )
                }
            }
            when {
                known == null -> Unit
                !catalog.reported -> ItemGroup(footer = stringResource(R.string.skills_not_reported_footer)) {
                    Item(
                        title = stringResource(R.string.skills_not_reported_title),
                        icon = { SettingsTile(Ionicon.TimeOutline, SettingsTiles.gray) },
                        modifier = Modifier.testTag(SessionSkillsTags.NOT_REPORTED),
                    )
                }
                catalog.isEmpty -> ItemGroup {
                    Item(title = stringResource(R.string.skills_none_reported))
                }
            }
            if (shown.skills.isNotEmpty()) {
                ItemGroup(title = stringResource(R.string.skills_group_skills), footer = stringResource(R.string.skills_insert_footer)) {
                    for (skill in shown.skills) {
                        Item(
                            title = "/$skill",
                            icon = { SettingsTile(Ionicon.SparklesOutline, SettingsTiles.purple) },
                            onClick = { actions.onInsert(skill) },
                            showChevron = false,
                            modifier = Modifier.testTag(SessionSkillsTags.skill(skill)),
                        )
                    }
                }
            }
            WorkflowsGroup(workflows, shownWorkflows, actions)
            if (shown.commands.isNotEmpty()) {
                ItemGroup(title = stringResource(R.string.skills_group_commands), footer = stringResource(R.string.skills_insert_footer)) {
                    for (command in shown.commands) {
                        Item(
                            title = "/$command",
                            icon = { SettingsTile(Ionicon.TerminalOutline, SettingsTiles.indigo) },
                            onClick = { actions.onInsert(command) },
                            showChevron = false,
                            modifier = Modifier.testTag(SessionSkillsTags.command(command)),
                        )
                    }
                }
            }
            if (shown.servers.isNotEmpty()) {
                ItemGroup(title = stringResource(R.string.skills_group_servers)) {
                    for (server in shown.servers) {
                        Item(
                            title = server.name,
                            subtitle = if (server.toolCount > 0) pluralResource(R.plurals.skills_server_tools, server.toolCount, server.toolCount) else null,
                            detail = server.status,
                            detailColor = when (mcpServerHealth(server.status)) {
                                McpServerHealth.Connected -> SessionInfoSpec.online
                                McpServerHealth.Waiting -> SessionInfoSpec.orange
                                McpServerHealth.Failed -> SessionInfoSpec.red
                                McpServerHealth.Other -> colors.textSecondary
                            },
                            icon = { SettingsTile(Ionicon.ServerOutline, SettingsTiles.teal) },
                            modifier = Modifier.testTag(SessionSkillsTags.server(server.name)),
                        )
                    }
                }
            }
            if (shown.tools.isNotEmpty()) {
                ItemGroup(title = stringResource(R.string.skills_group_tools)) {
                    for (tool in shown.tools) {
                        Item(
                            title = tool,
                            icon = { SettingsTile(Ionicon.ConstructOutline, SettingsTiles.gray) },
                            modifier = Modifier.testTag(SessionSkillsTags.tool(tool)),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun WorkflowsGroup(workflows: WorkflowsState, shown: List<SavedWorkflow>?, actions: SessionSkillsActions) {
    val title = stringResource(R.string.skills_group_workflows)
    val statusTag = Modifier.testTag(SessionSkillsTags.WORKFLOWS_STATUS)
    when (workflows) {
        WorkflowsState.Loading -> ItemGroup(title = title) {
            Item(title = stringResource(R.string.skills_workflows_loading), loading = true, modifier = statusTag)
        }
        WorkflowsState.NeedsNewSession -> ItemGroup(title = title) {
            Item(
                title = stringResource(R.string.skills_workflows_new_session),
                subtitle = stringResource(R.string.skills_workflows_new_session_subtitle),
                icon = { SettingsTile(Ionicon.GitNetworkOutline, SettingsTiles.gray) },
                modifier = statusTag,
            )
        }
        is WorkflowsState.Failed -> ItemGroup(title = title) {
            Item(
                title = stringResource(R.string.skills_workflows_failed),
                subtitle = workflows.message?.let { "$it\n" }.orEmpty() + stringResource(R.string.skills_workflows_retry),
                icon = { SettingsTile(Ionicon.GitNetworkOutline, SettingsTiles.red) },
                onClick = actions.onRetryWorkflows,
                modifier = statusTag,
            )
        }
        is WorkflowsState.Loaded -> when {
            workflows.workflows.isEmpty() -> ItemGroup(title = title, footer = stringResource(R.string.skills_workflows_none_footer)) {
                Item(title = stringResource(R.string.skills_workflows_none), modifier = statusTag)
            }
            // Searched away: the "nothing matches" row above covers it.
            shown.isNullOrEmpty() -> Unit
            else -> ItemGroup(
                title = title,
                footer = if (shown.any { !it.opensInViewer }) stringResource(R.string.skills_workflows_outside_footer) else null,
            ) {
                val project = stringResource(R.string.skills_workflow_scope_project)
                val user = stringResource(R.string.skills_workflow_scope_user)
                for (workflow in shown) {
                    Item(
                        title = workflow.name,
                        subtitle = workflow.description ?: workflow.path,
                        subtitleLines = 3,
                        detail = if (workflow.scope == "user") user else project,
                        icon = { SettingsTile(Ionicon.GitNetworkOutline, SettingsTiles.orange) },
                        onClick = if (workflow.opensInViewer) ({ actions.onOpenWorkflow(workflow) }) else null,
                        modifier = Modifier.testTag(SessionSkillsTags.workflow(workflow.path)),
                    )
                }
            }
        }
    }
}

@Composable
private fun SearchField(query: String, onChange: (String) -> Unit) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(12.dp)
    Box(Modifier.fillMaxWidth().contentMaxWidth(LocalWindowLayout.current).padding(start = 16.dp, end = 16.dp, top = 12.dp)) {
        Row(
            Modifier.fillMaxWidth().background(colors.input.background, shape).border(0.5.dp, colors.divider, shape)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Ionicon.SearchOutline, 20.dp, colors.textSecondary)
            Spacer(Modifier.width(8.dp))
            BasicTextField(
                query,
                onValueChange = onChange,
                singleLine = true,
                textStyle = happyTextStyle(16).copy(color = colors.input.text),
                cursorBrush = SolidColor(colors.text),
                modifier = Modifier.weight(1f).testTag(SessionSkillsTags.SEARCH),
                decorationBox = { field ->
                    Box {
                        if (query.isEmpty()) Text(stringResource(R.string.skills_search), style = happyTextStyle(16), color = colors.input.placeholder)
                        field()
                    }
                },
            )
            if (query.isNotEmpty()) {
                Spacer(Modifier.width(8.dp))
                HeaderIconButton(Ionicon.CloseCircle, stringResource(R.string.skills_clear_search), { onChange("") }, iconSize = 20.dp, buttonSize = 20.dp)
            }
        }
    }
}

/** Session info's row: how many skills, commands and MCP servers Claude reported, or that it hasn't yet. */
@Composable
internal fun skillsSummary(catalog: SkillsCatalog): String {
    if (!catalog.reported) return stringResource(R.string.skills_row_not_reported)
    return listOf(
        pluralResource(R.plurals.skills_count_skills, catalog.skills.size, catalog.skills.size),
        pluralResource(R.plurals.skills_count_commands, catalog.commands.size, catalog.commands.size),
        pluralResource(R.plurals.skills_count_servers, catalog.servers.size, catalog.servers.size),
    ).joinToString(" · ")
}

/** The session's stored metadata, boxed so "read, and there is none" isn't the flow's initial null. */
private fun HappyStore.metadataOf(sessionId: String) =
    versions.map { it.sessions }.distinctUntilChanged().map { StoredMetadata(SessionMetadata.parse(session(sessionId)?.metadataJson)) }
        .distinctUntilChanged().flowOn(Dispatchers.IO)

private data class StoredMetadata(val metadata: SessionMetadata?)

/**
 * The route: the session's stored metadata, live, and its saved workflows,
 * asked once when the screen opens (and again on retry). Inserting writes
 * the session's composer draft ([com.slopus.happy.sync.SessionComposer.setText]),
 * which the chat's composer follows, then goes back to that chat.
 */
@Composable
internal fun SessionSkillsRouteScreen(graph: AppGraph, id: String, nav: NavHostController) {
    val account by graph.account.collectAsStateWithLifecycle()
    val metadataFlow = remember(graph, id) { graph.store.metadataOf(id) }
    val read by metadataFlow.collectAsStateWithLifecycle(null)
    val catalog = remember(read) { read?.let { (metadata) -> SkillsCatalog.of(metadata) } }
    var attempt by remember { mutableIntStateOf(0) }
    val workflows by produceState<WorkflowsState>(WorkflowsState.Loading, account, id, attempt) {
        val ops = account?.sessionOps
        value = WorkflowsState.Loading
        value = if (ops == null) WorkflowsState.Failed(null) else WorkflowsState.of(ops.listWorkflows(id))
    }
    val scope = rememberCoroutineScope()
    val actions = remember(nav, account, id) {
        SessionSkillsActions(
            onBack = { nav.popBackStack() },
            onInsert = { name ->
                val composer = account?.composer
                scope.launch {
                    if (composer != null) {
                        val draft = composer.mirrors.value[id]?.draft.orEmpty()
                        composer.setText(id, SkillsCatalog.withCommand(draft, name))
                    }
                    nav.backToChat(id)
                }
            },
            onOpenWorkflow = { workflow -> nav.navigate(SessionFileRoute(id, workflow.path)) },
            onRetryWorkflows = { attempt++ },
        )
    }
    SessionSkillsScreen(catalog, workflows, actions)
}

/**
 * Back to the session's chat from this screen: past session info and onto
 * the chat under it, or, when session info was opened from elsewhere (home's
 * Details), to the chat opened in their place.
 */
internal fun NavHostController.backToChat(sessionId: String) {
    popBackStack()
    if (currentBackStackEntry?.destination?.hasRoute<SessionInfoRoute>() == true) popBackStack()
    val top = currentBackStackEntry
    val onChat = top?.destination?.hasRoute<SessionRoute>() == true && top.toRoute<SessionRoute>().id == sessionId
    if (!onChat) navigate(SessionRoute(sessionId))
}
