package com.slopus.happy.ui.home

import com.slopus.happy.model.AgentAttention
import com.slopus.happy.model.HomeModelFixtures.claudeAgent
import com.slopus.happy.model.HomeModelFixtures.listing
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.mirror
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.model.Session
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.model.SessionPreview
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

/** The flat home list grouped like `claude agents`: Needs input, Working, Completed, then the archive. */
class HomeSectionsTest {
    private val zone: ZoneId = ZoneOffset.UTC
    private val today = LocalDate.of(2026, 10, 16)
    private val noon = today.atTime(12, 0).toInstant(ZoneOffset.UTC).toEpochMilli()
    private val online = machine("m1", machineMetadata { put("displayName", "Studio") }, active = true)

    private fun chat(
        id: String,
        at: Long = noon,
        active: Boolean = true,
        thinking: Boolean = false,
        attention: AgentAttention = AgentAttention.None,
    ): Session = session(
        id,
        metadata = metadata(path = "/Users/tester/$id") { put("machineId", "m1") },
        active = active,
        thinking = thinking,
        attention = attention,
        lastMessageSentAt = at,
    )

    private fun blocked(id: String, since: Long? = null, at: Long = noon) = chat(id, at, attention = AgentAttention(1, 0, since))
    private fun asking(id: String, since: Long? = null) = chat(id, attention = AgentAttention(0, 1, since))

    private fun derive(
        sessions: List<Session>,
        grouping: SessionListGrouping = SessionListGrouping.Flat,
        previews: Map<String, SessionPreview> = emptyMap(),
        expanded: Boolean = false,
        firstSeen: (String, HomeSection) -> Long? = { _, _ -> null },
    ) = deriveHomeList(
        HomeListInputs(
            HomeSnapshot(sessions, listOf(online)), grouping, true, emptySet(), emptySet(), emptySet(),
            previews = previews, completedExpanded = expanded,
        ),
        zone,
        today,
        firstSeen,
    )

    private fun shape(state: HomeListState) = state.rows.map { row ->
        when (row) {
            is HomeRow.SectionChips -> "chips"
            is HomeRow.SectionHeader -> "section:${row.section}:${row.count}"
            is HomeRow.ShowMore -> "more:${row.hidden}"
            is HomeRow.Chat -> "chat:${row.row.session.id}"
            is HomeRow.ArchiveToggle -> "toggle"
            is HomeRow.DayHeader -> "header"
            is HomeRow.Project -> "project"
        }
    }

    private fun chat(state: HomeListState, id: String) =
        state.rows.filterIsInstance<HomeRow.Chat>().single { it.row.session.id == id }

    @Test fun liveChatsSplitIntoNeedsInputWorkingAndCompleted() {
        val state = derive(
            listOf(
                chat("done-old", noon - 60_000), blocked("perm"), chat("work-a", thinking = true),
                chat("done-new", noon), chat("work-b", noon - 1, thinking = true),
            ),
        )
        assertEquals(
            listOf(
                "chips",
                "section:NeedsInput:1", "chat:perm",
                "section:Working:2", "chat:work-a", "chat:work-b",
                "section:Completed:2", "chat:done-new", "chat:done-old",
            ),
            shape(state),
        )
        val chips = state.rows.first() as HomeRow.SectionChips
        assertEquals(
            listOf(HomeSection.NeedsInput to 1, HomeSection.Working to 2, HomeSection.Completed to 2),
            chips.counts,
        )
        assertEquals(HomeSection.Working, chat(state, "work-a").section)
        assertEquals(HomeSection.NeedsInput, homeSectionOf(asking("q").state))
    }

    @Test fun waitingRowsPutTheLongestWaitFirst() {
        val state = derive(listOf(blocked("recent", since = 300, at = noon), blocked("unknown", at = noon - 5), blocked("long", since = 100, at = noon - 9)))
        assertEquals(listOf("chips", "section:NeedsInput:3", "chat:long", "chat:recent", "chat:unknown"), shape(state))
    }

    @Test fun completedShowsThreeThenShowMore() {
        val five = (1..5).map { chat("c$it", noon - it) }
        assertEquals(
            listOf("chips", "section:Completed:5", "chat:c1", "chat:c2", "chat:c3", "more:2"),
            shape(derive(five)),
        )
        assertEquals(
            listOf("chips", "section:Completed:5", "chat:c1", "chat:c2", "chat:c3", "chat:c4", "chat:c5"),
            shape(derive(five, expanded = true)),
        )
    }

    @Test fun emptySectionsHaveNoChipOrCard() {
        val state = derive(listOf(chat("w", thinking = true)))
        assertEquals(listOf("chips", "section:Working:1", "chat:w"), shape(state))
        assertEquals(listOf(HomeSection.Working to 1), (state.rows.first() as HomeRow.SectionChips).counts)
    }

    @Test fun noLiveChatsLeaveOnlyTheArchiveToggle() {
        assertEquals(listOf("toggle"), shape(derive(listOf(chat("gone", active = false)))))
    }

    @Test fun eachSectionIsItsOwnCard() {
        val state = derive(listOf(blocked("p"), chat("w", thinking = true), chat("d")))
        val cards = state.cards
        assertNull(cards.first().place)
        cards.forEachIndexed { index, entry ->
            if (entry.row is HomeRow.SectionHeader) {
                assertTrue(entry.place!!.first)
                assertTrue(!entry.place!!.separated)
                val before = cards.getOrNull(index - 1)?.place
                if (before != null) assertTrue(before.last)
            }
        }
        assertTrue(cards.last().place!!.last)
    }

    @Test fun previewAndTurnStartFillTheRow() {
        val state = derive(
            listOf(chat("w", thinking = true), chat("d")),
            previews = mapOf("w" to SessionPreview("Running the tests", 500), "d" to SessionPreview("All green", 400)),
        )
        assertEquals("Running the tests", chat(state, "w").row.session.preview)
        assertEquals(500L, chat(state, "w").row.session.stateSince)
        assertEquals("All green", chat(state, "d").row.session.preview)
        assertNull(chat(state, "d").row.session.stateSince)
    }

    @Test fun firstSeenFillsAMissingStart() {
        val state = derive(listOf(blocked("p"), chat("w", thinking = true)), firstSeen = { id, _ -> if (id == "p") 7 else 9 })
        assertEquals(7L, chat(state, "p").row.session.stateSince)
        assertEquals(9L, chat(state, "w").row.session.stateSince)
    }

    @Test fun firstSeenResetsWhenTheSectionChanges() {
        var now = 10L
        val clock = SectionClock { now }
        assertEquals(10L, clock.firstSeen("a", HomeSection.Working))
        now = 20
        assertEquals(10L, clock.firstSeen("a", HomeSection.Working))
        now = 30
        assertEquals(30L, clock.firstSeen("a", HomeSection.Completed))
        now = 40
        assertEquals(40L, clock.firstSeen("a", HomeSection.Working))
        clock.retain(emptySet())
        now = 50
        assertEquals(50L, clock.firstSeen("a", HomeSection.Working))
    }

    /** Through the list itself: a chat that finished and went back to work counts from then, not from its last turn. */
    @Test fun aChatBackAtWorkStartsItsClockAgain() {
        var now = 1_000L
        val clock = SectionClock { now }
        assertEquals(1_000L, chat(derive(listOf(chat("a", thinking = true)), firstSeen = clock::firstSeen), "a").row.session.stateSince)
        now = 2_000
        derive(listOf(chat("a")), firstSeen = clock::firstSeen)
        now = 3_000
        assertEquals(3_000L, chat(derive(listOf(chat("a", thinking = true)), firstSeen = clock::firstSeen), "a").row.session.stateSince)
    }

    /** A stopped mirror's stored line is old: the Mac's line wins; a running mirror's stored line stands. */
    @Test fun theMacsLineOutranksAStoppedMirrorsStoredOne() {
        val stopped = mirror("s1", "a1", active = false)
        val running = mirror("s2", "a2")
        val state = deriveHomeList(
            HomeListInputs(
                HomeSnapshot(listOf(stopped, running), listOf(online)), SessionListGrouping.Flat, true, emptySet(), emptySet(), emptySet(),
                agentListings = mapOf(
                    "m1" to listing(claudeAgent("a1", lastLine = "From the Mac"), claudeAgent("a2", lastLine = "Also from the Mac")),
                ),
                previews = mapOf("s1" to SessionPreview("Stored long ago", null), "s2" to SessionPreview("Streamed just now", null)),
            ),
            zone,
            today,
        ) { _, _ -> null }
        assertEquals("From the Mac", chat(state, "s1").row.session.preview)
        assertEquals("Streamed just now", chat(state, "s2").row.session.preview)
    }

    @Test fun projectGroupingIsUnchanged() {
        val state = derive(listOf(blocked("p"), chat("d")), grouping = SessionListGrouping.Project)
        assertTrue(state.rows.none { it is HomeRow.SectionChips || it is HomeRow.SectionHeader || it is HomeRow.ShowMore })
    }
}
