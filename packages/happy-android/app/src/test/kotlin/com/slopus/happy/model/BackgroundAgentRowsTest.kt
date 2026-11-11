package com.slopus.happy.model

import com.slopus.happy.model.HomeModelFixtures.claudeAgent
import com.slopus.happy.model.HomeModelFixtures.listing
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.mirror
import com.slopus.happy.sync.ClaudeAgentsListing
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneOffset

/** The Mac's background sessions folded into the home's rows: one row each, never in the archive while they run. */
class BackgroundAgentRowsTest {
    private val zone = ZoneOffset.UTC
    private val today = LocalDate.of(2026, 11, 10)

    private fun items(sessions: List<Session>, listings: Map<String, ClaudeAgentsListing>, opening: Set<String> = emptySet()) =
        buildSessionListViewData(
            SessionListInputs(sessions, emptyMap(), sources = mergeBackgroundAgents(sessions, listings, opening)),
            zone,
            today,
        )

    /** Every row the list holds, live (project cards) and archived, in order. */
    private fun rows(items: List<SessionListItem>): List<SessionRowData> = items.flatMap { item ->
        when (item) {
            is SessionListItem.ProjectItem -> item.project.workspaces.flatMap { it.sessions }
            is SessionListItem.SessionItem -> listOf(item.session)
            else -> emptyList()
        }
    }

    @Test
    fun anUnopenedAgentBecomesARow() {
        val agent = claudeAgent("a1", status = "idle", startedAt = 1_700_000_000_000)
        val sources = mergeBackgroundAgents(emptyList(), mapOf("m1" to listing(agent)), emptySet())
        val row = (sources.single() as SessionRowSource.Agent).row
        assertEquals("agent:m1:a1", row.id)
        assertEquals("m1:/Users/tester/project", row.avatarId)
        assertEquals("project", row.name)
        assertEquals("/Users/tester/project", row.path)
        assertEquals("m1", row.machineId)
        assertEquals(1_700_000_000_000, row.createdAt)
        assertEquals(1_700_000_000_000, row.lastActivityAt)
        assertEquals(SessionState.Waiting, row.state)
        assertTrue(row.active)
        assertFalse(row.archived)
        assertFalse(row.opening)
        assertTrue(row.isBackgroundAgent)

        // A named session goes by its name, and shows its open in flight.
        val named = mergeBackgroundAgents(emptyList(), mapOf("m1" to listing(agent.copy(name = "Demo"))), setOf("a1"))
        val namedRow = (named.single() as SessionRowSource.Agent).row
        assertEquals("Demo", namedRow.name)
        assertTrue(namedRow.opening)
    }

    @Test
    fun anUnopenedAgentTakesItsMachinesNameAndHome() {
        val machines = mapOf("m1" to machine("m1", machineMetadata { put("displayName", "Studio"); put("homeDir", "/Users/tester") }))
        val sessions = emptyList<Session>()
        val sources = mergeBackgroundAgents(sessions, mapOf("m1" to listing(claudeAgent("a1"))), emptySet())
        val row = rows(buildSessionListViewData(SessionListInputs(sessions, machines, sources = sources), zone, today)).single()
        assertEquals("Studio", row.machineName)
        assertEquals("~/project", row.subtitle)
        assertFalse(row.machineOffline)
    }

    @Test
    fun anOpenedAgentShowsOnlyItsHappySession() {
        val sessions = listOf(mirror("s1", "a1", name = "Demo"))
        val listings = mapOf("m1" to listing(claudeAgent("a1", mirrorSessionId = "s1")))
        val sources = mergeBackgroundAgents(sessions, listings, emptySet())
        assertEquals(1, sources.size)
        assertEquals("a1", (sources.single() as SessionRowSource.Stored).liveAgent?.id)
        assertEquals(listOf("s1"), rows(items(sessions, listings)).map { it.id })
    }

    @Test
    fun archivedMirrorOfALiveAgentStaysInTheLiveList() {
        val sessions = listOf(mirror("s1", "a1", active = false, archived = true))
        val listings = mapOf("m1" to listing(claudeAgent("a1", status = "busy")))
        val all = items(sessions, listings)
        assertTrue(all.none { it is SessionListItem.SessionItem || it is SessionListItem.Header })
        assertFalse(hasArchivedSessions(all))
        val row = rows(all).single()
        assertEquals("s1", row.id)
        assertTrue(row.active)
        assertFalse(row.archived)
        // Its mirror is gone: the row says what the Mac session is doing.
        assertEquals(SessionState.Thinking, row.state)
        // Still there with the archive hidden.
        assertEquals(listOf("s1"), rows(visibleSessionListItems(all, hideArchived = true)).map { it.id })
    }

    @Test
    fun aFinishedAgentsMirrorGoesToTheArchive() {
        val sessions = listOf(mirror("s1", "a1", active = false, archived = true))
        val all = items(sessions, mapOf("m1" to listing()))
        val archived = all.filterIsInstance<SessionListItem.SessionItem>().single().session
        assertEquals("s1", archived.id)
        assertTrue(archived.archived)
        assertTrue(all.none { it is SessionListItem.ProjectItem })
    }

    @Test
    fun aMachineThatCannotListKeepsItsMirrorsWhereTheyAre() {
        val sessions = listOf(mirror("s1", "a1", active = false, archived = true))
        val all = items(sessions, mapOf("m1" to ClaudeAgentsListing(listOf(claudeAgent("a1")), "tmux-missing")))
        assertTrue(all.filterIsInstance<SessionListItem.SessionItem>().single().session.archived)
        assertEquals(listOf("s1"), rows(all).map { it.id })
    }

    @Test
    fun sameAgentIdOnTwoMachinesStaysTwoRows() {
        val listings = mapOf("m1" to listing(claudeAgent("a1")), "m2" to listing(claudeAgent("a1")))
        assertEquals(setOf("agent:m1:a1", "agent:m2:a1"), rows(items(emptyList(), listings)).map { it.id }.toSet())
        // Opened on one machine only: that one is its mirror, the other is still a row of its own.
        val sessions = listOf(mirror("s1", "a1", machineId = "m1"))
        assertEquals(setOf("s1", "agent:m2:a1"), rows(items(sessions, listings)).map { it.id }.toSet())
    }

    @Test
    fun twoMirrorsOfOneLiveAgentShowOneLiveRow() {
        // Opened, archived, then opened again as a new session: the session the daemon names stays live.
        val sessions = listOf(
            mirror("old", "a1", active = false, archived = true, lastMessageSentAt = 2_000),
            mirror("new", "a1", active = true, lastMessageSentAt = 1_000),
        )
        val all = items(sessions, mapOf("m1" to listing(claudeAgent("a1", mirrorSessionId = "new"))))
        val live = all.filterIsInstance<SessionListItem.ProjectItem>().flatMap { p -> p.project.workspaces.flatMap { it.sessions } }
        assertEquals(listOf("new"), live.map { it.id })
        assertEquals(listOf("old"), all.filterIsInstance<SessionListItem.SessionItem>().map { it.session.id })
    }

    @Test
    fun busyAgentShimmersAndWaitingAgentShowsTheOrangeDot() {
        val listings = mapOf("m1" to listing(claudeAgent("busy", status = "busy"), claudeAgent("waiting", status = "waiting"), claudeAgent("idle", status = "idle")))
        val byId = rows(items(emptyList(), listings)).associateBy { it.id }
        val busy = resolveFlatRowPresentation(byId.getValue("agent:m1:busy").state, hasUnread = false, faded = false)
        assertTrue(busy.shimmerTitle)
        assertEquals(FlatRowTopRight.Timestamp, busy.topRight)
        val waiting = resolveFlatRowPresentation(byId.getValue("agent:m1:waiting").state, hasUnread = false, faded = false)
        assertFalse(waiting.shimmerTitle)
        assertEquals(FlatRowTopRight.Dot(blocked = true), waiting.topRight)
        val idle = resolveFlatRowPresentation(byId.getValue("agent:m1:idle").state, hasUnread = false, faded = false)
        assertEquals(FlatRowPresentation(false, FlatRowTopRight.Timestamp), idle)
    }

    @Test
    fun theMacsStateOutranksItsStatus() {
        val listings = mapOf(
            "m1" to listing(
                // Done with a shell still open: `claude agents` lists it under Completed, not Working.
                claudeAgent("done", status = "busy", state = "done"),
                claudeAgent("blocked", status = "idle", state = "blocked"),
                claudeAgent("working", status = "idle", state = "working"),
                claudeAgent("unknown", status = "busy", state = "later"),
            ),
        )
        val byId = rows(items(emptyList(), listings)).associateBy { it.id }
        assertEquals(SessionState.Waiting, byId.getValue("agent:m1:done").state)
        assertEquals(SessionState.InputRequired, byId.getValue("agent:m1:blocked").state)
        assertEquals(SessionState.Thinking, byId.getValue("agent:m1:working").state)
        assertEquals(SessionState.Thinking, byId.getValue("agent:m1:unknown").state)
    }

    @Test
    fun aMirrorTakesTheNameTheMacSessionHasNow() {
        val sessions = listOf(mirror("s1", "a1", name = "old-auto-name", active = false))
        val listings = mapOf("m1" to listing(claudeAgent("a1", name = "Renamed on the Mac", status = "busy", state = "working")))
        assertEquals("Renamed on the Mac", rows(items(sessions, listings)).single().name)
        // A Mac session with no name keeps the mirror's.
        val unnamed = mapOf("m1" to listing(claudeAgent("a1", status = "busy", state = "working")))
        assertEquals("old-auto-name", rows(items(sessions, unnamed)).single().name)
    }

    @Test
    fun aRunningMirrorFollowsTheMacsState() {
        // The server can still call a mirror active and thinking after its process is gone.
        val thinking = mirror("s1", "a1").copy(thinking = true)
        val done = mapOf("m1" to listing(claudeAgent("a1", status = "busy", state = "done")))
        assertEquals(SessionState.Waiting, rows(items(listOf(thinking), done)).single().state)
        val idle = mirror("s1", "a1")
        val working = mapOf("m1" to listing(claudeAgent("a1", status = "busy", state = "working")))
        assertEquals(SessionState.Thinking, rows(items(listOf(idle), working)).single().state)
        // A daemon that sends no state leaves a running mirror's own state alone.
        val noState = mapOf("m1" to listing(claudeAgent("a1", status = "idle")))
        assertEquals(SessionState.Thinking, rows(items(listOf(thinking), noState)).single().state)
    }

    @Test
    fun onlyARunningMirrorsOwnRequestAsksForApproval() {
        val blocked = mapOf("m1" to listing(claudeAgent("a1", status = "waiting", state = "blocked")))
        // Waiting on the Mac alone: the phone can answer it by replying, not approve it.
        assertEquals(SessionState.InputRequired, rows(items(listOf(mirror("s1", "a1", active = false)), blocked)).single().state)
        assertEquals(SessionState.InputRequired, rows(items(listOf(mirror("s1", "a1")), blocked)).single().state)
        // A permission request the running mirror holds is still approved from the phone.
        val asking = mirror("s1", "a1").copy(attention = AgentAttention(permissionRequests = 1, pendingCommunications = 0))
        assertEquals(SessionState.PermissionRequired, rows(items(listOf(asking), blocked)).single().state)
    }

    @Test
    fun aGoneMirrorOfADoneAgentIsNotWorking() {
        val sessions = listOf(mirror("s1", "a1", active = false))
        val listings = mapOf("m1" to listing(claudeAgent("a1", status = "busy", state = "done")))
        assertEquals(SessionState.Waiting, rows(items(sessions, listings)).single().state)
    }

    @Test
    fun anUnopenedAgentIsNoWorktreeTab() {
        val sessions = listOf(mirror("s1", "a1"))
        val listings = mapOf("m1" to listing(claudeAgent("a1"), claudeAgent("a2")))
        val all = items(sessions, listings)
        val worktrees = projectWorktreesBySession(all)
        assertEquals(setOf("s1"), worktrees.keys)
        assertEquals(listOf("s1"), worktrees.getValue("s1").tabs.map { it.id })
        assertNull(worktrees["agent:m1:a2"])
    }

    @Test
    fun aTapGoesToTheChatOrOpensTheMacSessionFirst() {
        val listings = mapOf("m1" to listing(claudeAgent("a1"), claudeAgent("a2")))
        val sessions = listOf(mirror("live", "a1", active = true), mirror("dead", "a2", active = false), mirror("gone", "a3", active = false))
        assertEquals(HomeRowTarget.Agent("m1", "a9"), resolveHomeRowTarget("agent:m1:a9", sessions, listings))
        assertEquals(HomeRowTarget.Chat("live"), resolveHomeRowTarget("live", sessions, listings))
        assertEquals(HomeRowTarget.Agent("m1", "a2"), resolveHomeRowTarget("dead", sessions, listings))
        // Its Mac session has ended: the chat opens as it is.
        assertEquals(HomeRowTarget.Chat("gone"), resolveHomeRowTarget("gone", sessions, listings))
        assertEquals(HomeRowTarget.Chat("other"), resolveHomeRowTarget("other", sessions, listings))
    }
}
