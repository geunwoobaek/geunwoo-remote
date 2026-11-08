package com.slopus.happy.ui.files

import com.slopus.happy.ui.page
import android.content.ClipData
import android.widget.Toast
import androidx.compose.ui.platform.LocalContext
import com.slopus.happy.sync.SendResult
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.BuildConfig
import com.slopus.happy.R
import com.slopus.happy.chat.ChatFeed
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatState
import com.slopus.happy.chat.NoLivePresence
import com.slopus.happy.chat.StoreChatMessagesSource
import com.slopus.happy.chat.StoreChatSessionSource
import com.slopus.happy.chat.SyncChatMessagesSource
import com.slopus.happy.chat.SyncChatPresenceSource
import com.slopus.happy.chat.str
import com.slopus.happy.data.HappyStore
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.gitStatusKey
import com.slopus.happy.model.isRig
import com.slopus.happy.sync.HappyAgentGit
import com.slopus.happy.text.Words
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import android.text.format.DateUtils
import androidx.compose.runtime.saveable.rememberSaveable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

/** `/session/{id}/changes?file=`: the session's changes, scrolled to [file] when set. */
@Serializable data class SessionChangesRoute(val id: String, val file: String? = null)

/** `/session/{id}/file?path=&line=&column=`: one file and its uncommitted diff. */
@Serializable data class SessionFileRoute(val id: String, val path: String, val line: Int? = null, val column: Int? = null)

/** `/session/{id}/message/{messageId}?file=`: one message in full; [file] narrows a patch to the file tapped. */
@Serializable data class MessageDetailRoute(val id: String, val messageId: String, val file: String? = null)

/** `/session/{id}/folder?path=`: one folder of a Happy session's computer, [path] absolute ("" is the session's folder). */
@Serializable data class SessionFolderRoute(val id: String, val path: String = "")

/** One folder of an agent connection's workspace, [path] relative to its root ("" is the root). */
@Serializable data class WorkspaceFilesRoute(val connectionId: String, val workspaceId: String, val path: String = "")

/**
 * One file of an agent connection's workspace, at [line] when given: in
 * [workspaceId], or in the workspace [agentId] works in (a
 * `happy-file://agents/<id>/<path>` link). [path] is relative to its root.
 */
@Serializable data class WorkspaceFileRoute(
    val connectionId: String,
    val path: String,
    val workspaceId: String? = null,
    val agentId: String? = null,
    val line: Int? = null,
)

/**
 * Opens a workspace file in the viewer, over whatever is up: the entry for
 * `happy-file://workspaces/<workspaceId>/<path>#L<line>` and
 * `happy-file://agents/<agentId>/<path>#L<line>` links. Give one of
 * [workspaceId] and [agentId]; [path] is relative to the workspace root.
 */
fun NavHostController.openWorkspaceFile(connectionId: String, path: String, workspaceId: String? = null, agentId: String? = null, line: Int? = null) {
    require(workspaceId != null || agentId != null) { "A workspace file needs its workspace or agent" }
    navigate(WorkspaceFileRoute(connectionId, path.trimStart('/'), workspaceId, agentId, line?.takeIf { it > 0 }))
}

/** `/text-selection?textId=`: text stored with [TempText.store]. */
@Serializable data class TextSelectionRoute(val textId: String)

/**
 * ToolView.tsx `handlePress`: Edit, MultiEdit and Write open the file they
 * changed, and Read a picture, recording or page it looked at; every other
 * tool opens its message.
 */
fun toolPressRoute(sessionId: String, message: ChatMessage.ToolCallMessage): Any {
    val tool = message.tool
    val named = (tool.input as? kotlinx.serialization.json.JsonObject)?.get("file_path").str
    val path = when (tool.name) {
        "Edit", "MultiEdit", "Write" -> named
        "Read" -> named?.takeIf { SessionMedia.kindOf(it) != null }
        else -> null
    }
    return if (path != null) SessionFileRoute(sessionId, path) else MessageDetailRoute(sessionId, message.id)
}

fun NavGraphBuilder.filesRoutes(graph: AppGraph, nav: NavHostController) {
    page<SessionChangesRoute> { entry ->
        val route = entry.toRoute<SessionChangesRoute>()
        ChangesRouteScreen(graph, route.id, route.file, onBack = { nav.popBackStack() })
    }
    page<SessionFileRoute> { entry ->
        val route = entry.toRoute<SessionFileRoute>()
        FileRouteScreen(graph, route, onBack = { nav.popBackStack() })
    }
    page<MessageDetailRoute> { entry ->
        val route = entry.toRoute<MessageDetailRoute>()
        MessageDetailRouteScreen(graph, route, onBack = { nav.popBackStack() })
    }
    page<SessionFolderRoute> { entry ->
        val route = entry.toRoute<SessionFolderRoute>()
        SessionFolderRouteScreen(graph, route, nav)
    }
    page<WorkspaceFilesRoute> { entry ->
        val route = entry.toRoute<WorkspaceFilesRoute>()
        WorkspaceFilesEntry(graph, route, nav)
    }
    page<WorkspaceFileRoute> { entry ->
        val route = entry.toRoute<WorkspaceFileRoute>()
        WorkspaceFileEntry(graph, route, onBack = { nav.popBackStack() })
    }
    page<TextSelectionRoute> { entry ->
        val route = entry.toRoute<TextSelectionRoute>()
        TextSelectionRouteScreen(route.textId, onBack = { nav.popBackStack() })
    }
}

private fun HappyStore.metadataFlow(sessionId: String): Flow<SessionMetadata?> =
    versions.map { it.sessions }.distinctUntilChanged().map { SessionMetadata.parse(session(sessionId)?.metadataJson) }
        .distinctUntilChanged().flowOn(Dispatchers.IO)

/** A session's metadata as stored, and whether the store has answered yet. */
@Composable
private fun rememberMetadata(graph: AppGraph, sessionId: String): Pair<Boolean, SessionMetadata?> {
    val flow = remember(sessionId) { graph.store.metadataFlow(sessionId).map { true to it } }
    val value by flow.collectAsStateWithLifecycle(false to null)
    return value
}

/**
 * A session's folder, a level at a time: folders first, a folder opens the
 * next level, a file opens in the viewer (pictures, recordings and pages
 * included). The root is the session's working folder.
 */
@Composable
private fun SessionFolderRouteScreen(graph: AppGraph, route: SessionFolderRoute, nav: NavHostController) {
    val account by graph.account.collectAsStateWithLifecycle()
    val (loaded, metadata) = rememberMetadata(graph, route.id)
    val dir = route.path.ifEmpty { metadata?.path.orEmpty() }
    val sync = account
    val scope = rememberCoroutineScope()
    val folder = remember(sync, dir) {
        WorkspaceFolder(scope, { path, _ ->
            val ops = sync?.sessionOps ?: throw IllegalStateException()
            SessionFolder.page(path, ops.listDirectory(route.id, path))
        }, dir)
    }
    LaunchedEffect(folder, loaded) { if (loaded && dir.isNotEmpty()) folder.open() }
    val state by folder.state.collectAsStateWithLifecycle()
    WorkspaceFilesScreen(
        title = if (dir.isEmpty()) stringResource(R.string.common_files) else SessionFolder.title(dir),
        state = when {
            sync == null || (loaded && dir.isEmpty()) -> WorkspaceFolder.State(loading = false, error = Words.ours(R.string.files_load_failed))
            else -> state
        },
        onBack = { nav.popBackStack() },
        onOpen = { entry ->
            if (entry.directory) nav.navigate(SessionFolderRoute(route.id, entry.path))
            else nav.navigate(SessionFileRoute(route.id, entry.path))
        },
        onRetry = folder::open,
        onMore = folder::more,
    )
}

@Composable
private fun ChangesRouteScreen(graph: AppGraph, sessionId: String, file: String?, onBack: () -> Unit) {
    val account by graph.account.collectAsStateWithLifecycle()
    val (_, metadata) = rememberMetadata(graph, sessionId)
    val scope = rememberCoroutineScope()
    val sync = account
    val ops = remember(sync) { sync?.let(::SyncSessionFileOps) }
    // Opened outside the chat: tell sync the session is on screen so its state stays fresh.
    LaunchedEffect(sync, sessionId) { sync?.messages?.onSessionVisible(sessionId) }
    val rig = metadata?.isRig()
    val legacy = remember(ops, sessionId, rig, metadata?.path, metadata?.machineId) {
        if (ops != null && sync != null && rig == false) {
            LegacyChanges(scope, ops, sessionId, metadata.path, sync.fileCache, gitStatusKey(metadata.machineId, metadata.path))
        } else {
            null
        }
    }
    val agent = remember(ops, sessionId, rig) {
        if (ops != null && rig == true) AgentChanges(scope, ops, sessionId, HappyAgentGit.supportsHappyAgentGit(metadata)) else null
    }
    // Every return to the screen reads git again (useFocusEffect).
    LifecycleResumeEffect(legacy, agent) {
        legacy?.refresh()
        agent?.refresh()
        onPauseOrDispose { }
    }
    val content = when {
        legacy != null -> ChangesContent.Legacy(legacy.state.collectAsStateWithLifecycle().value)
        agent != null -> ChangesContent.Agent(agent.state.collectAsStateWithLifecycle().value, agent.supported)
        else -> ChangesContent.Loading
    }
    ChangesScreen(
        content,
        ChangesActions(
            onBack = onBack,
            onExpandContext = { path -> legacy?.expandContext(path); agent?.expandContext(path) },
            onRequestContent = { path -> agent?.requestContent(path) },
            onRetry = { agent?.refresh() },
        ),
        scrollToFile = file,
    )
}

@Composable
private fun FileRouteScreen(graph: AppGraph, route: SessionFileRoute, onBack: () -> Unit) {
    val account by graph.account.collectAsStateWithLifecycle()
    val (loaded, metadata) = rememberMetadata(graph, route.id)
    val sessionPath = metadata?.path
    val resolved = remember(route.path, sessionPath) { SessionFilePaths.resolve(route.path, sessionPath) }
    val named = resolved?.absolutePath ?: route.path
    val sync = account
    val context = LocalContext.current
    // The chat names the path in the session's folder; the agent may have written it in a worktree.
    val located by produceState<WorktreeLookup.Located?>(null, sync, loaded, named, sessionPath) {
        if (sync == null || !loaded) return@produceState
        value = WorktreeLookup.locate(sessionPath, named) { dir -> sync.sessionOps.listDirectory(route.id, dir) }
    }
    var picked by rememberSaveable(route.path) { mutableStateOf<String?>(null) }
    val copies = (located as? WorktreeLookup.Located.InWorktrees)?.copies
    if (copies != null && copies.size > 1 && picked == null) {
        WorktreeChoiceScreen(named.substringAfterLast('/'), copies, onBack) { picked = it }
        return
    }
    val found = picked ?: when (val where = located) {
        null -> null
        is WorktreeLookup.Located.Here -> where.path
        is WorktreeLookup.Located.InWorktrees -> where.copies.first().path
    }
    val filePath = found ?: named
    // A copy in a worktree isn't the session folder's file, so the folder's git diff doesn't apply to it.
    val gitDiffPath = resolved?.takeIf { it.withinSessionRoot && found == named }?.relativePath
    val load by produceState<FileLoad>(FileLoad.Loading, sync, loaded, found, gitDiffPath) {
        if (sync == null || !loaded || found == null) return@produceState
        SyncSessionFileOps(sync).fileLoads(sync.fileCache, route.id, found, sessionPath, gitDiffPath, context.cacheDir).collect { value = it }
    }
    val scope = rememberCoroutineScope()
    val ops = remember(sync) { sync?.let(::SyncSessionFileOps) }
    FileScreen(
        load, filePath, onBack, route.line, route.column,
        readAsset = ops?.let { files -> { path -> files.readBytes(route.id, path) } },
        // A page in the session's folder reads anywhere in it (`../style.css`); one outside, only beside itself.
        assetRoot = sessionPath?.takeIf { resolved?.withinSessionRoot == true },
        onMemo = sync?.let { account ->
            { quote, note ->
                val text = memoMessage(context.resources, filePath, quote, note)
                scope.launch {
                    val said = when (val result = account.sender.send(route.id, text)) {
                        is SendResult.Accepted -> context.getString(R.string.file_memo_sent)
                        is SendResult.NotSent -> context.getString(R.string.file_memo_failed, result.message.orEmpty())
                    }
                    Toast.makeText(context, said, Toast.LENGTH_SHORT).show()
                }
            }
        },
    )
}

/**
 * The file the chat named is in several of the session's worktrees and not
 * in its folder: one row per worktree, the most recently changed first, and
 * a tap opens that copy.
 */
@Composable
private fun WorktreeChoiceScreen(name: String, copies: List<WorktreeLookup.Copy>, onBack: () -> Unit, onPick: (String) -> Unit) {
    Screen(header = { StackHeader(name, onBack) }) {
        ItemList {
            ItemGroup(title = stringResource(R.string.files_in_worktrees_title), footer = stringResource(R.string.files_in_worktrees_footer)) {
                copies.forEach { copy ->
                    Item(
                        title = copy.worktree,
                        subtitle = copy.modified?.let { DateUtils.getRelativeTimeSpanString(it.toLong()).toString() },
                        onClick = { onPick(copy.path) },
                    )
                }
            }
        }
    }
}

/** [path]'s bytes from the computer a slice at a time ([readMediaBytes]), or null when it can't be read. */
private suspend fun SessionFileOps.readBytes(sessionId: String, path: String): ByteArray? =
    runCatching { kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { readMediaBytes(sessionId, path) } }.getOrNull()

/** The message and the nested sub-agent messages under it, by id. */
private fun findMessage(rows: List<ChatMessage>, id: String): ChatMessage? {
    for (message in rows) {
        if (message.id == id) return message
        if (message is ChatMessage.ToolCallMessage) findMessage(message.children, id)?.let { return it }
    }
    return null
}

@Composable
private fun MessageDetailRouteScreen(graph: AppGraph, route: MessageDetailRoute, onBack: () -> Unit) {
    val account by graph.account.collectAsStateWithLifecycle()
    val feed = remember(account) {
        val sync = account
        ChatFeed(
            messages = sync?.let { SyncChatMessagesSource(it.messages, it.sender) } ?: StoreChatMessagesSource(graph.store),
            sessions = StoreChatSessionSource(graph.store),
            presence = sync?.let { SyncChatPresenceSource(it.presence) } ?: NoLivePresence,
        )
    }
    val state by remember(feed, route.id) { feed.state(route.id) }.collectAsStateWithLifecycle(ChatState())
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    val local by graph.localSettings.values.collectAsStateWithLifecycle()
    val message = remember(state.snapshot.rows, route.messageId) { findMessage(state.snapshot.rows.map { it.message }, route.messageId) }
    val loaded = state.sessionLoaded && state.session != null && state.snapshot.loaded
    // A message that is gone once everything has loaded: nothing to show, go back.
    LaunchedEffect(loaded, message) { if (loaded && message == null) onBack() }
    MessageDetailScreen(
        message = message,
        loaded = loaded,
        env = MessageDetailEnvironment(
            path = state.session?.metadata?.path,
            flavor = state.session?.metadata?.flavor,
            showLineNumbers = settings.showLineNumbersInToolViews,
            devMode = BuildConfig.DEBUG || local.devModeEnabled,
        ),
        onBack = onBack,
        focusFile = route.file,
    )
}

@Composable
private fun TextSelectionRouteScreen(textId: String, onBack: () -> Unit) {
    val text = remember(textId) { TempText.retrieve(textId) }
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var alert by remember { mutableStateOf<Pair<Alert, Boolean>?>(null) }
    val error = stringResource(R.string.common_error)
    val ok = stringResource(R.string.common_ok)
    val notFound = stringResource(R.string.text_selection_text_not_found)
    val copied = stringResource(R.string.text_selection_text_copied)
    val failed = stringResource(R.string.text_selection_failed_to_copy)
    val noText = stringResource(R.string.text_selection_no_text_to_copy)
    LaunchedEffect(textId) {
        if (text == null) alert = Alert(error, notFound, listOf(AlertButton(ok))) to true
    }
    TextSelectionScreen(
        text = text.orEmpty(),
        onBack = onBack,
        onCopy = {
            if (text.isNullOrEmpty()) {
                alert = Alert(error, noText, listOf(AlertButton(ok))) to false
            } else {
                scope.launch {
                    alert = try {
                        withContext(Dispatchers.Main) { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(text, text))) }
                        Alert(copied, null, listOf(AlertButton(ok))) to false
                    } catch (_: Exception) {
                        Alert(error, failed, listOf(AlertButton(ok))) to false
                    }
                }
            }
        },
    )
    alert?.let { (shown, back) ->
        HappyAlert(shown, onDismiss = {
            alert = null
            if (back) onBack()
        })
    }
}
