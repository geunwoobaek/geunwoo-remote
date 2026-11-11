package com.slopus.happy.ui.home

import com.slopus.happy.model.FlatSessionRowData
import com.slopus.happy.model.SessionPreview
import com.slopus.happy.model.SessionState

/** The flat home list's sections, as `claude agents` groups its sessions. */
enum class HomeSection { NeedsInput, Working, Completed }

/** Waiting on the user, working, or done with its turn. A live chat only: the archive is apart. */
fun homeSectionOf(state: SessionState): HomeSection = when (state) {
    SessionState.PermissionRequired, SessionState.InputRequired -> HomeSection.NeedsInput
    SessionState.Thinking -> HomeSection.Working
    else -> HomeSection.Completed
}

/** Completed chats shown before "Show N more". */
const val COMPLETED_SHOWN = 3

/**
 * When this device first saw each chat in its section: the clock a row
 * shows when nothing better says when it started waiting or working.
 * Seeing a chat in another section starts its clock again.
 */
class SectionClock(private val now: () -> Long) {
    private val seen = HashMap<String, Pair<HomeSection, Long>>()

    fun firstSeen(id: String, section: HomeSection): Long {
        seen[id]?.let { (was, at) -> if (was == section) return at }
        return now().also { seen[id] = section to it }
    }

    /** Forgets the chats no longer listed. */
    fun retain(ids: Set<String>) {
        seen.keys.retainAll(ids)
    }
}

/**
 * [live] (by activity, newest first) as sections: the chips, then each
 * non-empty section's heading and chats. Needs input and Working put the
 * longest wait first (unknown starts last, by activity); Completed keeps
 * activity order and shows [COMPLETED_SHOWN] unless [completedExpanded].
 * Each row takes its [previews] line and its section's start.
 */
fun sectionedRows(
    live: List<FlatSessionRowData>,
    previews: Map<String, SessionPreview>,
    completedExpanded: Boolean,
    firstSeen: (id: String, section: HomeSection) -> Long?,
): List<HomeRow> {
    if (live.isEmpty()) return emptyList()
    val bySection = live
        .map { row ->
            val session = row.session
            val section = homeSectionOf(session.state)
            val preview = previews[session.id]
            // Every row tells the clock its section, Completed too, so a chat back at work starts again from now.
            val seen = firstSeen(session.id, section)
            val since = when (section) {
                HomeSection.NeedsInput -> session.stateSince ?: seen
                HomeSection.Working -> preview?.turnStartedAt ?: seen
                HomeSection.Completed -> null
            }
            // A line the row already has is the Mac's, newer than anything stored for it.
            section to row.copy(session = session.copy(preview = session.preview ?: preview?.line, stateSince = since))
        }
        .groupBy({ it.first }, { it.second })
    val sections = HomeSection.entries.mapNotNull { section ->
        val rows = bySection[section] ?: return@mapNotNull null
        section to if (section == HomeSection.Completed) rows else rows.sortedWith(compareBy<FlatSessionRowData, Long?>(nullsLast()) { it.session.stateSince })
    }
    val out = ArrayList<HomeRow>(live.size + 2 * sections.size + 1)
    out += HomeRow.SectionChips(sections.map { (section, rows) -> section to rows.size })
    for ((section, rows) in sections) {
        out += HomeRow.SectionHeader(section, rows.size)
        val shown = if (section == HomeSection.Completed && !completedExpanded) rows.take(COMPLETED_SHOWN) else rows
        shown.forEachIndexed { index, row -> out += HomeRow.Chat(row, showBorder = index != shown.lastIndex, section = section) }
        if (shown.size < rows.size) out += HomeRow.ShowMore(section, rows.size - shown.size)
    }
    return out
}
