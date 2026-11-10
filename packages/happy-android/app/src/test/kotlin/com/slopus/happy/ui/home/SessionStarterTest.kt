package com.slopus.happy.ui.home

import com.slopus.happy.text.Words
import com.slopus.happy.R
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.attachments.AttachmentNotice
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.model.AgentType
import com.slopus.happy.model.BotRequest
import com.slopus.happy.model.GitWorktree
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.sync.HappyAgentSpawnTarget
import com.slopus.happy.sync.SendException
import com.slopus.happy.sync.OpResult
import com.slopus.happy.sync.SpawnSessionOptions
import com.slopus.happy.sync.SpawnSessionResult
import com.slopus.happy.sync.DiscardClaudeAgentResult
import com.slopus.happy.sync.StartClaudeAgentRequest
import com.slopus.happy.sync.StartClaudeAgentResult
import com.slopus.happy.text.words
import com.slopus.happy.model.HomeModelFixtures.cliAvailability
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.Machine
import com.slopus.happy.model.NewSessionDraft
import com.slopus.happy.model.SessionType
import com.slopus.happy.model.Settings
import com.slopus.happy.model.StartPhase
import com.slopus.happy.model.WorktreeSelection
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.put
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * useStartSessionFromDraft with fake machine and session RPCs: what it
 * refuses before asking a machine, the request it builds, pending answers
 * retried, a missing directory offered, a worktree made first, Stop handing
 * the composer back while a late session is stopped, and the draft's text
 * cleared only when it was what got sent. Images go with the first message,
 * on their own too; an agent that takes none leaves the session for the
 * next Send, and what the images ran into comes back with the result.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class SessionStarterTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    private val cli = machine(
        "m1",
        machineMetadata { put("displayName", "Studio"); cliAvailability(claude = true, codex = true) },
    )
    private val rig = machine(
        "r1",
        machineMetadata {
            put("machineKind", "rig")
            putJsonObject("capabilities") { put("newSession", true); put("worktrees", true) }
            putJsonObject("defaults") { put("providerId", "codex"); put("modelId", "gpt"); put("permissionMode", "auto") }
            putJsonArray("models") {
                addJsonObject {
                    put("code", "gpt"); put("value", "GPT"); put("providerId", "codex"); put("id", "gpt")
                    putJsonArray("thinkingLevels") { add("low"); add("high") }
                    put("defaultThinkingLevel", "high")
                }
            }
            putJsonArray("operatingModes") {
                addJsonObject { put("code", "auto"); put("value", "Auto") }
                addJsonObject { put("code", "read_only"); put("value", "Read only") }
            }
        },
    )

    /** The same Happy Agent, new enough to make bots. */
    private val botRig = machine(
        "b1",
        machineMetadata {
            put("machineKind", "rig")
            putJsonObject("capabilities") { put("newSession", true); put("worktrees", true); put("bots", true) }
            putJsonObject("defaults") { put("providerId", "codex"); put("modelId", "gpt"); put("permissionMode", "auto") }
            putJsonArray("models") {
                addJsonObject {
                    put("code", "gpt"); put("value", "GPT"); put("providerId", "codex"); put("id", "gpt")
                    putJsonArray("thinkingLevels") { add("low"); add("high") }
                    put("defaultThinkingLevel", "high")
                }
            }
            putJsonArray("operatingModes") {
                addJsonObject { put("code", "auto"); put("value", "Auto") }
                addJsonObject { put("code", "read_only"); put("value", "Read only") }
            }
        },
    )

    private class FakeMachines : MachineActions {
        val spawns = mutableListOf<SpawnSessionOptions>()
        val worktrees = mutableListOf<Pair<String, String>>()
        val stopped = mutableListOf<Pair<String, String>>()
        var answers = ArrayDeque<suspend () -> SpawnSessionResult>()
        var worktree: WorktreeOutcome = WorktreeOutcome.Created("/Users/dev/code/.dev/worktree/calm-river", "calm-river")
        /** The starter's phase each time it asked for something. */
        val phases = mutableListOf<StartPhase?>()
        var phase: () -> StartPhase? = { null }

        override suspend fun spawnSession(options: SpawnSessionOptions): SpawnSessionResult {
            phases += phase()
            spawns += options
            return answers.removeFirstOrNull()?.invoke() ?: SpawnSessionResult.Success("s1")
        }

        override suspend fun createWorktree(machineId: String, basePath: String): WorktreeOutcome {
            phases += phase()
            worktrees += machineId to basePath
            return worktree
        }

        override suspend fun listWorktrees(machineId: String, basePath: String): List<GitWorktree> = emptyList()

        override suspend fun stopSession(machineId: String, sessionId: String): OpResult {
            stopped += machineId to sessionId
            order += "stop $sessionId"
            return OpResult(true)
        }

        /** Whether the daemon says it can start background sessions; false, as an older one does, unless a test says so. */
        var backgroundSupported = false
        val supportAsked = mutableListOf<String>()
        val starts = mutableListOf<StartClaudeAgentRequest>()
        var startAnswers = ArrayDeque<suspend () -> StartClaudeAgentResult>()
        val discarded = mutableListOf<Pair<String, String>>()
        /** Stops and discards, in the order they were asked for. */
        val order = mutableListOf<String>()

        override suspend fun startClaudeAgent(machineId: String, request: StartClaudeAgentRequest): StartClaudeAgentResult {
            phases += phase()
            starts += request
            return startAnswers.removeFirstOrNull()?.invoke() ?: StartClaudeAgentResult.Success("s1", "35d81094")
        }

        override suspend fun discardClaudeAgent(machineId: String, agentId: String): DiscardClaudeAgentResult {
            discarded += machineId to agentId
            order += "discard $agentId"
            return DiscardClaudeAgentResult.Success
        }

        override suspend fun backgroundStartSupported(machineId: String): Boolean {
            supportAsked += machineId
            return backgroundSupported
        }
    }

    private class FakeSessions : SessionActions {
        val killed = mutableListOf<String>()
        override suspend fun kill(sessionId: String): OpResult = OpResult(true).also { killed += sessionId }
        override suspend fun archiveOnServer(sessionId: String): OpResult = OpResult(true)
        override suspend fun delete(sessionId: String): OpResult = OpResult(true)
    }

    private class FakeSender(private val onSend: suspend () -> Boolean) : FirstMessageSender {
        val sent = mutableListOf<Pair<String, String>>()
        val attachments = mutableListOf<List<AttachmentPreview>>()
        var notices = emptyList<AttachmentNotice>()
        val pinned = mutableListOf<Pair<String, Map<AgentModeField, String?>>>()

        override suspend fun pinModes(sessionId: String, modes: Map<AgentModeField, String?>) {
            pinned += sessionId to modes
        }

        override suspend fun send(sessionId: String, text: String, attachments: List<AttachmentPreview>, isCurrent: () -> Boolean): FirstSend {
            sent += sessionId to text
            this.attachments += attachments
            return FirstSend(onSend(), notices)
        }
    }

    private class Harness(
        val starter: SessionStarter,
        val drafts: NewSessionDraftStore,
        val machines: FakeMachines,
        val sessions: FakeSessions,
        val sender: FakeSender,
    ) {
        val sent get() = sender.sent
        val phases get() = machines.phases
    }

    private fun TestScope.harness(
        machines: List<Machine> = listOf(cli),
        draft: NewSessionDraft,
        faces: BotFaceWearer = BotFaceWearer { _, _ -> null },
        background: Boolean = false,
        requestId: () -> String = { "request-1" },
        awaitSession: suspend () -> Boolean = { true },
        send: suspend (NewSessionDraftStore) -> Boolean = { true },
    ): Harness {
        val prefs = context.getSharedPreferences(NewSessionDraftStore.PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        val drafts = NewSessionDraftStore(prefs) { 7 }
        drafts.change { draft }
        val fakeMachines = FakeMachines().apply { backgroundSupported = background }
        val fakeSessions = FakeSessions()
        val sender = FakeSender { send(drafts) }
        val starter = SessionStarter(
            machines = { machines },
            sessions = { emptyList() },
            settings = { Settings() },
            drafts = drafts,
            machineActions = fakeMachines,
            sessionActions = fakeSessions,
            sender = sender,
            awaitSession = { fakeMachines.phases += fakeMachines.phase(); awaitSession() },
            scope = this,
            requestId = requestId,
            faces = faces,
        )
        fakeMachines.phase = { starter.phase.value }
        return Harness(starter, drafts, fakeMachines, fakeSessions, sender)
    }

    private val yes: suspend (String) -> Boolean = { true }

    @Test fun refusesBeforeAskingAnyMachine() = runTest {
        suspend fun refusal(draft: NewSessionDraft, machines: List<Machine> = listOf(cli)) =
            harness(machines, draft).let { h -> h.starter.start(confirmDirectory = yes).also { assertTrue(h.machines.spawns.isEmpty()) } }
        assertEquals(StartResult.Refused(StartRefusal.NoMachine), refusal(NewSessionDraft()))
        assertEquals(StartResult.Refused(StartRefusal.UnknownMachine), refusal(NewSessionDraft(selectedMachineId = "gone")))
        assertEquals(
            StartResult.Refused(StartRefusal.HappyCliOffline),
            refusal(NewSessionDraft(selectedMachineId = "m1"), listOf(cli.copy(active = false))),
        )
        assertEquals(
            StartResult.Refused(StartRefusal.ProjectNeedsHappyAgent),
            refusal(NewSessionDraft(selectedMachineId = "m1", selectedProjectId = "p1")),
        )
        val rigCannotStart = machine("r1", machineMetadata { put("machineKind", "rig") })
        assertEquals(StartResult.Refused(StartRefusal.CannotStartHappyAgent), refusal(NewSessionDraft(selectedMachineId = "r1"), listOf(rigCannotStart)))
    }

    @Test fun spawnsInTheResolvedDirectorySendsThePromptAndClearsTheDraft() = runTest {
        val h = harness(draft = NewSessionDraft(input = " fix the build ", selectedMachineId = "m1", selectedPath = "~/code", agentType = AgentType.Codex))
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        val request = h.machines.spawns.single()
        assertEquals("m1", request.machineId)
        assertEquals("codex", request.agent)
        assertEquals("/Users/dev/code", request.directory)
        assertFalse(request.approvedNewDirectoryCreation)
        assertNull(request.happyAgentTarget)
        assertEquals("request-1", request.clientRequestId)
        assertEquals(listOf("s1" to "fix the build"), h.sent)
        assertEquals("", h.drafts.draft.value.input)
        assertEquals("~/code", h.drafts.draft.value.selectedPath)
        assertEquals(listOf(StartPhase.Spawning, StartPhase.Opening), h.phases)
        assertNull(h.starter.phase.value)
        // The launch picks are pinned on the session before the send (useStartSessionFromDraft).
        val (pinnedId, modes) = h.sender.pinned.single()
        assertEquals("s1", pinnedId)
        assertEquals(request.permissionMode, modes[AgentModeField.PERMISSION_MODE])
        assertTrue(modes.containsKey(AgentModeField.MODEL_MODE))
    }

    @Test fun aRefusedFirstMessageKeepsTheSessionForTheNextSend() = runTest {
        var refuse = true
        val h = harness(draft = NewSessionDraft(input = "hi", selectedMachineId = "m1")) {
            if (refuse) throw SendException("The session has not synced yet.")
            true
        }
        assertEquals(StartResult.Failed(Words.Said("The session has not synced yet.")), h.starter.start(confirmDirectory = yes))
        assertEquals("hi", h.drafts.draft.value.input)
        refuse = false
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertEquals("spawned once", 1, h.machines.spawns.size)
        assertEquals(listOf("s1" to "hi", "s1" to "hi"), h.sent)
        assertEquals("", h.drafts.draft.value.input)
    }

    private val image = AttachmentPreview("i1", "file:///cache/a.jpg", 10, 20, "image/jpeg", 100, "a.jpg")

    @Test fun imagesGoWithTheFirstMessageEvenWithoutText() = runTest {
        val h = harness(draft = NewSessionDraft(selectedMachineId = "m1"))
        h.sender.notices = listOf(AttachmentNotice.UploadFailed(1))
        assertEquals(
            StartResult.Started("s1", listOf(AttachmentNotice.UploadFailed(1))),
            h.starter.start(attachments = listOf(image), confirmDirectory = yes),
        )
        assertEquals(listOf("s1" to ""), h.sent)
        assertEquals(listOf(listOf(image)), h.sender.attachments)
    }

    @Test fun anAgentThatTakesNoImagesKeepsTheSessionForTheNextSend() = runTest {
        var accepts = false
        val h = harness(draft = NewSessionDraft(selectedMachineId = "m1")) { accepts }
        h.sender.notices = listOf(AttachmentNotice.NotSupported)
        assertEquals(StartResult.NotSent(listOf(AttachmentNotice.NotSupported)), h.starter.start(attachments = listOf(image), confirmDirectory = yes))
        h.drafts.change { it.copy(input = "describe it instead") }
        accepts = true
        h.sender.notices = emptyList()
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertEquals("spawned once", 1, h.machines.spawns.size)
        assertEquals(listOf("s1" to "", "s1" to "describe it instead"), h.sent)
    }

    @Test fun happyAgentPicksRideTheSpawnNotTheSession() = runTest {
        val h = harness(listOf(rig), NewSessionDraft(input = "go", selectedMachineId = "r1", agentType = AgentType.Rig))
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertTrue(h.sender.pinned.isEmpty())
    }

    @Test fun textTypedWhileStartingStaysInTheDraft() = runTest {
        val h = harness(draft = NewSessionDraft(input = "first", selectedMachineId = "m1")) { drafts ->
            drafts.change { it.copy(input = "second thought") }
            true
        }
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertEquals("second thought", h.drafts.draft.value.input)
    }

    @Test fun retriesPendingAnswersWithTheSameRequestId() = runTest {
        val h = harness(draft = NewSessionDraft(selectedMachineId = "m1"))
        h.machines.answers.addAll(listOf({ SpawnSessionResult.Pending("request-1", 500) }, { SpawnSessionResult.Pending("request-1", 0) }))
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertEquals(3, h.machines.spawns.size)
        assertEquals(setOf("request-1"), h.machines.spawns.map { it.clientRequestId }.toSet())
        // No prompt, nothing to send.
        assertTrue(h.sent.isEmpty())
    }

    @Test fun offersToCreateAMissingDirectory() = runTest {
        val approved = harness(draft = NewSessionDraft(selectedMachineId = "m1", selectedPath = "/new"))
        approved.machines.answers.add { SpawnSessionResult.RequestToApproveDirectoryCreation("/new") }
        val asked = mutableListOf<String>()
        assertEquals(StartResult.Started("s1"), approved.starter.start { asked += it; true })
        assertEquals(listOf("/new"), asked)
        assertEquals(listOf(false, true), approved.machines.spawns.map { it.approvedNewDirectoryCreation })

        val declined = harness(draft = NewSessionDraft(selectedMachineId = "m1", selectedPath = "/new"))
        declined.machines.answers.add { SpawnSessionResult.RequestToApproveDirectoryCreation("/new") }
        assertEquals(StartResult.Abandoned, declined.starter.start { false })
        assertEquals(1, declined.machines.spawns.size)
    }

    @Test fun createsTheWorktreeFirstAndSpawnsInsideIt() = runTest {
        val h = harness(
            draft = NewSessionDraft(selectedMachineId = "m1", selectedPath = "/Users/dev/code", sessionType = SessionType.Worktree, worktreeKey = WorktreeSelection.NEW),
        )
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertEquals(listOf("m1" to "/Users/dev/code"), h.machines.worktrees)
        assertEquals("/Users/dev/code/.dev/worktree/calm-river", h.machines.spawns.single().directory)
        assertEquals(listOf(StartPhase.Worktree, StartPhase.Spawning, StartPhase.Opening), h.phases)

        val failed = harness(draft = h.drafts.draft.value)
        failed.machines.worktree = WorktreeOutcome.Failed(Words.Said("fatal: not a git repository"))
        assertEquals(StartResult.Failed(Words.Said("fatal: not a git repository")), failed.starter.start(confirmDirectory = yes))
        failed.machines.worktree = WorktreeOutcome.Failed(Words.ours(R.string.home_worktree_not_git))
        assertEquals(StartResult.Failed(Words.ours(R.string.home_worktree_not_git)), failed.starter.start(confirmDirectory = yes))
        assertTrue(failed.machines.spawns.isEmpty())
    }

    @Test fun happyAgentStartsInItsProjectByIdentity() = runTest {
        val h = harness(
            listOf(rig),
            NewSessionDraft(selectedMachineId = "r1", selectedProjectId = "p1", agentType = AgentType.Claude, modelMode = "claude-opus-5-5", permissionMode = "read_only"),
        )
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        val request = h.machines.spawns.single()
        assertEquals("rig", request.agent)
        assertEquals(HappyAgentSpawnTarget.Project("p1"), request.happyAgentTarget)
        // The harness changed, so Happy Agent's own catalog defaults apply, not Claude's picks.
        assertEquals(listOf("codex", "gpt", "auto", "high"), listOf(request.providerId, request.modelId, request.permissionMode, request.effort))
        assertNull(request.modelMode)
        assertTrue(h.machines.worktrees.isEmpty())
    }

    @Test fun happyAgentKeepsThePicksItsCatalogStillOffers() = runTest {
        val h = harness(
            listOf(rig),
            NewSessionDraft(selectedMachineId = "r1", agentType = AgentType.Rig, modelMode = "codex:gone", permissionMode = "read_only", effortLevel = "low"),
        )
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        val request = h.machines.spawns.single()
        assertEquals(listOf("codex", "gpt", "read_only", "low"), listOf(request.providerId, request.modelId, request.permissionMode, request.effort))
        // A plain directory: no catalog destination.
        assertNull(request.happyAgentTarget)
    }

    @Test fun stopHandsBackAtOnceAndStopsTheSessionThatArrivesLater() = runTest {
        val h = harness(draft = NewSessionDraft(input = "hi", selectedMachineId = "m1"))
        val late = CompletableDeferred<SpawnSessionResult>()
        h.machines.answers.add { late.await() }
        val result = async { h.starter.start(confirmDirectory = yes) }
        runCurrent()
        assertEquals(StartPhase.Spawning, h.starter.phase.value)
        h.starter.cancel()
        assertNull(h.starter.phase.value)
        runCurrent()
        assertEquals(StartResult.Abandoned, result.await())

        late.complete(SpawnSessionResult.Success("late"))
        advanceUntilIdle()
        assertEquals(listOf("m1" to "late"), h.machines.stopped)
        assertTrue(h.sent.isEmpty())
        assertEquals("the composer keeps its text", "hi", h.drafts.draft.value.input)
    }

    @Test fun stopWhileOpeningStopsTheSessionItAlreadyHas() = runTest {
        val opened = CompletableDeferred<Boolean>()
        val prefs = context.getSharedPreferences(NewSessionDraftStore.PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        val drafts = NewSessionDraftStore(prefs).apply { change { NewSessionDraft(input = "hi", selectedMachineId = "r1", agentType = AgentType.Rig) } }
        val machines = FakeMachines()
        val sessions = FakeSessions()
        val starter = SessionStarter(
            { listOf(rig) }, { emptyList() }, { Settings() }, drafts, machines, sessions,
            FakeSender { true }, { opened.await() }, this,
        )
        val result = async { starter.start(confirmDirectory = yes) }
        runCurrent()
        assertEquals(StartPhase.Opening, starter.phase.value)
        starter.cancel()
        advanceUntilIdle()
        assertEquals(StartResult.Abandoned, result.await())
        // Happy Agent's session is killed, not asked of the daemon.
        assertEquals(listOf("s1"), sessions.killed)
        assertTrue(machines.stopped.isEmpty())
    }

    /**
     * useStartSessionFromDraft's bot: Happy Agent's spawn with the bot as its
     * destination, whatever harness the draft chose; no first message (the
     * prompt stays in the draft); then "Putting on a face…". A face that
     * fails is reported, never a reason to lose the bot.
     */
    @Test fun aBotIsMadeOnHappyAgentThenWearsItsFace() = runTest {
        val worn = mutableListOf<Pair<String, String>>()
        val h = harness(
            listOf(botRig),
            NewSessionDraft(input = "keep me", selectedMachineId = "b1", selectedPath = "~/code", agentType = AgentType.Claude),
            faces = { id, seed -> worn += id to seed; null },
        )
        val result = h.starter.start(bot = BotRequest("Release Bot", "seed0001"), confirmDirectory = yes)
        assertEquals(StartResult.Started("s1"), result)
        val request = h.machines.spawns.single()
        assertEquals("rig", request.agent)
        assertEquals(HappyAgentSpawnTarget.Bot("Release Bot"), request.happyAgentTarget)
        assertEquals(listOf("s1" to "seed0001"), worn)
        assertTrue(h.sent.isEmpty())
        assertEquals("keep me", h.drafts.draft.value.input)
    }

    @Test fun aFaceThatFailsLeavesTheBotForARetry() = runTest {
        val failure = BotFaceFailure(BotFaceLeg.Uploading, "offline")
        val h = harness(listOf(botRig), NewSessionDraft(selectedMachineId = "b1"), faces = { _, _ -> failure })
        assertEquals(StartResult.Started("s1", faceFailure = failure), h.starter.start(bot = BotRequest("Ada", "s"), confirmDirectory = yes))
        assertTrue(h.sessions.killed.isEmpty())
    }

    @Test fun anOlderHappyAgentOrABadNameMakesNoBot() = runTest {
        val old = harness(listOf(rig), NewSessionDraft(selectedMachineId = "r1"))
        assertEquals(StartResult.Refused(StartRefusal.BotsUnsupported), old.starter.start(bot = BotRequest("Ada", "s"), confirmDirectory = yes))
        val blank = harness(listOf(botRig), NewSessionDraft(selectedMachineId = "b1"))
        assertEquals(StartResult.Failed(Words.ours(R.string.home_bot_name_empty)), blank.starter.start(bot = BotRequest("  ", "s"), confirmDirectory = yes))
        assertTrue(old.machines.spawns.isEmpty() && blank.machines.spawns.isEmpty())
    }

    /** The same Happy Agent, new enough to make tasks too. */
    private val taskRig = machine(
        "t1",
        machineMetadata {
            put("machineKind", "rig")
            putJsonObject("capabilities") { put("newSession", true); put("bots", true); put("tasks", true) }
            putJsonObject("defaults") { put("providerId", "codex"); put("modelId", "gpt"); put("permissionMode", "auto") }
            putJsonArray("models") {
                addJsonObject {
                    put("code", "gpt"); put("value", "GPT"); put("providerId", "codex"); put("id", "gpt")
                    putJsonArray("thinkingLevels") { add("low"); add("high") }
                    put("defaultThinkingLevel", "high")
                }
            }
            putJsonArray("operatingModes") { addJsonObject { put("code", "auto"); put("value", "Auto") } }
        },
    )

    /**
     * happy-ios 36b11c5bf / 500c1c485: a task is Happy Agent's spawn with
     * `target: {kind: "task"}` alone, whatever harness the draft chose, then
     * the text as its first message; the draft's text is cleared.
     */
    @Test fun aTaskIsMadeOnHappyAgentWithItsFirstMessage() = runTest {
        val h = harness(listOf(taskRig), NewSessionDraft(input = "Ship the release", selectedMachineId = "t1", selectedPath = "~/code", agentType = AgentType.Claude))
        assertEquals(StartResult.Started("s1"), h.starter.start(task = true, confirmDirectory = yes))
        val request = h.machines.spawns.single()
        assertEquals("rig", request.agent)
        assertEquals(HappyAgentSpawnTarget.Task, request.happyAgentTarget)
        assertEquals("""{"kind":"task"}""", request.happyAgentTarget!!.toJson().toString())
        assertEquals("request-1", request.clientRequestId)
        assertEquals(listOf("s1" to "Ship the release"), h.sent)
        assertEquals("", h.drafts.draft.value.input)
    }

    @Test fun anOlderHappyAgentMakesNoTask() = runTest {
        val h = harness(listOf(botRig), NewSessionDraft(input = "x", selectedMachineId = "b1"))
        assertEquals(StartResult.Refused(StartRefusal.TasksUnsupported), h.starter.start(task = true, confirmDirectory = yes))
        assertTrue(h.machines.spawns.isEmpty())
    }

    /** The empty chat's bot (500c1c485) takes the text sent as its first message, after its face. */
    @Test fun aComposeChatBotSendsItsFirstMessage() = runTest {
        val h = harness(listOf(botRig), NewSessionDraft(input = "Own releases", selectedMachineId = "b1"))
        assertEquals(StartResult.Started("s1"), h.starter.start(bot = BotRequest("Release Bot", "seed"), botMessage = true, confirmDirectory = yes))
        assertEquals(HappyAgentSpawnTarget.Bot("Release Bot"), h.machines.spawns.single().happyAgentTarget)
        assertEquals(listOf("s1" to "Own releases"), h.sent)
        assertEquals("", h.drafts.draft.value.input)
    }

    private val claudeChat = NewSessionDraft(
        input = " fix the login bug\nand the logout ",
        selectedMachineId = "m1",
        selectedPath = "/Users/tester/project",
        agentType = AgentType.Claude,
    )

    /**
     * A new Claude chat where the daemon can start background sessions:
     * `start-claude-agent` in the folder, named from the first line, then
     * the same wait and first send as a spawned session. The picks ride the
     * start; the mirror takes no mode changes, so nothing is pinned.
     */
    @Test fun claudeChatsStartAsBackgroundSessions() = runTest {
        val h = harness(draft = claudeChat, background = true)
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertTrue(h.machines.spawns.isEmpty())
        val request = h.machines.starts.single()
        assertEquals("/Users/tester/project", request.directory)
        assertEquals("fix the login bug", request.name)
        assertEquals("request-1", request.clientRequestId)
        assertFalse(request.approvedNewDirectoryCreation)
        assertEquals(listOf("m1"), h.machines.supportAsked)
        assertEquals(listOf("s1" to "fix the login bug\nand the logout"), h.sent)
        assertTrue(h.sender.pinned.isEmpty())
        assertEquals("", h.drafts.draft.value.input)
        assertEquals(listOf(StartPhase.Spawning, StartPhase.Opening), h.phases)

        // No text: named after its folder.
        val bare = harness(draft = claudeChat.copy(input = ""), background = true)
        assertEquals(StartResult.Started("s1"), bare.starter.start(attachments = listOf(image), confirmDirectory = yes))
        assertEquals("project", bare.machines.starts.single().name)
    }

    @Test fun codexAndForksKeepTheRegularPath() = runTest {
        val codex = harness(draft = claudeChat.copy(agentType = AgentType.Codex), background = true)
        assertEquals(StartResult.Started("s1"), codex.starter.start(confirmDirectory = yes))
        assertEquals("codex", codex.machines.spawns.single().agent)
        assertTrue(codex.machines.starts.isEmpty())
        assertTrue("Codex never asks", codex.machines.supportAsked.isEmpty())

        // A bot and a task are Happy Agent's, whatever harness the draft chose.
        val bot = harness(listOf(botRig), claudeChat.copy(selectedMachineId = "b1"), background = true)
        assertEquals(StartResult.Started("s1"), bot.starter.start(bot = BotRequest("Release Bot", "seed"), confirmDirectory = yes))
        val task = harness(listOf(taskRig), claudeChat.copy(selectedMachineId = "t1"), background = true)
        assertEquals(StartResult.Started("s1"), task.starter.start(task = true, confirmDirectory = yes))
        for (h in listOf(bot, task)) {
            assertEquals("rig", h.machines.spawns.single().agent)
            assertTrue(h.machines.starts.isEmpty())
        }

        // Claude picked on a Happy Agent computer is Happy Agent's spawn too.
        val rigClaude = harness(listOf(rig), NewSessionDraft(input = "go", selectedMachineId = "r1", agentType = AgentType.Claude), background = true)
        assertEquals(StartResult.Started("s1"), rigClaude.starter.start(confirmDirectory = yes))
        assertTrue(rigClaude.machines.starts.isEmpty())
    }

    @Test fun unsupportedMachinesKeepTheRegularPath() = runTest {
        val h = harness(draft = claudeChat, background = false)
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertEquals(listOf("m1"), h.machines.supportAsked)
        val request = h.machines.spawns.single()
        assertEquals("claude", request.agent)
        assertEquals("/Users/tester/project", request.directory)
        assertTrue(h.machines.starts.isEmpty())
        assertEquals("the regular session pins its picks", 1, h.sender.pinned.size)
    }

    /**
     * Review focus 2: a start whose answer never came back (the call failed)
     * is asked again under the same request id, so the daemon answers with
     * the session it already started; one the Mac answered is asked afresh.
     */
    @Test fun retriesReuseTheSameRequestIdForBackgroundStarts() = runTest {
        var next = 0
        val h = harness(draft = claudeChat, background = true, requestId = { "request-${++next}" })
        h.machines.startAnswers.add { StartClaudeAgentResult.Failed(StartClaudeAgentResult.CALL_FAILED, "Timed out") }
        assertEquals(StartResult.Failed(Words.Said("Timed out")), h.starter.start(confirmDirectory = yes))
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertEquals(listOf("request-1", "request-1"), h.machines.starts.map { it.clientRequestId })
        assertEquals(listOf("s1" to "fix the login bug\nand the logout"), h.sent)

        // The Mac said it failed: that answer is kept under its id for a while, so the next Send uses a new one.
        h.drafts.change { claudeChat }
        h.machines.startAnswers.add { StartClaudeAgentResult.Failed("start-failed", "The session never appeared.") }
        assertEquals(StartResult.Failed(Words.Said("The session never appeared.")), h.starter.start(confirmDirectory = yes))
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertEquals(listOf("request-1", "request-1", "request-2", "request-3"), h.machines.starts.map { it.clientRequestId })
    }

    @Test fun untrustedFolderReturnsARefusalThatCanOpenARegularSession() = runTest {
        val h = harness(draft = claudeChat, background = true)
        h.machines.startAnswers.add {
            StartClaudeAgentResult.Untrusted("/Users/tester/project", "Workspace not trusted. Run `claude` in /Users/tester/project once and accept the trust prompt, then retry.")
        }
        val refused = h.starter.start(confirmDirectory = yes)
        assertEquals(StartResult.Refused(StartRefusal.UntrustedFolder("/Users/tester/project")), refused)
        assertEquals(
            "Claude on the Mac doesn't trust /Users/tester/project yet. Open a terminal there, run `claude` once and accept the prompt, then try again.",
            context.resources.words((refused as StartResult.Refused).refusal.words),
        )
        assertEquals("the draft stays for the next try", claudeChat.input, h.drafts.draft.value.input)
        assertTrue(h.sent.isEmpty())

        assertEquals(StartResult.Started("s1"), h.starter.start(forceRegular = true, confirmDirectory = yes))
        val spawn = h.machines.spawns.single()
        assertEquals("claude", spawn.agent)
        assertEquals("/Users/tester/project", spawn.directory)
        assertEquals("one background start, then the regular session", 1, h.machines.starts.size)
        assertEquals(listOf("s1" to "fix the login bug\nand the logout"), h.sent)
    }

    @Test fun backgroundStartsAskBeforeCreatingAMissingFolder() = runTest {
        val h = harness(draft = claudeChat.copy(selectedPath = "/Users/tester/project/new"), background = true)
        h.machines.startAnswers.add { StartClaudeAgentResult.NeedsDirectoryApproval("/Users/tester/project/new") }
        val asked = mutableListOf<String>()
        assertEquals(StartResult.Started("s1"), h.starter.start { asked += it; true })
        assertEquals(listOf("/Users/tester/project/new"), asked)
        assertEquals(listOf(false, true), h.machines.starts.map { it.approvedNewDirectoryCreation })
        // The approval goes under the same id: the daemon keeps no answer but a started session, so it hears it.
        assertEquals(listOf("request-1", "request-1"), h.machines.starts.map { it.clientRequestId })

        val declined = harness(draft = claudeChat.copy(selectedPath = "/Users/tester/project/new"), background = true)
        declined.machines.startAnswers.add { StartClaudeAgentResult.NeedsDirectoryApproval("/Users/tester/project/new") }
        assertEquals(StartResult.Abandoned, declined.starter.start { false })
        assertEquals(1, declined.machines.starts.size)
    }

    /**
     * Approved, then the answer never came back: the next Send asks under the
     * same id, so it joins the approved start (running or done) on the Mac
     * rather than starting a second session in the folder now made.
     */
    @Test fun anApprovedStartWhoseAnswerWasLostIsRetriedUnderTheSameId() = runTest {
        var next = 0
        val h = harness(draft = claudeChat.copy(selectedPath = "/Users/tester/project/new"), background = true, requestId = { "request-${++next}" })
        h.machines.startAnswers.add { StartClaudeAgentResult.NeedsDirectoryApproval("/Users/tester/project/new") }
        h.machines.startAnswers.add { StartClaudeAgentResult.Failed(StartClaudeAgentResult.CALL_FAILED, "Timed out") }
        assertEquals(StartResult.Failed(Words.Said("Timed out")), h.starter.start(confirmDirectory = yes))
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertEquals(listOf("request-1", "request-1", "request-1"), h.machines.starts.map { it.clientRequestId })
    }

    /** A start stopped after the Mac made it is put down; the next Send is a new start under a new id. */
    @Test fun aStartStoppedAfterCreationIsAskedAfreshNextTime() = runTest {
        var next = 0
        val opened = CompletableDeferred<Boolean>()
        var waits = 0
        val h = harness(draft = claudeChat, background = true, requestId = { "request-${++next}" }, awaitSession = { if (waits++ == 0) opened.await() else true })
        val result = async { h.starter.start(confirmDirectory = yes) }
        runCurrent()
        assertEquals(StartPhase.Opening, h.starter.phase.value)
        h.starter.cancel()
        advanceUntilIdle()
        assertEquals(StartResult.Abandoned, result.await())
        assertEquals(listOf("m1" to "35d81094"), h.machines.discarded)

        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertEquals(listOf("request-1", "request-2"), h.machines.starts.map { it.clientRequestId })
    }

    /** Stop once the Mac session is made: its mirror is stopped, then the Mac session this start made is discarded. */
    @Test fun abandoningABackgroundStartDiscardsTheMacSession() = runTest {
        val opened = CompletableDeferred<Boolean>()
        val h = harness(draft = claudeChat, background = true, awaitSession = { opened.await() })
        val result = async { h.starter.start(confirmDirectory = yes) }
        runCurrent()
        assertEquals(StartPhase.Opening, h.starter.phase.value)
        h.starter.cancel()
        advanceUntilIdle()
        assertEquals(StartResult.Abandoned, result.await())
        assertEquals(listOf("stop s1", "discard 35d81094"), h.machines.order)
        assertEquals(listOf("m1" to "35d81094"), h.machines.discarded)
        assertTrue(h.sent.isEmpty())

        // Stop while the Mac is still starting it: what arrives afterwards is put down the same way.
        val late = CompletableDeferred<StartClaudeAgentResult>()
        val slow = harness(draft = claudeChat, background = true)
        slow.machines.startAnswers.add { late.await() }
        val pending = async { slow.starter.start(confirmDirectory = yes) }
        runCurrent()
        slow.starter.cancel()
        runCurrent()
        assertEquals(StartResult.Abandoned, pending.await())
        late.complete(StartClaudeAgentResult.Success("late", "0badc0de"))
        advanceUntilIdle()
        assertEquals(listOf("stop late", "discard 0badc0de"), slow.machines.order)
    }

    @Test fun abandoningARegularStartDoesNotDiscard() = runTest {
        val opened = CompletableDeferred<Boolean>()
        val h = harness(draft = claudeChat, background = false, awaitSession = { opened.await() })
        val result = async { h.starter.start(confirmDirectory = yes) }
        runCurrent()
        h.starter.cancel()
        advanceUntilIdle()
        assertEquals(StartResult.Abandoned, result.await())
        assertEquals(listOf("m1" to "s1"), h.machines.stopped)
        assertTrue(h.machines.discarded.isEmpty())
    }

    @Test fun worktreeChatsStartInsideTheNewWorktree() = runTest {
        val worktreeChat = claudeChat.copy(sessionType = SessionType.Worktree, worktreeKey = WorktreeSelection.NEW)
        val h = harness(draft = worktreeChat, background = true)
        h.machines.worktree = WorktreeOutcome.Created("/Users/tester/project/.dev/worktree/calm-river", "calm-river")
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertEquals(listOf("m1" to "/Users/tester/project"), h.machines.worktrees)
        assertEquals("/Users/tester/project/.dev/worktree/calm-river", h.machines.starts.single().directory)
        assertEquals("fix the login bug", h.machines.starts.single().name)
        assertEquals(listOf(StartPhase.Worktree, StartPhase.Spawning, StartPhase.Opening), h.phases)

        // No text: named after the new worktree's folder, which only the worktree step knows.
        val bare = harness(draft = worktreeChat.copy(input = ""), background = true)
        bare.machines.worktree = WorktreeOutcome.Created("/Users/tester/project/.dev/worktree/calm-river", "calm-river")
        bare.starter.start(attachments = listOf(image), confirmDirectory = yes)
        assertEquals("calm-river", bare.machines.starts.single().name)
    }
}
