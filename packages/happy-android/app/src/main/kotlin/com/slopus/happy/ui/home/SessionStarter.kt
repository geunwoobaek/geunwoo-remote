package com.slopus.happy.ui.home

import androidx.annotation.StringRes
import com.slopus.happy.R
import com.slopus.happy.attachments.AttachmentNotice
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.model.AgentType
import com.slopus.happy.model.BotRequest
import com.slopus.happy.model.Machine
import com.slopus.happy.model.NewSessionDraft
import com.slopus.happy.model.RigModeOption
import com.slopus.happy.model.RigModelOption
import com.slopus.happy.model.RigSpawnException
import com.slopus.happy.model.Session
import com.slopus.happy.model.SessionType
import com.slopus.happy.model.Settings
import com.slopus.happy.model.SpawnTargetOverride
import com.slopus.happy.model.StartPhase
import com.slopus.happy.model.UnavailableWorkspaceException
import com.slopus.happy.model.WorktreeSelection
import com.slopus.happy.model.collectMachineChoices
import com.slopus.happy.model.collectSessionPlaces
import com.slopus.happy.model.collectSessionWorkspaces
import com.slopus.happy.model.describeBotNameProblem
import com.slopus.happy.model.findMachineChoice
import com.slopus.happy.model.resolveAbsolutePath
import com.slopus.happy.model.resolveAgentMachine
import com.slopus.happy.model.resolveHappyAgentSpawnTarget
import com.slopus.happy.model.resolveNewSessionAgent
import com.slopus.happy.model.resolveRigPendingRetryDelayMs
import com.slopus.happy.model.resolveWorktreeCreationMachine
import com.slopus.happy.model.rigSessionCreation
import com.slopus.happy.model.settings.AgentDefaults
import com.slopus.happy.model.spawnConfiguration
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.sync.HappyAgentSpawnTarget
import com.slopus.happy.sync.SpawnSessionOptions
import com.slopus.happy.sync.SpawnSessionResult
import com.slopus.happy.sync.StartClaudeAgentRequest
import com.slopus.happy.sync.StartClaudeAgentResult
import com.slopus.happy.sync.claudeAgentName
import com.slopus.happy.sync.claudeAgentNameFromMessage
import com.slopus.happy.text.Words
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Why a start was refused before a session was made
 * (useStartSessionFromDraft's alerts): [message] in English for logs and
 * tests, [text] what the person reads, in their language, and [words] that
 * text with its arguments.
 */
sealed class StartRefusal(val message: String, @StringRes val text: Int) {
    open val words: Words get() = Words.ours(text)

    data object NoMachine : StartRefusal("Please select a machine", R.string.home_start_no_machine)
    data object UnknownMachine : StartRefusal(
        "This session’s computer is not registered with this account, so nothing can start a session on it. Check that Jarvis is running there and signed in to this account.",
        R.string.home_start_unknown_machine,
    )
    data object HappyAgentMissing : StartRefusal("Happy Agent is not running on this computer", R.string.home_start_happy_agent_missing)
    data object HappyCliMissing : StartRefusal("Jarvis CLI is not available on your computer. Run `happy daemon start` on your computer, then try again.", R.string.home_start_happy_cli_missing)
    data object HappyAgentOffline : StartRefusal("Machine is offline", R.string.new_session_machine_offline)
    data object HappyCliOffline : StartRefusal("Jarvis CLI is offline on your computer. Run `happy daemon start` on your computer, then try again.", R.string.home_start_happy_cli_offline)
    data object CannotStartHappyAgent : StartRefusal("This machine cannot start Happy Agent sessions", R.string.home_start_cannot_start_happy_agent)
    data object ProjectNeedsHappyAgent : StartRefusal(
        "Only Happy Agent knows where this project is, so no other harness can open it. Switch the harness back to Happy Agent, or pick the project’s folder.",
        R.string.home_start_project_needs_happy_agent,
    )
    data object WorkspaceUnavailable : StartRefusal("The selected Happy Agent workspace is no longer available.", R.string.home_start_workspace_unavailable)
    data object BotsUnsupported : StartRefusal("Happy Agent on this computer cannot create bots yet. Update it and try again.", R.string.home_start_bots_unsupported)
    data object TasksUnsupported : StartRefusal("Happy Agent on this computer cannot create tasks yet. Update it and try again.", R.string.compose_tasks_unsupported)

    /**
     * Claude on the Mac has not been trusted in [directory] yet, so no
     * background session can start there; the Mac said so. Starting again
     * with `forceRegular` opens the chat as a regular session instead.
     */
    data class UntrustedFolder(val directory: String) : StartRefusal(
        "Claude on the Mac doesn't trust $directory yet. Open a terminal there, run `claude` once and accept the prompt, then try again.",
        R.string.home_start_untrusted_folder_body,
    ) {
        override val words: Words get() = Words.ours(text, directory)
    }
}

sealed interface StartResult {
    /** [notices]: what the first message's images ran into (an upload that failed). */
    data class Started(
        val sessionId: String,
        val notices: List<AttachmentNotice> = emptyList(),
        /** A bot that came without its face: offerBotFaceRetry. */
        val faceFailure: BotFaceFailure? = null,
    ) : StartResult
    data class Refused(val refusal: StartRefusal) : StartResult
    /** The machine, git or the server said no; [message] in their words, or ours where they gave none. */
    data class Failed(val message: Words) : StartResult
    /** The session is there but the first message is not: the agent takes no images. Send again reuses it. */
    data class NotSent(val notices: List<AttachmentNotice>) : StartResult
    /** Stopped, declined, or nothing to send. */
    data object Abandoned : StartResult
}

private const val MAX_PENDING_RESULTS = 20

/** git said no to the worktree; [words] are git's, or ours where it gave none. */
private class WorktreeException(val words: Words) : Exception(words.toString())
private val CONFIGURATION_UNAVAILABLE = Words.ours(R.string.home_start_configuration_unavailable)

/**
 * useStartSessionFromDraft: everything between Send and the new session's
 * screen. The draft is resolved again against the computer as it is now (a
 * stale Claude pick never spawns Claude where only Codex runs), a worktree
 * is created if asked for, the machine is asked for the session (pending
 * answers are retried, a missing directory is offered to be created), the
 * session is awaited, the prompt sent, and the draft's text cleared if it
 * wasn't edited meanwhile. [phase] says which wait is on. [cancel] hands
 * the composer back at once; a session that arrives afterwards is stopped.
 */
class SessionStarter(
    private val machines: () -> List<Machine>,
    private val sessions: () -> List<Session>,
    private val settings: () -> Settings,
    private val drafts: NewSessionDraftStore,
    private val machineActions: MachineActions,
    private val sessionActions: SessionActions,
    private val sender: FirstMessageSender,
    /** sync.ensureSessionReady: true once the session is in the store. */
    private val awaitSession: suspend (String) -> Boolean,
    private val scope: CoroutineScope,
    private val faces: BotFaceWearer = BotFaceWearer { _, _ -> BotFaceFailure(BotFaceLeg.Painting, "No faces here") },
    private val requestId: () -> String = { UUID.randomUUID().toString() },
) {
    private val phaseState = MutableStateFlow<StartPhase?>(null)
    val phase: StateFlow<StartPhase?> = phaseState.asStateFlow()

    private var run: Job? = null
    private var preparing = false
    private val requestIds = HashMap<String, String>()

    /** Sessions made for a start whose message did not go out: pressing Send again reuses them. */
    private val createdSessions = HashMap<String, Created>()

    fun cancel() {
        val current = run ?: return
        run = null
        phaseState.value = null
        current.cancel()
    }

    /**
     * Starts from the stored draft, or from [draft] when a caller names its
     * own place, with [attachments] going out with the first message.
     * [target] is a Happy Agent destination the caller already knows (a
     * chat opened beside another), used instead of resolving the draft's.
     * [bot] makes a bot on the draft's computer instead: Happy Agent's, then
     * the face, and only with [botMessage] the draft's text and attachments
     * as its first message (a compose chat's; the dock's bot takes none).
     * [task] makes an unnamed task there, the text its first message.
     * [confirmDirectory] asks whether to create a missing directory.
     *
     * A Claude chat (not a bot's, not a task's) starts as a Mac background
     * session when its computer's daemon can start one
     * ([MachineActions.backgroundStartSupported]); [forceRegular] starts it as
     * a regular session anyway (the untrusted folder's alternative).
     */
    suspend fun start(
        draft: NewSessionDraft = drafts.draft.value,
        attachments: List<AttachmentPreview> = emptyList(),
        target: SpawnTargetOverride? = null,
        bot: BotRequest? = null,
        botMessage: Boolean = false,
        task: Boolean = false,
        forceRegular: Boolean = false,
        confirmDirectory: suspend (String) -> Boolean,
    ): StartResult {
        if (run != null || preparing) return StartResult.Abandoned
        bot?.let { request -> describeBotNameProblem(request.name)?.let { return StartResult.Failed(it) } }
        // The path is settled before anything starts; asking the computer may take a moment, and a second Send meanwhile is not a second start.
        preparing = true
        val ready = try {
            prepare(draft, target, bot, task = task && bot == null, botMessage = botMessage, forceRegular = forceRegular)
        } finally {
            preparing = false
        }
        val prepared = when (ready) {
            is Prepared.Refused -> return StartResult.Refused(ready.refusal)
            is Prepared.Unavailable -> return StartResult.Failed(ready.message)
            is Prepared.Ready -> ready
        }
        val outcome = CompletableDeferred<StartResult>()
        val job = scope.launch {
            outcome.complete(
                try {
                    execute(prepared, draft, if (bot != null && !botMessage) emptyList() else attachments, confirmDirectory)
                } catch (e: CancellationException) {
                    StartResult.Abandoned
                } catch (e: WorktreeException) {
                    StartResult.Failed(e.words)
                } catch (e: Exception) {
                    StartResult.Failed(Words.said(e.message, R.string.home_start_failed))
                },
            )
        }
        run = job
        job.invokeOnCompletion {
            if (!outcome.isCompleted) outcome.complete(StartResult.Abandoned)
            if (run === job) {
                run = null
                phaseState.value = null
            }
        }
        return outcome.await()
    }

    private sealed interface Prepared {
        data class Refused(val refusal: StartRefusal) : Prepared
        data class Unavailable(val message: Words) : Prepared
        data class Ready(
            val machine: Machine,
            val agent: AgentType,
            val options: SpawnSessionOptions,
            val worktreeMachine: Machine?,
            val worktreeNew: Boolean,
            val publishedRetryAfterMs: Long?,
            val signature: String,
            /** The code agent's picks, pinned on the session before the send; Happy Agent's ride the spawn. */
            val modes: Map<AgentModeField, String?>?,
            val bot: BotRequest? = null,
            /** The draft's text goes as the first message (a session's, a task's, a compose chat's bot). */
            val sendsMessage: Boolean = true,
            /** A Claude chat started as a Mac background session (`start-claude-agent`), not spawned. */
            val background: Boolean = false,
            /** The background session's name from the first message; null names it after its folder, known once any worktree is made. */
            val agentName: String? = null,
        ) : Prepared
    }

    /** A session the start made; [agentId] is the Mac background session it mirrors, when it is one. */
    private data class Created(val sessionId: String, val agentId: String? = null)

    /** How asking the machine for the session went. */
    private sealed interface Creation {
        data class Made(val created: Created) : Creation
        data class Refused(val refusal: StartRefusal) : Creation
        /** [unanswered]: the call failed before the machine's answer came back; the start may still be running there. */
        data class Failed(val message: Words, val unanswered: Boolean = false) : Creation
        /** A missing directory the person chose not to create. */
        data object Declined : Creation
    }

    /** One pick with its fallbacks, as the hook's resolveOption: the first known key, else the first option. */
    private fun <T> resolveOption(options: List<T>, key: (T) -> String, preferred: List<String?>): T? =
        preferred.firstNotNullOfOrNull { wanted -> wanted?.let { options.find { option -> key(option) == wanted } } } ?: options.firstOrNull()

    private suspend fun prepare(
        draft: NewSessionDraft,
        targetOverride: SpawnTargetOverride?,
        bot: BotRequest? = null,
        task: Boolean = false,
        botMessage: Boolean = false,
        forceRegular: Boolean = false,
    ): Prepared {
        val machines = machines()
        val choice = findMachineChoice(collectMachineChoices(machines), draft.selectedMachineId)
            ?: return Prepared.Refused(if (draft.selectedMachineId != null) StartRefusal.UnknownMachine else StartRefusal.NoMachine)
        // A bot or a task is Happy Agent's to make, whatever harness the draft last chose.
        val agent = if (bot != null || task) AgentType.Rig else resolveNewSessionAgent(choice, draft.agentType, draft.pickedAgentType)
        val agentChanged = agent != draft.agentType
        val rig = agent == AgentType.Rig
        val machine = resolveAgentMachine(choice, agent)
            ?: return Prepared.Refused(if (rig) StartRefusal.HappyAgentMissing else StartRefusal.HappyCliMissing)
        if (!machine.isOnline) return Prepared.Refused(if (rig) StartRefusal.HappyAgentOffline else StartRefusal.HappyCliOffline)
        val rigCreation = if (rig) machine.metadata.rigSessionCreation() ?: return Prepared.Refused(StartRefusal.CannotStartHappyAgent) else null
        if (bot != null && rigCreation?.supportsBots != true) return Prepared.Refused(StartRefusal.BotsUnsupported)
        if (task && rigCreation?.supportsTasks != true) return Prepared.Refused(StartRefusal.TasksUnsupported)

        val draftProjectId = draft.selectedProjectId?.trim()?.takeIf { it.isNotEmpty() }
        if (bot == null && !task && draftProjectId != null && !rig) return Prepared.Refused(StartRefusal.ProjectNeedsHappyAgent)

        val selectedPath = draft.selectedPath?.trim()?.takeIf { it.isNotEmpty() } ?: "~"
        val directory = resolveAbsolutePath(selectedPath, machine.metadata?.homeDir)
        val sessions = sessions()
        val selectedProjectId = draftProjectId
            ?: collectSessionPlaces(choice.machineIds, sessions, selectedPath).find { it.path == selectedPath }?.projectId
        val requestedWorktree = if (draft.sessionType == SessionType.Worktree) draft.worktreeKey ?: WorktreeSelection.NEW else WorktreeSelection.NONE
        // A bot is its own destination, settled before the workspace routes are consulted.
        val target = if (bot != null) {
            HappyAgentSpawnTarget.Bot(bot.name)
        } else if (task) {
            // Unnamed: the daemon names it from its first message.
            HappyAgentSpawnTarget.Task
        } else if (rig && targetOverride != null) {
            targetOverride.target
        } else if (rig) {
            try {
                resolveHappyAgentSpawnTarget(selectedProjectId, requestedWorktree, collectSessionWorkspaces(choice.machineIds, selectedProjectId, sessions))
            } catch (_: UnavailableWorkspaceException) {
                return Prepared.Refused(StartRefusal.WorkspaceUnavailable)
            }
        } else {
            null
        }
        val supportsWorktrees = rigCreation?.supportsWorktrees ?: (agent != AgentType.OpenClaw)
        val worktreeMachine = if (target != null) null else resolveWorktreeCreationMachine(choice, agent, supportsWorktrees)
        val worktree = if (target == null && worktreeMachine == null && requestedWorktree == WorktreeSelection.NEW) WorktreeSelection.NONE else requestedWorktree
        val spawnDirectory = if (worktree != WorktreeSelection.NONE && worktree != WorktreeSelection.NEW && target == null) worktree else directory

        var modes: Map<AgentModeField, String?>? = null
        val options = if (rigCreation != null) {
            // Happy Agent's own catalog: what the machine published, the draft's picks where it still offers them.
            val model = resolveOption(rigCreation.models, RigModelOption::key, if (agentChanged) listOf(rigCreation.defaultModelKey) else listOf(draft.modelMode, rigCreation.defaultModelKey))
            val permission = resolveOption(
                rigCreation.permissionModes,
                RigModeOption::key,
                if (agentChanged) listOf(rigCreation.defaultPermissionMode) else listOf(draft.permissionMode, rigCreation.defaultPermissionMode),
            )
            if (model == null || permission == null) return Prepared.Unavailable(CONFIGURATION_UNAVAILABLE)
            val effortDefault = rigCreation.defaultEffortForModel(model.key)
            val effort = resolveOption(rigCreation.effortsForModel(model.key), { it }, if (agentChanged) listOf(effortDefault) else listOf(draft.effortLevel, effortDefault))
            val config = try {
                rigCreation.spawnConfiguration(model.key, permission.key, effort)
            } catch (e: RigSpawnException) {
                return Prepared.Unavailable(e.message?.let(Words::Said) ?: CONFIGURATION_UNAVAILABLE)
            }
            SpawnSessionOptions(
                machineId = machine.id,
                directory = spawnDirectory,
                agent = agent.wire,
                permissionMode = config.permissionMode,
                providerId = config.providerId,
                modelId = config.modelId,
                effort = config.effort,
                happyAgentTarget = target,
            )
        } else {
            // The code agents take the user's defaults over the code's.
            val defaults = AgentDefaults.resolve(settings().agentDefaultOverrides, agent.wire, machine.metadata?.happyCliVersion)
            val permission = if (agentChanged) defaults.permissionMode else draft.permissionMode ?: defaults.permissionMode
            val model = if (agentChanged) defaults.modelMode else AgentDefaults.retireModelMode(agent.wire, draft.modelMode) ?: defaults.modelMode
            val effort = if (agentChanged) defaults.effortLevel else draft.effortLevel ?: defaults.effortLevel
            // Pinned as launched: a later change of defaults must not rewrite this session's mode.
            modes = mapOf(
                AgentModeField.PERMISSION_MODE to permission,
                AgentModeField.MODEL_MODE to model,
                AgentModeField.EFFORT_LEVEL to effort,
            )
            SpawnSessionOptions(
                machineId = machine.id,
                directory = spawnDirectory,
                agent = agent.wire,
                // Codex's Default is a concrete ask-first policy, not the absence of one.
                permissionMode = permission.takeIf { agent == AgentType.Codex || it != "default" },
                modelMode = model.takeIf { it != "default" },
                effortLevel = effort,
            )
        }
        // A new Claude chat is a Mac background session where the daemon can start one. Bots and
        // tasks are Happy Agent's; fork, duplicate and side chat never come through here.
        val background = agent == AgentType.Claude && bot == null && !task && !forceRegular &&
            machineActions.backgroundStartSupported(machine.id)
        // The mirror takes no mode changes: the picks ride the start and are not pinned.
        if (background) modes = null
        val signature = listOf(
            // A task has no place but its computer.
            machine.id, agent.wire, if (task) "task" else draftProjectId?.let { "project:$it" } ?: selectedPath, worktree,
            options.modelMode ?: options.modelId, options.permissionMode, options.effortLevel ?: options.effort,
            bot?.let { "bot:${it.name}:${it.faceSeed}" },
            if (background) "background" else null,
        ).joinToString("\u0000")
        val sendsMessage = bot == null || botMessage
        return Prepared.Ready(
            machine = machine,
            agent = agent,
            options = options.copy(clientRequestId = requestIds.getOrPut(signature, requestId)),
            worktreeMachine = worktreeMachine,
            worktreeNew = worktree == WorktreeSelection.NEW && target == null,
            publishedRetryAfterMs = rigCreation?.pendingRetryAfterMs,
            signature = signature,
            modes = modes,
            bot = bot,
            sendsMessage = sendsMessage,
            background = background,
            agentName = if (background && sendsMessage) claudeAgentNameFromMessage(draft.input.trim()) else null,
        )
    }

    private suspend fun execute(
        prepared: Prepared.Ready,
        draft: NewSessionDraft,
        attachments: List<AttachmentPreview>,
        confirmDirectory: suspend (String) -> Boolean,
    ): StartResult {
        val created = createdSessions[prepared.signature] ?: when (val made = create(prepared, confirmDirectory)) {
            is Creation.Made -> made.created
            is Creation.Refused -> return StartResult.Refused(made.refusal)
            is Creation.Failed -> return StartResult.Failed(made.message)
            Creation.Declined -> return StartResult.Abandoned
        }
        val sessionId = created.sessionId
        phaseState.value = StartPhase.Opening
        val job = currentCoroutineContext()[Job]
        var notices = emptyList<AttachmentNotice>()
        var faceFailure: BotFaceFailure? = null
        try {
            if (!awaitSession(sessionId)) {
                createdSessions.remove(prepared.signature)
                requestIds.remove(prepared.signature)
                return StartResult.Failed(Words.ours(R.string.home_start_failed))
            }
            prepared.modes?.let { sender.pinModes(sessionId, it) }
            // A face that cannot be painted or delivered is no reason to lose the bot: it opens without one.
            prepared.bot?.let { bot ->
                phaseState.value = StartPhase.Avatar
                faceFailure = faces.wear(sessionId, bot.faceSeed)
                phaseState.value = StartPhase.Opening
            }
            // The dock's bot takes no first message: the prompt typed for a session stays in the draft.
            val prompt = if (prepared.sendsMessage) draft.input.trim() else ""
            val sent = try {
                if (prompt.isEmpty() && attachments.isEmpty()) FirstSend(true) else sender.send(sessionId, prompt, attachments) { job?.isActive != false }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // The session is kept for the next Send rather than spawned again.
                createdSessions[prepared.signature] = created
                throw e
            }
            if (!sent.sent) {
                createdSessions[prepared.signature] = created
                return if (sent.notices.isEmpty()) StartResult.Abandoned else StartResult.NotSent(sent.notices)
            }
            notices = sent.notices
        } catch (e: CancellationException) {
            createdSessions.remove(prepared.signature)
            // The session is put down: the next Send is a new start, never this one's answer again.
            requestIds.remove(prepared.signature)
            scope.launch { stopAbandoned(prepared, created) }
            throw e
        }
        createdSessions.remove(prepared.signature)
        requestIds.remove(prepared.signature)
        // Only what was consumed is cleared: text typed meanwhile stays.
        if (prepared.sendsMessage) drafts.change { current -> if (current.input == draft.input) current.copy(input = "") else current }
        return StartResult.Started(sessionId, notices, faceFailure)
    }

    /** The worktree, if one is asked for, then the spawn, or the background session's start. */
    @OptIn(ExperimentalCoroutinesApi::class)
    private suspend fun create(prepared: Prepared.Ready, confirmDirectory: suspend (String) -> Boolean): Creation {
        var options = prepared.options
        if (prepared.worktreeNew) {
            phaseState.value = StartPhase.Worktree
            when (val created = machineActions.createWorktree(prepared.worktreeMachine!!.id, options.directory)) {
                is WorktreeOutcome.Failed -> throw WorktreeException(created.message)
                is WorktreeOutcome.Created -> options = options.copy(directory = created.path)
            }
        }
        phaseState.value = StartPhase.Spawning
        // The spawn outlives a Stop: whatever it hands back afterwards is put down.
        val spawning = scope.async {
            if (prepared.background) startInBackground(prepared, options, confirmDirectory) else spawnRegular(options, prepared.publishedRetryAfterMs, confirmDirectory)
        }
        val made = try {
            spawning.await()
        } catch (e: CancellationException) {
            requestIds.remove(prepared.signature)
            spawning.invokeOnCompletion { error ->
                if (error == null) {
                    (spawning.getCompleted() as? Creation.Made)?.let { scope.launch { stopAbandoned(prepared, it.created) } }
                }
            }
            throw e
        }
        // A start the Mac answered is finished there, and the daemon would hand the same answer back to the same
        // request id for minutes: the next Send asks afresh. A call that never got its answer keeps the id, so a
        // retry joins the start that may still be running rather than making a second one.
        if (made is Creation.Refused || (made is Creation.Failed && prepared.background && !made.unanswered)) {
            requestIds.remove(prepared.signature)
        }
        return made
    }

    private suspend fun spawnRegular(options: SpawnSessionOptions, publishedRetryAfterMs: Long?, confirmDirectory: suspend (String) -> Boolean): Creation =
        when (val spawned = spawn(options, publishedRetryAfterMs, confirmDirectory)) {
            is SpawnSessionResult.Success -> Creation.Made(Created(spawned.sessionId))
            is SpawnSessionResult.Error -> Creation.Failed(Words.Said(spawned.errorMessage))
            is SpawnSessionResult.Pending -> Creation.Failed(Words.ours(R.string.home_start_still_syncing))
            is SpawnSessionResult.RequestToApproveDirectoryCreation -> Creation.Declined
        }

    /**
     * `start-claude-agent` in [options]' directory (the new worktree's, when
     * one was made), named from the first message or else after the folder.
     * A missing folder is offered to be created, as a spawn's is; the
     * approved ask goes under the same request id. The daemon keeps only an
     * answer that left a session on the Mac, never "needs approval", so it
     * hears the approval; and a retry after the approved answer was lost
     * joins that start instead of making a second session.
     */
    private suspend fun startInBackground(prepared: Prepared.Ready, options: SpawnSessionOptions, confirmDirectory: suspend (String) -> Boolean): Creation {
        var request = StartClaudeAgentRequest(
            directory = options.directory,
            name = prepared.agentName ?: claudeAgentName("", options.directory),
            model = options.modelMode,
            permissionMode = options.permissionMode,
            effort = options.effortLevel,
            clientRequestId = options.clientRequestId,
        )
        while (true) {
            when (val result = machineActions.startClaudeAgent(prepared.machine.id, request)) {
                is StartClaudeAgentResult.Success -> return Creation.Made(Created(result.sessionId, result.agentId))
                is StartClaudeAgentResult.Untrusted -> return Creation.Refused(StartRefusal.UntrustedFolder(result.directory.ifEmpty { request.directory }))
                is StartClaudeAgentResult.Failed ->
                    return Creation.Failed(Words.Said(result.message), unanswered = result.code == StartClaudeAgentResult.CALL_FAILED)
                is StartClaudeAgentResult.NeedsDirectoryApproval -> {
                    if (request.approvedNewDirectoryCreation || !confirmDirectory(result.directory)) return Creation.Declined
                    request = request.copy(approvedNewDirectoryCreation = true)
                }
            }
        }
    }

    private suspend fun spawn(options: SpawnSessionOptions, publishedRetryAfterMs: Long?, confirmDirectory: suspend (String) -> Boolean): SpawnSessionResult {
        var result = machineActions.spawnSession(options)
        var pending = 0
        while (result is SpawnSessionResult.Pending && pending < MAX_PENDING_RESULTS) {
            pending++
            delay(resolveRigPendingRetryDelayMs(result.retryAfterMs, publishedRetryAfterMs))
            result = machineActions.spawnSession(options)
        }
        if (result is SpawnSessionResult.RequestToApproveDirectoryCreation) {
            return if (confirmDirectory(result.directory)) {
                spawn(options.copy(approvedNewDirectoryCreation = true), publishedRetryAfterMs, confirmDirectory)
            } else {
                result
            }
        }
        return result
    }

    /**
     * A session nobody is waiting for. Happy Agent's is killed; Happy CLI's
     * daemon is asked first, then the session, then the server retires it.
     * A Mac background session this start made goes too, once its mirror
     * is stopped: the daemon discards only the ones it started.
     */
    private suspend fun stopAbandoned(prepared: Prepared.Ready, created: Created) {
        val sessionId = created.sessionId
        if (prepared.agent == AgentType.Rig) {
            sessionActions.kill(sessionId)
            return
        }
        stopSession(prepared.machine.id, sessionId)
        created.agentId?.let { machineActions.discardClaudeAgent(prepared.machine.id, it) }
    }

    private suspend fun stopSession(machineId: String, sessionId: String) {
        if (machineActions.stopSession(machineId, sessionId).success) return
        if (sessionActions.kill(sessionId).success) return
        sessionActions.archiveOnServer(sessionId)
    }
}
