package com.slopus.happy.ui.home

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.data.MessageRecord
import com.slopus.happy.model.Machine
import com.slopus.happy.model.Session
import com.slopus.happy.model.displayName
import com.slopus.happy.model.formatPathRelativeToHome
import com.slopus.happy.model.runningModel
import com.slopus.happy.ui.chat.formatLastSeen
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.connection.BarIconButton
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.connection.AgentSearchField
import com.slopus.happy.ui.connection.AgentSearchTags
import com.slopus.happy.ui.connection.AgentTopBar
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** `/sessions/search`: every session on this phone, found by its words or its messages'. */
@Serializable data object SessionSearchRoute

object SessionSearchTags {
    const val BAR = "sessionSearch.bar"
    const val LIST = "sessionSearch.list"
    const val EMPTY = "sessionSearch.empty"
    fun row(id: String) = "sessionSearch.row.$id"
}

/** One session found: its words, and [snippet], the stretch of a message that matched, when one did. */
@Immutable
data class SessionSearchHit(
    val sessionId: String,
    val title: String?,
    val place: String?,
    val snippet: String?,
    val lastActivityAt: Long,
)

/** What [sessionHits] reads of a session's own words: title, folder, summary, computer, branch, model. */
private fun Session.searchWords(machines: Map<String, Machine>): List<String> = listOfNotNull(
    displayName(),
    metadata?.summary?.text,
    metadata?.path,
    metadata?.name,
    metadata?.gitBranch,
    metadata?.host,
    metadata?.machineId?.let(machines::get)?.let { it.metadata?.displayName ?: it.metadata?.host },
    metadata.runningModel(),
)

/**
 * The sessions [query] finds, case aside: first those whose own words
 * hold it (most recently active first), then those with a stored message
 * that does ([messageSnippets], newest message first). Nothing for a blank query.
 */
fun sessionHits(sessions: List<Session>, machines: List<Machine>, query: String, messageSnippets: Map<String, String>): List<SessionSearchHit> {
    val needle = query.trim()
    if (needle.isEmpty()) return emptyList()
    val byId = machines.associateBy { it.id }
    fun hit(session: Session, snippet: String?) = SessionSearchHit(
        sessionId = session.id,
        title = session.displayName(),
        place = listOfNotNull(
            session.metadata?.path?.let { formatPathRelativeToHome(it, session.metadata.homeDir) },
            session.metadata?.machineId?.let(byId::get)?.let { it.metadata?.displayName ?: it.metadata?.host },
        ).joinToString(" · ").ifEmpty { null },
        snippet = snippet,
        lastActivityAt = maxOf(session.activeAt, session.updatedAt),
    )
    val own = sessions.filter { session -> session.searchWords(byId).any { it.contains(needle, ignoreCase = true) } }
        .sortedByDescending { maxOf(it.activeAt, it.updatedAt) }
    val ownIds = own.mapTo(HashSet()) { it.id }
    val sessionsById = sessions.associateBy { it.id }
    val inMessages = messageSnippets.keys.filter { it !in ownIds }.mapNotNull(sessionsById::get)
    return own.map { hit(it, messageSnippets[it.id]) } + inMessages.map { hit(it, messageSnippets[it.id]) }
}

/** Keys whose values are bookkeeping, not anything a person wrote or read. */
private val skippedKeys = setOf("type", "role", "id", "uuid", "parentUuid", "sessionId", "localId", "tool_use_id", "signature", "model", "t")

/**
 * The first stretch, about [radius] characters each side, of a value (not
 * a key, not bookkeeping) in each message's JSON that holds [query], by
 * session, newest message first; one per session.
 */
fun messageSnippets(records: List<MessageRecord>, query: String, radius: Int = 40): Map<String, String> {
    val needle = query.trim()
    if (needle.isEmpty()) return emptyMap()
    val found = LinkedHashMap<String, String>()
    for (record in records) {
        if (record.sessionId in found) continue
        val json = record.contentJson ?: continue
        val root = runCatching { Json.parseToJsonElement(json) }.getOrNull() ?: continue
        firstMatch(root, needle)?.let { text ->
            val at = text.indexOf(needle, ignoreCase = true)
            val start = (at - radius).coerceAtLeast(0)
            val end = (at + needle.length + radius).coerceAtMost(text.length)
            val stretch = text.substring(start, end).replace(Regex("\\s+"), " ").trim()
            found[record.sessionId] = (if (start > 0) "…" else "") + stretch + (if (end < text.length) "…" else "")
        }
    }
    return found
}

private fun firstMatch(element: JsonElement, needle: String): String? = when (element) {
    is JsonPrimitive -> element.takeIf { it.isString }?.content?.takeIf { it.contains(needle, ignoreCase = true) }
    is JsonArray -> element.firstNotNullOfOrNull { firstMatch(it, needle) }
    is JsonObject -> element.entries.firstNotNullOfOrNull { (key, value) -> if (key in skippedKeys) null else firstMatch(value, needle) }
}

/**
 * Home's search: a field in the bar and, under it, the sessions it finds
 * on this phone, by their own words or their stored messages'. Nothing
 * leaves the phone. A tap opens the session.
 */
@Composable
fun SessionSearchScreen(graph: AppGraph, onOpenSession: (String) -> Unit, onBack: () -> Unit) {
    val services = remember(graph) { HomeServices.of(graph) }
    val snapshot by services.snapshots.collectAsStateWithLifecycle()
    var query by rememberSaveable { mutableStateOf("") }
    BackHandler(onBack = onBack)
    val hits by produceState(emptyList<SessionSearchHit>(), query, snapshot) {
        val current = snapshot ?: return@produceState
        if (query.isBlank()) {
            value = emptyList()
            return@produceState
        }
        delay(200)
        value = withContext(Dispatchers.IO) {
            val snippets = if (query.trim().length >= 2) messageSnippets(graph.store.messagesContaining(query.trim(), 400), query) else emptyMap()
            sessionHits(current.sessions, current.machines, query, snippets).take(100)
        }
    }
    val colors = HappyTheme.colors
    val placeholder = stringResource(R.string.session_search_placeholder)
    Screen(
        header = {
            AgentTopBar(
                tag = SessionSearchTags.BAR,
                container = colors.surface,
                navigationIcon = { BarIconButton(Ionicon.ArrowBack, stringResource(R.string.common_back), onBack) },
                title = { AgentSearchField(query, { query = it }, placeholder = placeholder) },
                actions = {
                    if (query.isNotEmpty()) {
                        BarIconButton(Ionicon.Close, stringResource(R.string.agent_search_clear), { query = "" }, Modifier.testTag(AgentSearchTags.CLEAR))
                    }
                },
            )
        },
        ground = colors.surface,
    ) {
        if (hits.isEmpty()) {
            Text(
                stringResource(if (query.isBlank()) R.string.session_search_hint else R.string.session_search_empty),
                style = happyTextStyle(fontSize = 15, lineHeight = 21),
                color = colors.textSecondary,
                modifier = Modifier.padding(24.dp).testTag(SessionSearchTags.EMPTY),
            )
        } else {
            val resources = LocalResources.current
            val now = remember(hits) { System.currentTimeMillis() }
            val untitled = stringResource(R.string.session_new_chat)
            LazyColumn(Modifier.fillMaxSize().testTag(SessionSearchTags.LIST)) {
                items(hits, key = { it.sessionId }) { hit ->
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clickable(role = Role.Button) { onOpenSession(hit.sessionId) }
                            .testTag(SessionSearchTags.row(hit.sessionId))
                            .padding(horizontal = 20.dp, vertical = 12.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Row {
                            Text(
                                hit.title ?: untitled,
                                style = happyTextStyle(fontSize = 16, lineHeight = 21, weight = FontWeight.SemiBold),
                                color = colors.text,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            Text(formatLastSeen(resources, hit.lastActivityAt, now), style = happyTextStyle(fontSize = 13), color = colors.textSecondary, modifier = Modifier.padding(start = 8.dp))
                        }
                        hit.place?.let { Text(it, style = happyTextStyle(fontSize = 13, lineHeight = 18), color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                        hit.snippet?.let { Text(it, style = happyTextStyle(fontSize = 14, lineHeight = 19), color = colors.text, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                    }
                }
            }
        }
    }
}
