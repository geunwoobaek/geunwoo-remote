package com.slopus.happy.ui.home

import com.slopus.happy.text.Words
import com.slopus.happy.R
import com.slopus.happy.attachments.AttachmentNotice
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.attachments.AttachmentUploadResult
import com.slopus.happy.attachments.prepareAttachmentSend
import com.slopus.happy.model.GitWorktree
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.sync.AccountSync
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.sync.DiscardClaudeAgentResult
import com.slopus.happy.sync.MachineOps
import com.slopus.happy.sync.OpResult
import com.slopus.happy.sync.SendException
import com.slopus.happy.sync.SendOptions
import com.slopus.happy.sync.SendResult
import com.slopus.happy.sync.SpawnSessionOptions
import com.slopus.happy.sync.SpawnSessionResult
import com.slopus.happy.sync.StartClaudeAgentRequest
import com.slopus.happy.sync.StartClaudeAgentResult
import java.util.concurrent.ConcurrentHashMap

/** The machine RPCs a start runs (ops.ts), as [MachineOps] answers them; tests use a fake. */
interface MachineActions {
    suspend fun spawnSession(options: SpawnSessionOptions): SpawnSessionResult
    suspend fun createWorktree(machineId: String, basePath: String): WorktreeOutcome
    suspend fun listWorktrees(machineId: String, basePath: String): List<GitWorktree>
    suspend fun stopSession(machineId: String, sessionId: String): OpResult

    /** A new Claude chat as a Mac background session (`start-claude-agent`). */
    suspend fun startClaudeAgent(machineId: String, request: StartClaudeAgentRequest): StartClaudeAgentResult

    /** Stops and removes a background session this app's start made (`discard-claude-agent`). */
    suspend fun discardClaudeAgent(machineId: String, agentId: String): DiscardClaudeAgentResult

    /**
     * Whether a new Claude chat on [machineId] starts as a background session:
     * its daemon lists background sessions, says it can start them, and has
     * nothing in the way (tmux and claude are there). Anything else, a failed
     * listing included, is false and the chat starts as a regular session.
     */
    suspend fun backgroundStartSupported(machineId: String): Boolean
}

/**
 * [MachineActions] over the signed-in account's [MachineOps]. A machine's
 * [backgroundStartSupported] answer is kept for [supportTtlMs], so the new-chat
 * screen asking as the computer is picked and the start asking at Send cost
 * one listing between them.
 */
class LiveMachineActions(
    private val now: () -> Long = System::currentTimeMillis,
    private val supportTtlMs: Long = BACKGROUND_SUPPORT_TTL_MS,
    private val ops: () -> MachineOps?,
) : MachineActions {
    private val support = ConcurrentHashMap<String, Pair<Long, Boolean>>()

    override suspend fun spawnSession(options: SpawnSessionOptions): SpawnSessionResult =
        ops()?.spawnSession(options) ?: SpawnSessionResult.Error(SIGNED_OUT)

    override suspend fun createWorktree(machineId: String, basePath: String): WorktreeOutcome {
        val ops = ops() ?: return WorktreeOutcome.Failed(Words.ours(R.string.home_not_signed_in))
        return createWorktree(basePath) { command -> ops.bash(machineId, command, basePath) }
    }

    override suspend fun listWorktrees(machineId: String, basePath: String): List<GitWorktree> {
        val ops = ops() ?: return emptyList()
        return listWorktrees { command -> ops.bash(machineId, command, basePath) }
    }

    override suspend fun stopSession(machineId: String, sessionId: String): OpResult =
        ops()?.stopSession(machineId, sessionId) ?: OpResult(false, SIGNED_OUT)

    override suspend fun startClaudeAgent(machineId: String, request: StartClaudeAgentRequest): StartClaudeAgentResult =
        ops()?.startClaudeAgent(machineId, request) ?: StartClaudeAgentResult.Failed(StartClaudeAgentResult.START_FAILED, SIGNED_OUT)

    override suspend fun discardClaudeAgent(machineId: String, agentId: String): DiscardClaudeAgentResult =
        ops()?.discardClaudeAgent(machineId, agentId) ?: DiscardClaudeAgentResult.Failed("discard-failed", SIGNED_OUT)

    override suspend fun backgroundStartSupported(machineId: String): Boolean {
        support[machineId]?.let { (at, supported) -> if (now() - at < supportTtlMs) return supported }
        val ops = ops() ?: return false
        val listing = ops.listClaudeAgents(machineId)
        val supported = listing.startSupported && listing.unavailable == null
        support[machineId] = now() to supported
        return supported
    }

    private companion object {
        const val SIGNED_OUT = "Not signed in"

        /** Long enough to cover composing a message, short enough that a daemon updated meanwhile is noticed. */
        const val BACKGROUND_SUPPORT_TTL_MS = 60_000L
    }
}

/** What a first send did: whether it went out, and the alerts it raised on the way (imageUpload.*). */
data class FirstSend(val sent: Boolean, val notices: List<AttachmentNotice> = emptyList())

/** How the first message reaches the new session (ops.ts sessionSetAgentModes, sync.ts sendMessage). */
interface FirstMessageSender {
    /** Pins the picks the session was started with, so the message's meta resolves from them. */
    suspend fun pinModes(sessionId: String, modes: Map<AgentModeField, String?>)

    /**
     * Sent once [text] and the uploaded [attachments] are in the outbox; not
     * sent when [isCurrent] turned false first, or when the agent takes no
     * images and there is nothing else to send.
     * @throws SendException with the user's words when nothing was queued.
     */
    suspend fun send(sessionId: String, text: String, attachments: List<AttachmentPreview>, isCurrent: () -> Boolean): FirstSend
}

/**
 * [FirstMessageSender] over the signed-in account's composer and sender;
 * attachments go through [prepareAttachmentSend] against the new session's
 * [metadata], uploaded with [upload].
 */
class LiveFirstMessageSender(
    private val account: () -> AccountSync?,
    private val metadata: suspend (sessionId: String) -> SessionMetadata? = { null },
    private val upload: suspend (sessionId: String, List<AttachmentPreview>) -> AttachmentUploadResult = { _, list -> AttachmentUploadResult(emptyList(), list.size) },
) : FirstMessageSender {
    override suspend fun pinModes(sessionId: String, modes: Map<AgentModeField, String?>) {
        account()?.composer?.setAgentModes(sessionId, modes)
    }

    override suspend fun send(sessionId: String, text: String, attachments: List<AttachmentPreview>, isCurrent: () -> Boolean): FirstSend {
        val sender = account()?.sender ?: return FirstSend(false)
        val plan = prepareAttachmentSend(metadata(sessionId), text, attachments) { upload(sessionId, it) }
        if (!plan.send || (text.isBlank() && plan.records.isEmpty())) return FirstSend(false, plan.notices)
        return when (val result = sender.send(sessionId, text, SendOptions(source = "new_session", attachments = plan.records, isCurrent = isCurrent))) {
            is SendResult.Accepted -> FirstSend(true, plan.notices)
            is SendResult.NotSent -> result.message?.let { throw SendException(it) } ?: FirstSend(false, plan.notices)
        }
    }
}

/** Which of the bot face's three steps failed (useStartSessionFromDraft's `BotFaceLeg`). */
enum class BotFaceLeg { Painting, Uploading, Wearing }

/** A face the bot could not be given: the bot is fine, and the face can be tried again on it. */
data class BotFaceFailure(val leg: BotFaceLeg, val message: String)

/**
 * wearBotFace: paint the seed's face, put it in the bot's attachments, ask
 * the bot to wear it. Null once it is worn; otherwise the step that failed.
 */
fun interface BotFaceWearer {
    suspend fun wear(sessionId: String, seed: String): BotFaceFailure?
}
