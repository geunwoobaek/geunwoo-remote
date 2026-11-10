package com.slopus.happy.chat

import com.slopus.happy.chat.NormalizedMessage.AgentContent
import com.slopus.happy.chat.NormalizedMessage.Body
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// A port of happy-app's sync/reducer/reducer.ts: folds normalized records and
// the session's agent state into chat rows, incrementally. The reducer state
// keeps every mapping across calls, so applying the same records again adds
// nothing, and each call returns only the rows it created or changed.
//
// Phases, in order (see reducer.ts for the long form):
//   0.5  receipts, ready and lifecycle events; messages that read as events
//   0    agent-state permissions: placeholder tool rows, status updates
//   1    user messages (deduplicated by local id) and agent text
//   2    tool calls, joined to permission rows by tool id
//   3    tool results
//   4    sidechains, stored under the tool call that owns them
//   5    agent events
//
// Rows never change their createdAt; only tool state, results, permissions and
// a pending message's settled position change after creation.

@androidx.compose.runtime.Immutable
data class TodoItem(val content: String, val status: String, val priority: String? = null, val id: String? = null) {
    companion object {
        private val STATUSES = setOf("pending", "in_progress", "completed")
        private val PRIORITIES = setOf("high", "medium", "low")

        /** The whole list, or null if any item fails `TodoItemSchema`. */
        fun parseList(value: JsonElement?): List<TodoItem>? {
            val array = value.arr ?: return null
            return array.map { element ->
                val o = element.obj ?: return null
                val priority = o["priority"]
                val id = o["id"]
                if (!priority.isNullOrAbsent && priority.str !in PRIORITIES) return null
                if (!id.isNullOrAbsent && id.str == null) return null
                TodoItem(
                    content = o["content"].str ?: return null,
                    status = o["status"].str?.takeIf { it in STATUSES } ?: return null,
                    priority = priority.str,
                    id = id.str,
                )
            }
        }
    }
}

/** Context usage from the newest record that reported it. */
data class ContextUsage(
    val inputTokens: Long,
    val outputTokens: Long,
    val cacheCreation: Long,
    val cacheRead: Long,
    val contextSize: Long,
    val contextWindow: Long? = null,
)

data class ReducerResult(
    /** Rows created or changed by this call. */
    val messages: List<ChatMessage>,
    val todos: List<TodoItem>? = null,
    val usage: ContextUsage? = null,
    val hasReadyEvent: Boolean = false,
    /** Rows in [messages] that only settled (position, pending); not new content. */
    val settledMessageIds: Set<String> = emptySet(),
    /** Rows that left the chat in this call (a mirror's answered `screen:` card once the real tool row arrived); never in [messages]. */
    val hiddenMessageIds: Set<String> = emptySet(),
)

/**
 * How this session treats a message the user just sent. Only daemons that
 * send acceptance receipts can honestly show a message as not yet seen.
 * [mirror]: the session mirrors a Mac `claude agents` background session
 * ([com.slopus.happy.model.isClaudeAgentMirror]).
 */
/**
 * [windowStartAt]: set while older messages exist beyond the loaded window,
 * it is the window's oldest message time. Records that belong to something
 * older than the window are not invented from partial evidence (see the
 * phases below). Null: the whole history is loaded.
 */
data class ReducerOptions(
    val holdUserMessagesUntilAccepted: Boolean = false,
    val mirror: Boolean = false,
    val windowStartAt: Long? = null,
)

internal class ReducerMessage(
    val id: String,
    val localId: String? = null,
    var realID: String?,
    val createdAt: Long,
    val isUser: Boolean,
    var text: String? = null,
    val isThinking: Boolean = false,
    val event: AgentEvent? = null,
    var tool: ToolCall? = null,
    val meta: MessageMeta? = null,
    val claudeUuid: String? = null,
    val codexItemId: String? = null,
    var pending: Boolean = false,
    var sendError: String? = null,
    var sortAt: Long? = null,
    var turn: String? = null,
    val author: SessionAuthor? = null,
    val unsupported: String? = null,
) {
    /** Kept by the reducer for its joins but no longer a row of the chat. */
    var hidden: Boolean = false
}

internal data class StoredPermission(
    /** The request id the CLI expects back; may differ from the join key. */
    val id: String,
    val tool: String,
    val arguments: JsonElement?,
    val createdAt: Long,
    val completedAt: Long? = null,
    val status: PermissionStatus,
    val reason: String? = null,
    val mode: String? = null,
    val allowedTools: List<String>? = null,
    val decision: PermissionDecision? = null,
)

private data class Receipt(val createdAt: Long, val error: String? = null)

private data class TimedUsage(val usage: ContextUsage, val timestamp: Long)

class ReducerState(private val now: () -> Long = System::currentTimeMillis) {
    internal val toolIdToMessageId = HashMap<String, String>()
    internal val sidechainToolIdToMessageId = HashMap<String, String>()
    internal val permissions = HashMap<String, StoredPermission>()
    internal val localIds = HashMap<String, String>()
    internal val messageIds = HashMap<String, String>()
    /** Internal ids by [ReducerMessage.realID], so a sidechain finds its owner without a scan. */
    private val byRealId = HashMap<String, MutableSet<String>>()
    internal val messages = object : LinkedHashMap<String, ReducerMessage>() {
        override fun put(key: String, value: ReducerMessage): ReducerMessage? {
            value.realID?.let { indexRealId(it, key) }
            return super.put(key, value)
        }
    }
    /** Receipts whose message has not arrived under its server id yet. */
    private val pendingReceipts = HashMap<String, Receipt>()
    /** Send acks (local id to server id) that beat their optimistic row. */
    private val unmatchedAckServerIds = HashMap<String, String>()
    internal val sidechains = HashMap<String, MutableList<ReducerMessage>>()
    internal val tracer = TracerState()
    private var latestTodos: Pair<List<TodoItem>, Long>? = null
    private var latestUsage: TimedUsage? = null
    private var nextId = 0L

    val todos: List<TodoItem>? get() = latestTodos?.first
    val usage: ContextUsage? get() = latestUsage?.usage

    private fun allocateId(): String = "m${nextId++}"

    /**
     * Feeds send acks (server id and local id of this device's own messages)
     * into the reducer. Returns the rows that settled because a receipt had
     * been waiting for them.
     */
    fun registerUserMessageServerIds(pairs: List<Pair<String, String>>): List<ChatMessage> {
        val settled = ArrayList<ChatMessage>()
        for ((serverId, localId) in pairs) {
            val internalId = localIds[localId]
            if (internalId == null) {
                unmatchedAckServerIds[localId] = serverId
                continue
            }
            if (joinUserMessageServerId(serverId, internalId)) {
                messages[internalId]?.let(::convert)?.let(settled::add)
            }
        }
        return settled
    }

    fun reduce(
        incoming: List<NormalizedMessage>,
        agentState: AgentState? = null,
        options: ReducerOptions = ReducerOptions(),
    ): ReducerResult {
        val changed = LinkedHashSet<String>()
        val settledIds = LinkedHashSet<String>()
        var hasReadyEvent = false

        val traced = traceMessages(tracer, incoming, holdUnowned = options.windowStartAt != null)
        val sidechainMessages = traced.filter { it.sidechainId != null }
        var nonSidechain = traced.filter { it.sidechainId == null }.map { it.message }

        //
        // Phase 0.5: receipts, lifecycle events, messages that become events
        //
        val toProcess = ArrayList<NormalizedMessage>()
        val converted = ArrayList<Pair<NormalizedMessage, AgentEvent>>()
        for (msg in nonSidechain) {
            val body = msg.body
            if (body is Body.User && msg.localId != null && msg.localId in localIds) {
                // The server's echo of a row already on screen: record the
                // server id a receipt will name.
                val internalId = localIds.getValue(msg.localId)
                if (joinUserMessageServerId(msg.id, internalId)) {
                    changed.add(internalId)
                    settledIds.add(internalId)
                }
                continue
            }
            if (msg.id in messageIds) continue

            val event = (body as? Body.Event)?.event
            if (event is AgentEvent.UserMessageAccepted || event is AgentEvent.UserMessageRejected) {
                messageIds[msg.id] = msg.id
                val ref = if (event is AgentEvent.UserMessageAccepted) event.ref else (event as AgentEvent.UserMessageRejected).ref
                val receipt = Receipt(msg.createdAt, (event as? AgentEvent.UserMessageRejected)?.reason)
                val internalId = messageIds[ref]
                if (internalId != null) {
                    if (settleUserMessage(internalId, receipt)) {
                        changed.add(internalId)
                        settledIds.add(internalId)
                    }
                } else {
                    pendingReceipts[ref] = receipt
                }
                continue
            }
            if (event == AgentEvent.Ready) {
                messageIds[msg.id] = msg.id
                hasReadyEvent = true
                continue
            }
            if (event is AgentEvent.Message && event.message == "Turn started") {
                messageIds[msg.id] = msg.id
                continue
            }
            // An older batch (the window growing downward) must not wipe values a newer record set.
            if (event is AgentEvent.Message && event.message == "Context was reset") {
                if (latestTodos.let { it == null || msg.createdAt >= it.second }) {
                    latestTodos = emptyList<TodoItem>() to msg.createdAt
                }
                if (latestUsage.let { it == null || msg.createdAt >= it.timestamp }) {
                    latestUsage = TimedUsage(ContextUsage(0, 0, 0, 0, 0), msg.createdAt)
                }
            }
            if (event is AgentEvent.Message && event.message == "Compaction completed") {
                if (latestUsage.let { it == null || msg.createdAt >= it.timestamp }) {
                    latestUsage = TimedUsage(ContextUsage(0, 0, 0, 0, 0), msg.createdAt)
                }
            }

            val asEvent = parseMessageAsEvent(msg)
            if (asEvent != null) {
                converted.add(msg to asEvent)
                messageIds[msg.id] = msg.id
                if (body is Body.User && msg.localId != null) localIds[msg.localId] = msg.id
            } else {
                toProcess.add(msg)
            }
        }
        for ((message, event) in converted) {
            val mid = allocateId()
            messages[mid] = ReducerMessage(
                id = mid, realID = message.id, createdAt = message.createdAt, isUser = false, event = event,
                meta = message.meta,
            )
            changed.add(mid)
        }
        nonSidechain = toProcess

        val incomingToolIds = HashSet<String>()
        for (msg in nonSidechain) {
            for (c in msg.agentContent) if (c is AgentContent.ToolUse) incomingToolIds.add(c.id)
        }

        //
        // Phase 0: agent-state permissions
        //
        if (agentState != null) {
            for ((permId, request) in agentState.requests) {
                // A completed request takes precedence over its pending copy.
                if (permId in agentState.completedRequests) continue
                // Join key: the raw tool-use id when the request id is scoped.
                val joinId = request.toolUseId ?: permId
                val createdAt = request.createdAt ?: now()
                val existingId = toolIdToMessageId[joinId]
                if (existingId != null) {
                    val message = messages[existingId]
                    val tool = message?.tool
                    if (tool != null && tool.permission == null) {
                        message.tool = tool.copy(permission = ToolPermission(permId, PermissionStatus.Pending))
                        changed.add(existingId)
                    }
                } else {
                    val mid = allocateId()
                    messages[mid] = ReducerMessage(
                        id = mid, realID = null, createdAt = createdAt, isUser = false,
                        tool = ToolCall(
                            callId = joinId, name = request.tool, state = ToolState.Running, input = request.arguments,
                            createdAt = createdAt, permission = ToolPermission(permId, PermissionStatus.Pending),
                        ),
                    )
                    toolIdToMessageId[joinId] = mid
                    changed.add(mid)
                }
                permissions[joinId] = StoredPermission(
                    id = permId, tool = request.tool, arguments = request.arguments, createdAt = createdAt,
                    status = PermissionStatus.Pending,
                )
            }

            for ((permId, completed) in agentState.completedRequests) {
                val joinId = completed.toolUseId ?: permId
                val stored = StoredPermission(
                    id = permId, tool = completed.tool, arguments = completed.arguments,
                    createdAt = completed.createdAt ?: now(), completedAt = completed.completedAt,
                    status = completed.status, reason = completed.reason, mode = completed.mode,
                    allowedTools = completed.allowedTools, decision = completed.decision,
                )
                val messageId = toolIdToMessageId[joinId]
                if (messageId != null) {
                    val message = messages[messageId] ?: continue
                    var tool = message.tool ?: continue
                    // Already running with approval, or the tool result
                    // reported the permission (preferred over agent state).
                    if (tool.startedAt != null && tool.permission?.status == PermissionStatus.Approved) continue
                    if (tool.permission?.date != null) continue
                    val current = tool.permission
                    val needsUpdate = current?.status != completed.status ||
                        current.reason != completed.reason ||
                        current.mode != completed.mode ||
                        current.allowedTools != completed.allowedTools ||
                        current.decision != completed.decision
                    if (!needsUpdate) continue

                    tool = tool.copy(
                        permission = ToolPermission(
                            id = current?.id ?: permId,
                            status = completed.status,
                            reason = completed.reason ?: current?.reason,
                            mode = completed.mode,
                            allowedTools = completed.allowedTools,
                            decision = completed.decision,
                            date = current?.date,
                        ),
                    )
                    if (completed.status == PermissionStatus.Approved) {
                        if (tool.state != ToolState.Completed && tool.state != ToolState.Error) {
                            tool = tool.copy(state = ToolState.Running)
                        }
                    } else if (tool.state != ToolState.Error && tool.state != ToolState.Completed) {
                        tool = tool.copy(
                            state = ToolState.Error,
                            completedAt = completed.completedAt ?: now(),
                            result = tool.result ?: completed.reason?.let(::errorResult),
                        )
                    }
                    message.tool = tool
                    permissions[joinId] = stored
                    changed.add(messageId)
                } else {
                    if (joinId in incomingToolIds) {
                        // Phase 2 joins it to the tool call in this batch.
                        permissions[joinId] = stored
                        continue
                    }
                    if (permId in agentState.requests) continue
                    // Older than the window: its tool line is not loaded, and the
                    // permission is kept so the line joins it when the window reaches it.
                    val windowStart = options.windowStartAt
                    if (windowStart != null && completed.createdAt != null && completed.createdAt < windowStart) {
                        permissions[joinId] = stored
                        continue
                    }

                    val mid = allocateId()
                    val createdAt = stored.createdAt
                    messages[mid] = ReducerMessage(
                        id = mid, realID = null, createdAt = createdAt, isUser = false,
                        tool = ToolCall(
                            callId = joinId,
                            name = completed.tool,
                            state = if (completed.status == PermissionStatus.Approved) ToolState.Completed else ToolState.Error,
                            input = completed.arguments,
                            createdAt = createdAt,
                            completedAt = completed.completedAt ?: now(),
                            result = if (completed.status == PermissionStatus.Approved) {
                                JsonPrimitive("Approved")
                            } else {
                                completed.reason?.let(::errorResult)
                            },
                            permission = ToolPermission(
                                id = permId, status = completed.status, reason = completed.reason,
                                mode = completed.mode, allowedTools = completed.allowedTools,
                                decision = completed.decision,
                            ),
                        ),
                    )
                    toolIdToMessageId[joinId] = mid
                    permissions[joinId] = stored
                    changed.add(mid)
                }
            }
        }

        //
        // Phase 1: user messages and agent text
        //
        for (msg in nonSidechain) {
            when (val body = msg.body) {
                is Body.User -> {
                    if (msg.localId != null && msg.localId in localIds) {
                        // An echo in the same batch as its optimistic copy.
                        val internalId = localIds.getValue(msg.localId)
                        if (joinUserMessageServerId(msg.id, internalId)) {
                            changed.add(internalId)
                            settledIds.add(internalId)
                        }
                        continue
                    }
                    if (msg.id in messageIds) continue

                    // Hold this device's just-sent copy (its id is its local id)
                    // or a restored send that expects a receipt.
                    val isOptimisticLocalCopy = msg.localId != null && msg.id == msg.localId
                    val hold = options.holdUserMessagesUntilAccepted &&
                        (isOptimisticLocalCopy || msg.meta?.expectsAcceptance == true)
                    val mid = allocateId()
                    messages[mid] = ReducerMessage(
                        id = mid, localId = msg.localId, realID = msg.id, createdAt = msg.createdAt, isUser = true,
                        text = body.text, meta = msg.meta, claudeUuid = msg.claudeUuid, codexItemId = msg.codexItemId,
                        author = msg.author, pending = hold,
                        sortAt = if (hold) msg.createdAt + ChatMessage.PENDING_SORT_OFFSET else null,
                    )
                    if (msg.localId != null) localIds[msg.localId] = mid
                    messageIds[msg.id] = mid
                    if (msg.localId != null) {
                        unmatchedAckServerIds.remove(msg.localId)?.let { joinUserMessageServerId(it, mid) }
                    }
                    pendingReceipts.remove(msg.id)?.let { settleUserMessage(mid, it) }
                    changed.add(mid)
                }
                is Body.Agent -> {
                    if (msg.id in messageIds) continue
                    messageIds[msg.id] = msg.id
                    msg.usage?.let { processUsage(it, msg.createdAt) }
                    for (c in body.content) {
                        val text = when (c) {
                            is AgentContent.Text -> c.text
                            is AgentContent.Thinking -> "*${c.thinking}*"
                            else -> continue
                        }
                        val mid = allocateId()
                        messages[mid] = ReducerMessage(
                            id = mid, realID = msg.id, createdAt = msg.createdAt, isUser = false, text = text,
                            isThinking = c is AgentContent.Thinking, meta = msg.meta, turn = msg.turn,
                        )
                        changed.add(mid)
                    }
                }
                is Body.Unsupported -> {
                    if (msg.id in messageIds) continue
                    val mid = allocateId()
                    messageIds[msg.id] = mid
                    messages[mid] = ReducerMessage(
                        id = mid, realID = msg.id, createdAt = msg.createdAt, isUser = false, unsupported = body.kind,
                    )
                    changed.add(mid)
                }
                is Body.Event -> Unit
            }
        }

        //
        // Phase 2: tool calls
        //
        for (msg in nonSidechain) {
            for (c in msg.agentContent) {
                if (c !is AgentContent.ToolUse) continue
                val existingId = toolIdToMessageId[c.id]
                if (existingId != null) {
                    val message = messages[existingId] ?: continue
                    var tool = message.tool ?: continue
                    message.realID = msg.id
                    indexRealId(msg.id, existingId)
                    // A permission placeholder has no turn; the call has one.
                    if (msg.turn != null) message.turn = msg.turn
                    tool = tool.copy(
                        callId = c.id,
                        input = mergeToolInputs(tool.input, c.input),
                        description = c.description,
                        title = c.title ?: tool.title,
                        startedAt = msg.createdAt,
                    )
                    // Approved and shown as completed without a tool: now it runs.
                    if (tool.permission?.status == PermissionStatus.Approved && tool.state == ToolState.Completed) {
                        tool = tool.copy(state = ToolState.Running, completedAt = null, result = null)
                    }
                    message.tool = tool
                    changed.add(existingId)
                } else {
                    val permission = permissions[c.id]
                    var tool = ToolCall(
                        callId = c.id,
                        name = c.name,
                        state = ToolState.Running,
                        input = if (permission != null) mergeToolInputs(permission.arguments, c.input) else c.input,
                        createdAt = permission?.createdAt ?: msg.createdAt,
                        startedAt = msg.createdAt,
                        description = c.description,
                        title = c.title,
                    )
                    if (permission != null) {
                        tool = tool.copy(
                            permission = ToolPermission(
                                id = permission.id, status = permission.status, reason = permission.reason,
                                mode = permission.mode, allowedTools = permission.allowedTools,
                                decision = permission.decision,
                            ),
                        )
                        if (permission.status != PermissionStatus.Approved) {
                            tool = tool.copy(
                                state = ToolState.Error,
                                completedAt = permission.completedAt ?: msg.createdAt,
                                result = permission.reason?.let(::errorResult),
                            )
                        }
                    }
                    val mid = allocateId()
                    messages[mid] = ReducerMessage(
                        id = mid, realID = msg.id, createdAt = msg.createdAt, isUser = false, tool = tool,
                        meta = msg.meta, turn = msg.turn,
                    )
                    toolIdToMessageId[c.id] = mid
                    changed.add(mid)
                }
            }
        }

        //
        // Phase 3: tool results
        //
        for (msg in nonSidechain) {
            for (c in msg.agentContent) {
                if (c !is AgentContent.ToolResult) continue
                val messageId = toolIdToMessageId[c.toolUseId] ?: continue
                if (applyResult(messageId, c, msg.createdAt)) {
                    val tool = messages.getValue(messageId).tool!!
                    if (tool.name == "TodoWrite" && !c.isError) {
                        updateLatestTodos(tool.result.obj?.get("newTodos"), msg.createdAt)
                    }
                    changed.add(messageId)
                }
            }
        }

        //
        // Phase 4: sidechains
        //
        for (traced in sidechainMessages) {
            val msg = traced.message
            val sidechainId = traced.sidechainId ?: continue
            if (msg.id in messageIds) continue
            messageIds[msg.id] = msg.id

            val existing = sidechains.getOrPut(sidechainId) { ArrayList() }
            val ownerPrompt = sidechainOwner(sidechainId)?.tool?.input.obj?.get("prompt").str
                ?.trim()?.takeIf { it.isNotEmpty() }
            fun isDuplicatePrompt(text: String) = existing.isEmpty() && ownerPrompt != null && text.trim() == ownerPrompt

            val content = msg.agentContent
            val first = content.firstOrNull()
            if (first is AgentContent.Sidechain) {
                if (isDuplicatePrompt(first.prompt)) continue
                val mid = allocateId()
                val userMsg = ReducerMessage(
                    id = mid, realID = msg.id, createdAt = msg.createdAt, isUser = true, text = first.prompt,
                    meta = msg.meta,
                )
                messages[mid] = userMsg
                existing.add(userMsg)
            } else if (msg.body is Body.Agent) {
                for (c in content) {
                    when (c) {
                        is AgentContent.Text, is AgentContent.Thinking -> {
                            if (c is AgentContent.Text && isDuplicatePrompt(c.text)) continue
                            val mid = allocateId()
                            val textMsg = ReducerMessage(
                                id = mid, realID = msg.id, createdAt = msg.createdAt, isUser = false,
                                text = if (c is AgentContent.Thinking) "*${c.thinking}*" else (c as AgentContent.Text).text,
                                isThinking = c is AgentContent.Thinking, meta = msg.meta,
                            )
                            messages[mid] = textMsg
                            existing.add(textMsg)
                        }
                        is AgentContent.ToolUse -> {
                            var tool = ToolCall(
                                callId = c.id, name = c.name, state = ToolState.Running, input = c.input,
                                createdAt = msg.createdAt, description = c.description, title = c.title,
                            )
                            val permissionMessageId = toolIdToMessageId[c.id]
                            val permissionMessage = permissionMessageId?.let(messages::get)
                            val permissionTool = permissionMessage?.tool
                            if (permissionTool?.permission != null) {
                                tool = tool.copy(permission = permissionTool.permission)
                                if (permissionTool.state != ToolState.Completed && permissionTool.state != ToolState.Error) {
                                    permissionMessage.tool = permissionTool.copy(
                                        state = ToolState.Running,
                                        startedAt = msg.createdAt,
                                        description = c.description,
                                        title = c.title ?: permissionTool.title,
                                    )
                                    changed.add(permissionMessageId)
                                }
                            }
                            val mid = allocateId()
                            val toolMsg = ReducerMessage(
                                id = mid, realID = msg.id, createdAt = msg.createdAt, isUser = false, tool = tool,
                                meta = msg.meta,
                            )
                            messages[mid] = toolMsg
                            existing.add(toolMsg)
                            sidechainToolIdToMessageId[c.id] = mid
                        }
                        is AgentContent.ToolResult -> {
                            sidechainToolIdToMessageId[c.toolUseId]?.let { applyResult(it, c, msg.createdAt) }
                            val permissionMessageId = toolIdToMessageId[c.toolUseId]
                            if (permissionMessageId != null && applyResult(permissionMessageId, c, msg.createdAt)) {
                                changed.add(permissionMessageId)
                            }
                        }
                        is AgentContent.Sidechain -> Unit
                    }
                }
            }

            // The Task message that owns this sidechain re-renders with it.
            // By id first: a scan of every message per sidechain is quadratic over a long session.
            sidechainOwner(sidechainId)?.let { changed.add(it.id) }
        }

        //
        // Phase 5: agent events
        //
        for (msg in nonSidechain) {
            val event = (msg.body as? Body.Event)?.event ?: continue
            val mid = allocateId()
            messages[mid] = ReducerMessage(
                id = mid, realID = msg.id, createdAt = msg.createdAt, isUser = false, event = event, meta = msg.meta,
                turn = msg.turn,
            )
            changed.add(mid)
        }

        val hidden = if (options.mirror) hideAnsweredScreenCards() else emptySet()

        return ReducerResult(
            messages = changed.mapNotNull { id -> messages[id]?.takeIf { !it.hidden }?.let(::convert) },
            todos = latestTodos?.first,
            usage = latestUsage?.usage,
            hasReadyEvent = hasReadyEvent,
            settledMessageIds = settledIds,
            hiddenMessageIds = hidden,
        )
    }

    /**
     * A mirror shows a `screen:` card when the CLI read a dialog off the Mac's
     * screen before its tool call reached the transcript. An approved card is
     * the same call as the transcript's tool row that follows it, so it
     * leaves the chat once it has paired with one. A denied, canceled or
     * pending card never has a row (the tool didn't run, or hasn't yet), so it
     * stays.
     *
     * Pairing is one to one, per tool name: cards in the order they were
     * raised each claim the earliest unclaimed transcript row of that tool
     * inside their window, so one row never hides two cards and an unrelated
     * later call never hides an unmatched card. A row is only a transcript
     * `tool_use` (it has a record behind it), never a row built from an agent
     * state request alone. Claims are recomputed each call and a hidden card
     * keeps its claim, so a card never reappears. Returns the ids hidden by
     * this call.
     *
     * A card the CLI retired as `moved-to-tool-call` leaves at once: its
     * call reached the transcript while the dialog was open, and the request
     * now stands on that call's row under the `tool_use` id.
     */
    private fun hideAnsweredScreenCards(): Set<String> {
        fun ReducerMessage.isScreenCard() = tool?.callId?.startsWith(SCREEN_REQUEST_PREFIX) == true
        val newlyHidden = LinkedHashSet<String>()
        for (card in messages.values) {
            if (!card.hidden && card.isScreenCard() && card.tool?.permission?.reason == SCREEN_REQUEST_MOVED) {
                card.hidden = true
                newlyHidden.add(card.id)
            }
        }
        val cards = messages.values
            .filter { it.isScreenCard() && it.tool?.permission?.status == PermissionStatus.Approved }
            .sortedWith(compareBy<ReducerMessage> { it.createdAt }.thenBy { it.id.removePrefix("m").toLongOrNull() ?: Long.MAX_VALUE })
        if (cards.none { !it.hidden }) return newlyHidden
        val nested = sidechainToolIdToMessageId.values.toSet()
        // Earliest first, so a card claims the earliest row it can.
        val rowsByTool = messages.values
            .filter { it.tool != null && !it.isUser && it.realID != null && it.id !in nested && !it.isScreenCard() }
            .sortedBy { it.createdAt }
            .groupBy { it.tool!!.name }
        val claimed = HashSet<String>()
        for (card in cards) {
            val from = card.createdAt - SCREEN_CARD_CLOCK_SKEW_MS
            val to = (permissions[card.tool?.callId]?.completedAt ?: card.createdAt) + SCREEN_CARD_ROW_WINDOW_MS
            val row = rowsByTool[card.tool?.name].orEmpty()
                .firstOrNull { it.id !in claimed && it.createdAt > from && it.createdAt <= to } ?: continue
            claimed.add(row.id)
            if (!card.hidden) {
                card.hidden = true
                newlyHidden.add(card.id)
            }
        }
        return newlyHidden
    }

    /** Every row the reducer holds at the top level, newest first. */
    fun snapshot(): List<ChatMessage> {
        val nested = HashSet<String>()
        for (children in sidechains.values) for (child in children) nested.add(child.id)
        return messages.values.asSequence()
            .filter { it.id !in nested && !it.hidden }
            .mapNotNull(::convert)
            .sortedByDescending { it.sortKey }
            .toList()
    }

    /** Sets a running tool's outcome; false if it was not running. */
    private fun applyResult(messageId: String, c: AgentContent.ToolResult, createdAt: Long): Boolean {
        val message = messages[messageId] ?: return false
        val tool = message.tool ?: return false
        if (tool.state != ToolState.Running) return false
        val permission = c.permissions?.let { p ->
            val existing = tool.permission
            ToolPermission(
                id = c.toolUseId,
                status = if (p.approved) PermissionStatus.Approved else PermissionStatus.Denied,
                reason = existing?.reason,
                mode = p.mode,
                allowedTools = p.allowedTools,
                decision = p.decision ?: existing?.decision,
                date = p.date,
            )
        } ?: tool.permission
        message.tool = tool.copy(
            state = if (c.isError) ToolState.Error else ToolState.Completed,
            result = c.content,
            completedAt = createdAt,
            permission = permission,
        )
        return true
    }

    private fun sidechainOwner(sidechainId: String): ReducerMessage? {
        messageIds[sidechainId]?.let(messages::get)?.takeIf { it.tool != null }?.let { return it }
        // The first such message, in insertion order (ids are allocated in order).
        return byRealId[sidechainId].orEmpty().mapNotNull(messages::get)
            .filter { it.realID == sidechainId && it.tool != null }
            .minByOrNull { it.id.removePrefix("m").toLongOrNull() ?: Long.MAX_VALUE }
    }

    private fun indexRealId(realId: String, internalId: String) {
        byRealId.getOrPut(realId) { HashSet(2) }.add(internalId)
    }

    private fun updateLatestTodos(value: JsonElement?, timestamp: Long) {
        val todos = TodoItem.parseList(value) ?: return
        val latest = latestTodos
        if (latest == null || timestamp > latest.second) latestTodos = todos to timestamp
    }

    private fun processUsage(usage: UsageData, timestamp: Long) {
        val latest = latestUsage
        if (latest != null && timestamp <= latest.timestamp) return
        val cacheCreation = usage.cacheCreationInputTokens ?: 0
        val cacheRead = usage.cacheReadInputTokens ?: 0
        latestUsage = TimedUsage(
            ContextUsage(
                inputTokens = usage.inputTokens,
                outputTokens = usage.outputTokens,
                cacheCreation = cacheCreation,
                cacheRead = cacheRead,
                contextSize = cacheCreation + cacheRead + usage.inputTokens,
                contextWindow = usage.contextWindow?.takeIf { it > 0 }?.toLong(),
            ),
            timestamp,
        )
    }

    /** Applies one terminal send outcome without replacing the visible row. */
    private fun settleUserMessage(internalId: String, receipt: Receipt): Boolean {
        val message = messages[internalId] ?: return false
        if (!message.isUser) return false
        // A receipt positions a message once; a row that already has its
        // place never moves again.
        if (!message.pending && message.sortAt != null) return false
        message.pending = false
        message.sortAt = receipt.createdAt
        message.sendError = receipt.error
        return true
    }

    private fun joinUserMessageServerId(serverId: String, internalId: String): Boolean {
        messageIds.putIfAbsent(serverId, internalId)
        val receipt = pendingReceipts.remove(serverId) ?: return false
        return settleUserMessage(internalId, receipt)
    }

    private fun convert(m: ReducerMessage): ChatMessage? {
        m.unsupported?.let { return ChatMessage.Unsupported(m.id, m.createdAt, it) }
        val text = m.text
        val tool = m.tool
        return when {
            m.isUser && text != null -> ChatMessage.UserText(
                id = m.id, localId = m.localId, createdAt = m.createdAt, text = text,
                displayText = m.meta?.displayText?.takeIf { it.isNotEmpty() }, meta = m.meta,
                claudeUuid = m.claudeUuid?.takeIf { it.isNotEmpty() },
                codexItemId = m.codexItemId?.takeIf { it.isNotEmpty() },
                pending = m.pending, sendError = m.sendError, sortAt = m.sortAt, author = m.author,
            )
            !m.isUser && text != null -> ChatMessage.AgentText(
                id = m.id, createdAt = m.createdAt, text = text, isThinking = m.isThinking, turn = m.turn, meta = m.meta,
            )
            !m.isUser && tool != null -> ChatMessage.ToolCallMessage(
                id = m.id, createdAt = m.createdAt, tool = tool,
                children = m.realID?.let(sidechains::get).orEmpty().mapNotNull(::convert),
                turn = m.turn, meta = m.meta,
            )
            !m.isUser && m.event != null -> ChatMessage.Event(m.id, m.createdAt, m.event, m.turn, m.meta)
            else -> null
        }
    }
}

/** The CLI's request key for a dialog it read off the Mac's screen before its tool call reached the transcript. */
private const val SCREEN_REQUEST_PREFIX = "screen:"

/** The reason the CLI completes a `screen:` request with when it moved to its call's `tool_use` id. */
private const val SCREEN_REQUEST_MOVED = "moved-to-tool-call"

/** A card's time is the Mac CLI's clock and a row's is the server's record time, so a row may look a few seconds older than its card. */
private const val SCREEN_CARD_CLOCK_SKEW_MS = 5_000L

/** How long after a card was answered its tool row may still arrive; a later same-tool row is a different call. */
private const val SCREEN_CARD_ROW_WINDOW_MS = 120_000L

private fun errorResult(reason: String) = JsonObject(mapOf("error" to JsonPrimitive(reason)))

/** The call's own fields win over a permission placeholder's; other values replace. */
private fun mergeToolInputs(existing: JsonElement?, next: JsonElement?): JsonElement? {
    val a = existing.obj
    val b = next.obj
    if (a != null && b != null) return JsonObject(b + a)
    return next?.takeUnless { it.isNullOrAbsent } ?: existing
}
