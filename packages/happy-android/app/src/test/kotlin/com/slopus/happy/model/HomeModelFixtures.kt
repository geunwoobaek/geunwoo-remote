package com.slopus.happy.model

import com.slopus.happy.sync.ClaudeAgentEntry
import com.slopus.happy.sync.ClaudeAgentsListing
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/** Fixtures for the Home model tests: sessions and machines built the way the store hands them out. */
object HomeModelFixtures {
    fun metadata(path: String = "/repo", host: String = "localhost", extra: JsonObjectBuilder.() -> Unit = {}): SessionMetadata {
        val json = buildJsonObject {
            put("path", path)
            put("host", host)
            extra()
        }
        return requireNotNull(SessionMetadata.parse(json)) { "fixture metadata must parse: $json" }
    }

    fun session(
        id: String,
        metadata: SessionMetadata? = metadata(),
        active: Boolean = true,
        activeAt: Long = if (active) 1 else 0,
        createdAt: Long = 0,
        projectId: String? = null,
        thinking: Boolean = false,
        attention: AgentAttention = AgentAttention.None,
        lastMessageSentAt: Long? = null,
        draft: String? = null,
        avatar: ProjectAvatar? = null,
    ) = Session(
        id = id,
        seq = 0,
        createdAt = createdAt,
        updatedAt = 0,
        active = active,
        activeAt = activeAt,
        projectId = projectId,
        metadata = metadata,
        metadataVersion = 0,
        attention = attention,
        agentStateVersion = 0,
        thinking = thinking,
        draft = draft,
        lastMessageSentAt = lastMessageSentAt,
        avatar = avatar,
    )

    /** A Rig (Happy Agent) session's metadata, optionally in a project and worktree. */
    fun rigMetadata(
        path: String = "/repo",
        machineId: String = "machine-1",
        projectId: String? = null,
        projectName: String = "Repo",
        workspaceId: String? = null,
        workspaceName: String = "wt",
        homeDir: String? = null,
        extra: JsonObjectBuilder.() -> Unit = {},
    ) = metadata(path = path) {
        put("machineId", machineId)
        homeDir?.let { put("homeDir", it) }
        putJsonObject("client") {
            put("id", "rig")
            put("name", "Rig")
            put("version", "test")
        }
        if (projectId != null) {
            putJsonObject("project") {
                put("id", projectId)
                put("kind", "regular")
                put("name", projectName)
            }
        }
        if (workspaceId != null) {
            putJsonObject("workspace") {
                put("id", workspaceId)
                put("kind", "git_worktree")
                put("name", workspaceName)
            }
        }
        extra()
    }

    /**
     * A Happy session mirroring Mac background session [agentId] on [machineId]
     * ([isClaudeAgentMirror]); [archived] as its machine archives it.
     */
    fun mirror(
        id: String,
        agentId: String,
        machineId: String = "m1",
        path: String = "/Users/tester/project",
        name: String? = null,
        active: Boolean = true,
        archived: Boolean = false,
        lastMessageSentAt: Long? = null,
    ) = session(
        id,
        metadata = metadata(path = path) {
            put("machineId", machineId)
            put("claudeAgentId", agentId)
            name?.let { put("name", it) }
            if (archived) put("lifecycleState", "archived")
        },
        active = active,
        lastMessageSentAt = lastMessageSentAt,
    )

    /** One Mac background session as `list-claude-agents` lists it. */
    fun claudeAgent(
        id: String,
        cwd: String = "/Users/tester/project",
        status: String = "idle",
        name: String? = null,
        startedAt: Long = 0,
        mirrorSessionId: String? = null,
        state: String? = null,
        lastLine: String? = null,
    ) = ClaudeAgentEntry(id, "claude-$id", name, cwd, status, startedAt, mirrorSessionId, state, lastLine)

    /** A machine's listing of [agents]. */
    fun listing(vararg agents: ClaudeAgentEntry, unavailable: String? = null) = ClaudeAgentsListing(agents.toList(), unavailable)

    fun machineMetadata(host: String = "laptop.local", extra: JsonObjectBuilder.() -> Unit = {}): MachineMetadata {
        val json = buildJsonObject {
            put("host", host)
            put("platform", "darwin")
            put("happyCliVersion", "1.0.0")
            put("happyHomeDir", "/Users/dev/.happy")
            put("homeDir", "/Users/dev")
            extra()
        }
        return requireNotNull(MachineMetadata.parse(json)) { "fixture machine metadata must parse: $json" }
    }

    fun machine(id: String, metadata: MachineMetadata? = machineMetadata(), active: Boolean = true, activeAt: Long = 0) = Machine(
        id = id,
        seq = 0,
        createdAt = 0,
        updatedAt = 0,
        active = active,
        activeAt = activeAt,
        metadata = metadata,
        metadataVersion = 0,
        daemonState = null,
        daemonStateVersion = 0,
    )

    fun JsonObjectBuilder.cliAvailability(
        claude: Boolean = false,
        codex: Boolean = false,
        gemini: Boolean = false,
        openclaw: Boolean = false,
        agy: Boolean? = null,
        rig: Boolean? = null,
    ) = putJsonObject("cliAvailability") {
        put("claude", claude)
        put("codex", codex)
        put("gemini", gemini)
        put("openclaw", openclaw)
        agy?.let { put("agy", it) }
        rig?.let { put("rig", it) }
        put("detectedAt", 1)
    }

    val EMPTY = JsonObject(emptyMap())
}
