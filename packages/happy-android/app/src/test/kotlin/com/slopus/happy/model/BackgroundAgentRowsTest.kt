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
