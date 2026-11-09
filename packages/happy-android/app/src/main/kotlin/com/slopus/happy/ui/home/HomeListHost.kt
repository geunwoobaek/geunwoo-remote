package com.slopus.happy.ui.home

import com.slopus.happy.ui.migration.MigrationPath

import androidx.compose.runtime.rememberCoroutineScope
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.slopus.happy.model.displayName
import com.slopus.happy.model.isRigMachine
import com.slopus.happy.sync.OpenClaudeAgentResult
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import com.slopus.happy.ui.rememberHomeAccountSwitch
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.flow.distinctUntilChanged
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.AppGraph
import com.slopus.happy.BuildConfig
import com.slopus.happy.R
import com.slopus.happy.ui.connect.EnterTerminalUrlPrompt
import com.slopus.happy.ui.connect.rememberTerminalConnect
import com.slopus.happy.model.Session
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.model.WorkspaceOrigin
import com.slopus.happy.model.forkSource
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.ui.changelog.Changelog
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.confirm
import com.slopus.happy.ui.session.DuplicateSheet

/** What [HomeListHost] hands its content: the list's state and its wiring. */
class HomeListScope(
    val state: HomeListState?,
    val connectionStatus: ConnectionStatus,
    val grouping: SessionListGrouping,
    val callbacks: HomeListCallbacks,
    val actions: HomeScreenActions,
    val update: HomeUpdate?,
    val navigation: HomeNavigation,
    /**
     * Where the list sits, held above the host so the breakpoint's swap of
     * phone list for sidebar list keeps the reader's place.
     */
    val listState: LazyListState,
    val syncing: Boolean = false,
    /** The migration card over the list, if it shows. */
    val migration: MigrationPath? = null,
    /** The Mac's background Claude sessions, over the chats. */
    val claudeAgents: ClaudeAgentsUi? = null,
    /** Pull to refresh: syncs, and lists the Mac's background sessions again. */
    val onRefresh: (suspend () -> Unit)? = null,
)

/**
 * The home list's state, row callbacks, session menus and their alerts and
 * sheets, around [content]. A project's "+" prepares a new workspace of it
 * and opens an empty chat on it (compose), in the tablet's detail pane too.
 * [phone]: the phone home, which alone asks for a review.
 */
@Composable
fun HomeListHost(graph: AppGraph, navigation: HomeNavigation, phone: Boolean = false, content: @Composable (HomeListScope) -> Unit) {
    val onOpenSession = navigation.onOpenSession
    val services = remember(graph) { HomeServices.of(graph) }
    val state by services.list.state.collectAsStateWithLifecycle()
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    val local by graph.localSettings.values.collectAsStateWithLifecycle()
    val connection by graph.connectionStatus.collectAsStateWithLifecycle()
    val syncing by graph.isSyncing.collectAsStateWithLifecycle()
    val registry by graph.accountStore.registry.collectAsStateWithLifecycle()
    val updateUrl by services.updateUrl.collectAsStateWithLifecycle()
    val resources = LocalResources.current
    val latestChangelog = remember(resources) { Changelog.bundled(resources).latestTitle }
    val lastViewedChangelog by graph.changelog.lastViewedTitle.collectAsStateWithLifecycle()
    // useChangelog: a first install has seen everything so far; only what comes later is news.
    LaunchedEffect(latestChangelog) {
        if (graph.changelog.lastViewedTitle.value.isEmpty() && latestChangelog.isNotEmpty()) graph.changelog.markViewed(latestChangelog)
    }
    val update = HomeUpdate.resolve(updateUrl, lastViewedChangelog.isNotEmpty() && graph.changelog.hasUnread(latestChangelog))
    // PostHog's flag brings the migration card; a paired Happy Agent takes it away; its x hides that path's card on this phone.
    val migrationNote by graph.migrationNote.collectAsStateWithLifecycle()
    val agents by graph.agentConnections.accounts.collectAsStateWithLifecycle()
    val closedMigrations by graph.desktopMigration.closed.collectAsStateWithLifecycle()
    val migration = MigrationPath.shown(migrationNote, agents, serverAgent = state?.hasServerAgent == true, closed = closedMigrations)
    val uriHandler = LocalUriHandler.current
    var alert by remember { mutableStateOf<Alert?>(null) }
    val showAlert = remember { { next: Alert -> alert = next } }
    var duplicating by remember { mutableStateOf<Session?>(null) }
    val menus = rememberSessionMenus(
        services = services,
        continuationExperiments = settings.expResumeSession,
        devMode = BuildConfig.DEBUG || local.devModeEnabled,
        onOpenSession = onOpenSession,
        onDetails = navigation.onDetails,
        onDuplicate = { duplicating = it },
        showAlert = showAlert,
    )
    // A refusal no screen waited on, said once here (iOS a4049a03a).
    val refusal by services.archiver.refusal.collectAsStateWithLifecycle()
    LaunchedEffect(refusal, menus) {
        refusal?.let { menus.report(it); services.archiver.heard() }
    }
    val context = LocalContext.current
    // ProjectHomeList's "+": an empty chat on a new workspace of that project, on the phone and in the tablet's detail.
    val onCreateWorkspace = remember(services, context, navigation) {
        { origin: WorkspaceOrigin ->
            services.newSession(context.applicationContext).prepareWorkspace(origin.machineId, origin.projectId, origin.path)
            navigation.onCompose()
        }
    }
    // SessionsList's requestReview(), once its list has sessions.
    val reviewable = asksForReview(state, phone = phone)
    val reviewStrings = ReviewStrings(
        title = stringResource(R.string.review_enjoying_app),
        message = stringResource(R.string.review_feedback_prompt),
        yes = stringResource(R.string.review_yes_i_love_it),
        no = stringResource(R.string.review_not_really),
    )
    LaunchedEffect(reviewable) {
        if (!reviewable) return@LaunchedEffect
        val activity = context.findActivity() ?: return@LaunchedEffect
        val (prompter, store) = services.review(context.applicationContext)
        prompter.run(
            isAvailable = store::isAvailable,
            ask = { confirm(showAlert, reviewStrings.title, reviewStrings.message, confirmText = reviewStrings.yes, cancelText = reviewStrings.no) },
            review = { store.request(activity) },
        )
    }
    val createWorkspaceLabel = stringResource(R.string.home_create_workspace)
    val cancelLabel = stringResource(R.string.common_cancel)

    val callbacks = remember(services, menus, navigation) {
        HomeListCallbacks(
            onOpen = onOpenSession,
            onMenu = menus::open,
            onArchive = menus::swipe,
            onSetArchiveHidden = { hidden -> graph.settings.change { it.copy(hideInactiveSessions = hidden) } },
            onToggleProject = { id ->
                graph.localSettings.change { it.copy(expandedProjects = it.expandedProjects + (id to it.expandedProjects[id].let { open -> open != true })) }
            },
            onOpenMachine = navigation.onOpenMachine,
            onCreateWorkspace = onCreateWorkspace,
            onProjectMenu = { name, origin ->
                alert = Alert(name, null, listOf(AlertButton(cancelLabel), AlertButton(createWorkspaceLabel) { onCreateWorkspace(origin) }))
            },
            onPressDown = { id -> graph.account.value?.messages?.preload(id) },
        )
    }
    // Linking from the empty home approves the code with this account, as Settings' scan does (not
    // Add, which makes a new account); without a scanner it asks for the link instead.
    val connect = rememberTerminalConnect(graph)
    var enteringUrl by remember { mutableStateOf(false) }
    connect.onUnavailable = { enteringUrl = true }
    val switchAccount = rememberHomeAccountSwitch(graph)
    val actions = remember(navigation, uriHandler, connect, switchAccount) {
        HomeScreenActions(
            onSettings = navigation.onSettings,
            onNewSession = navigation.onNewSession,
            onTroubleshoot = navigation.onTroubleshoot,
            onOpenUrl = uriHandler::openUri,
            onWhatsNew = navigation.onWhatsNew,
            onSwitchAccount = switchAccount,
            onLinkComputer = connect::scan,
            onCompose = navigation.onCompose,
            onMigration = navigation.onMigration,
            onCloseMigration = graph.desktopMigration::close,
            onSearch = navigation.onSearch,
        )
    }

    // The breakpoint swaps this host for the sidebar's and back, taking the list with it, so the
    // place it was at is kept in the services and the rebuilt list opens there (SessionScreenSlots'
    // tab strip does the same). Keyed by account: switching never lands on another account's place.
    val accountKey = registry.activeId.orEmpty()
    val listState = remember(accountKey) {
        val saved = services.homeListOffsets[accountKey]
        LazyListState(saved?.first ?: 0, saved?.second ?: 0)
    }
    LaunchedEffect(listState, accountKey) {
        snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }
            .distinctUntilChanged()
            .collect { services.homeListOffsets[accountKey] = it }
    }

    // The Mac's background Claude sessions: listed when home is shown and on pull to refresh, never on a timer.
    val snapshot by services.snapshots.collectAsStateWithLifecycle()
    val agentsModel = remember(services) { ClaudeAgentsModel { services.machineOps } }
    val agentListings by agentsModel.listings.collectAsStateWithLifecycle()
    val agentsOpening by agentsModel.opening.collectAsStateWithLifecycle()
    // Happy Agent machines (rig) have no such daemon.
    val agentMachines = remember(snapshot?.machines) { snapshot?.machines.orEmpty().filter { it.isOnline && !it.metadata.isRigMachine() } }
    val agentMachineIds = remember(agentMachines) { agentMachines.map { it.id } }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(agentsModel, agentMachineIds, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { agentsModel.refresh(agentMachineIds) }
    }
    // A mirror that is live in the list has its own row; one whose row sits in the archive is still opened from here.
    val liveSessionIds = remember(snapshot?.sessions) { snapshot?.sessions.orEmpty().filter { it.active }.mapTo(HashSet()) { it.id } }
    val agentBlocks = remember(agentMachines, agentListings, liveSessionIds) {
        claudeAgentBlocks(agentMachineIds, agentMachines.associate { it.id to it.displayName() }, agentListings, liveSessionIds)
    }
    val openScope = rememberCoroutineScope()
    val errorTitle = stringResource(R.string.common_error)
    val okLabel = stringResource(R.string.common_ok)
    val claudeAgents = remember(agentBlocks, agentsOpening, agentsModel, onOpenSession, errorTitle, okLabel) {
        ClaudeAgentsUi(agentBlocks, agentsOpening) { machineId, agentId ->
            openScope.launch {
                when (val result = agentsModel.open(machineId, agentId)) {
                    null -> Unit
                    is OpenClaudeAgentResult.Success -> onOpenSession(result.sessionId)
                    is OpenClaudeAgentResult.Error ->
                        showAlert(Alert(errorTitle, result.message.ifEmpty { errorTitle }, listOf(AlertButton(okLabel))))
                }
            }
        }
    }
    val refresh = remember(agentsModel, agentMachineIds, graph) {
        suspend {
            coroutineScope {
                launch { graph.account.value?.syncNow() }
                agentsModel.refresh(agentMachineIds)
            }
        }
    }

    ProvideAvatarSettings(settings) {
        content(HomeListScope(state, connection, settings.sessionListGrouping, callbacks, actions, update, navigation, listState, syncing, migration, claudeAgents, refresh))
    }
    duplicating?.let { session ->
        DuplicateSheet(
            source = session.forkSource(),
            continuations = services.continuations,
            onDismiss = { duplicating = null },
            onDuplicated = onOpenSession,
        )
    }
    if (enteringUrl) EnterTerminalUrlPrompt(connect, onDismiss = { enteringUrl = false })
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}
