package com.slopus.happy.ui.chat

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.ChatListItem
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.WorkHeaderPlacement
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.files.AgentFolder
import com.slopus.happy.ui.files.MediaKind
import com.slopus.happy.ui.files.MediaRead
import com.slopus.happy.ui.files.SessionFileOps
import com.slopus.happy.ui.files.SessionMedia
import com.slopus.happy.ui.files.readMediaToFile
import com.slopus.happy.ui.files.readPageTitle
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File

object MediaStripTags {
    const val STRIP = "chat.mediaStrip"
    fun tile(path: String) = "chat.mediaTile.$path"
    fun card(path: String) = "chat.pageCard.$path"
}

/**
 * A picture, recording or page a row names, as the chat found it ([path]:
 * relative or absolute); [made] when a Write, Edit or MultiEdit wrote it,
 * which shows a page as a card rather than a tile.
 */
@Immutable
data class ChatMedia(val path: String, val made: Boolean = false)

/**
 * One thing a strip shows: [path] as the chat named it (what a tap opens, so
 * the file screen decides where it really is), [key] the absolute place it
 * most likely is (its identity, cache and test tag), and whether it is a
 * [card].
 */
@Immutable
data class MediaItem(val path: String, val key: String, val kind: MediaKind, val card: Boolean)

/**
 * What a chat's media strip reads from: the session, its folder and the
 * folder the agent works in now (for relative paths, [AgentFolder]), the
 * computer's files, the cache, and where a tap goes. Pictures' thumbnails and
 * pages' titles are kept in memory and pictures' files in the cache, so
 * scrolling back never reads them again.
 */
class SessionMediaHost(
    val sessionId: String,
    val sessionPath: String?,
    private val ops: SessionFileOps,
    private val cacheDir: File,
    /** `metadata.cwd`: where the agent works now, when happy-cli said; null reads as before. */
    val cwd: String? = null,
    /** The shell variables a path may start with ([SessionMedia.variables]); one not here names no file the phone can find. */
    private val variables: Map<String, String> = emptyMap(),
    val open: (String) -> Unit,
) {
    private val thumbnails = LruCache<String, ImageBitmap>(32)

    /** Pages' titles by [MediaItem.key]; "" for a page without one. */
    private val titles = LruCache<String, String>(64)

    /** Paths that couldn't be read, so scrolling past them doesn't ask the computer again. */
    private val unreadable = java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<String, Boolean>())

    /**
     * Items ([MediaItem.key]) the computer said it will never give (not
     * there, or outside what the session may read): their tiles and cards
     * leave the strip, so nothing in the chat opens to an error.
     */
    private val gone = androidx.compose.runtime.mutableStateMapOf<String, Boolean>()

    /** Whether [item] is known to name nothing that opens. */
    fun isGone(item: MediaItem): Boolean = gone[item.key] == true

    private fun markGone(key: String) {
        gone[key] = true
    }

    /** One read at a time: the same picture under two rows must not write one cache file twice. */
    private val reading = Mutex()

    /** Where [path] may be, the likeliest first: against the agent's folder, then the session's; empty when relative with no folder or under a variable the phone can't know. */
    fun candidates(path: String): List<String> {
        val expanded = SessionMedia.expand(path, variables) ?: return emptyList()
        return AgentFolder.candidates(expanded, sessionPath, cwd)
    }

    /** [path] at its likeliest absolute place; null when relative with no folder to resolve it by. */
    fun absolute(path: String): String? = candidates(path).firstOrNull()

    /**
     * What a strip of [media] shows, each place once: the same file named
     * twice (a Write's absolute path and the answer's relative one) is one
     * item, a card when either made it, opened by the path that wrote it.
     */
    fun items(media: List<ChatMedia>): List<MediaItem> {
        val byKey = LinkedHashMap<String, MediaItem>()
        for (one in media) {
            val key = absolute(one.path) ?: continue
            val kind = SessionMedia.kindOf(key) ?: continue
            val card = one.made && kind == MediaKind.Page
            // A path under a variable opens where the variable leads, not as the chat wrote it.
            val opens = if (one.path.startsWith("$")) key else one.path
            val seen = byKey[key]
            byKey[key] = when {
                seen == null -> MediaItem(opens, key, kind, card)
                card && !seen.card -> seen.copy(path = opens, card = true)
                else -> seen
            }
        }
        return byKey.values.toList()
    }

    /** A picture's thumbnail about [widest] pixels across, read once into the cache, from the first of its [candidates] that reads. */
    suspend fun thumbnail(path: String, widest: Int): ImageBitmap? {
        val places = candidates(path)
        val key = places.firstOrNull() ?: return null
        thumbnails.get(key)?.let { return it }
        if (key in unreadable) return null
        return reading.withLock {
            var closed = 0
            thumbnails.get(key) ?: places.firstNotNullOfOrNull { place -> decodeThumbnail(place, widest) { closed++ } }
                .also {
                    if (it == null) unreadable += key else thumbnails.put(key, it)
                    if (it == null && closed == places.size) markGone(key)
                }
        }
    }

    /** A page's `<title>`, read once from its first bytes; null when it has none or can't be read (the card shows its name). */
    suspend fun title(path: String): String? {
        val places = candidates(path)
        val key = places.firstOrNull() ?: return null
        titles.get(key)?.let { return it.ifEmpty { null } }
        var closed = 0
        val title = places.firstNotNullOfOrNull { ops.readPageTitle(sessionId, it) { closed++ } }
        if (title == null && closed == places.size) {
            markGone(key)
            return null
        }
        titles.put(key, title.orEmpty())
        return title
    }

    /**
     * Whether [item] opens, asked once of the computer (a picture by its
     * thumbnail, a page by its title, a recording by its first byte); one
     * that never will leaves the strip ([isGone]).
     */
    suspend fun check(item: MediaItem) {
        if (isGone(item)) return
        when (item.kind) {
            MediaKind.Page -> title(item.path)
            MediaKind.Picture -> Unit // its tile reads the thumbnail
            MediaKind.Video -> {
                val places = candidates(item.path)
                if (places.isEmpty() || item.key in unreadable) return
                var closed = 0
                for (place in places) {
                    val first = try {
                        ops.readFileChunk(sessionId, place, 0L, 1)
                    } catch (e: kotlinx.coroutines.CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        return
                    }
                    if (first.success) return
                    if (SessionMedia.cannotOpen(first.error)) closed++
                }
                if (closed == places.size) {
                    unreadable += item.key
                    markGone(item.key)
                }
            }
        }
    }

    private suspend fun decodeThumbnail(path: String, widest: Int, onCannotOpen: () -> Unit): ImageBitmap? {
        val file = SessionMedia.cacheFile(cacheDir, sessionId, path)
        return withContext(Dispatchers.IO) {
            if (!file.exists()) {
                val read = ops.readMediaToFile(sessionId, path, file, SessionMedia.MAX_PICTURE_BYTES)
                if (read is MediaRead.Failed && SessionMedia.cannotOpen(read.reason)) onCannotOpen()
                if (read != MediaRead.Done) return@withContext null
            }
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.path, bounds)
            if (bounds.outWidth <= 0) return@withContext null
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= widest) sample *= 2
            BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
        }
    }
}

/** The session the chat shows, for its media strips; null shows none (another kind of chat, previews). */
val LocalSessionMedia = staticCompositionLocalOf<SessionMediaHost?> { null }

/**
 * The pictures, recordings and pages each row of [items] should show under
 * it, by row key: a row's own (its words, its tool call), and under a
 * finished turn's answer, those of the work folded away above it. A page a
 * Write, Edit or MultiEdit wrote is [ChatMedia.made].
 */
fun chatMediaPaths(items: List<ChatListItem>): Map<String, List<ChatMedia>> {
    val open = items.mapNotNullTo(HashSet()) { (it as? ChatListItem.WorkHeader)?.takeIf { h -> h.placement == WorkHeaderPlacement.Trailing }?.group?.id }
    val out = LinkedHashMap<String, MutableList<ChatMedia>>()
    for (item in items) {
        when (item) {
            is ChatListItem.Row -> mediaOf(item.row).takeIf { it.isNotEmpty() }?.let { out.getOrPut(item.row.key) { ArrayList() }.addAll(it) }
            is ChatListItem.WorkHeader -> if (item.placement == WorkHeaderPlacement.Leading && item.group.id !in open) {
                val folded = item.group.rows.flatMap(::mediaOf)
                if (folded.isNotEmpty()) out.getOrPut(item.group.id.removePrefix("work-")) { ArrayList() }.addAll(folded)
            }
        }
    }
    return out.mapValues { (_, media) ->
        media.groupBy { it.path }.map { (path, same) -> ChatMedia(path, same.any { it.made }) }.take(SessionMedia.MAX_PER_MESSAGE)
    }
}

/** [row]'s media in order, a page it wrote marked [ChatMedia.made] (named whole even when its path has spaces). */
private fun mediaOf(row: ChatRow): List<ChatMedia> {
    val made = SessionMedia.pagesMadeBy(row)
    return (SessionMedia.pathsOf(row) + made).distinct().map { ChatMedia(it, it in made) }
}

private val TILE = 112.dp

/**
 * What goes under a message for the media it names: each page the turn
 * wrote as a full-width [PageCard] (its title; a tap opens it rendered),
 * then a row of tiles, one per picture, recording or other page: a
 * picture's thumbnail, a recording's play mark, a page's globe, each with
 * its name. A tap opens it full size in the app.
 */
@Composable
fun MediaStrip(media: List<ChatMedia>, modifier: Modifier = Modifier) {
    val host = LocalSessionMedia.current ?: return
    val listed = remember(media, host) { host.items(media) }
    for (item in listed) LaunchedEffect(item.key, host) { host.check(item) }
    val shown = listed.filterNot(host::isGone)
    if (shown.isEmpty()) return
    val cards = shown.filter { it.card }
    val tiles = shown.filterNot { it.card }
    Column(modifier.fillMaxWidth().testTag(MediaStripTags.STRIP)) {
        for (item in cards) PageCard(host, item)
        if (tiles.isNotEmpty()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = MessageSpec.agentMarginHorizontal, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for (item in tiles) MediaTile(host, item)
            }
        }
    }
}

@Composable
private fun MediaTile(host: SessionMediaHost, item: MediaItem) {
    val colors = HappyTheme.colors
    val path = item.path
    val name = item.key.substringAfterLast('/')
    val label = stringResource(R.string.session_media_open, name)
    Box(
        Modifier
            .size(TILE)
            .clip(RoundedCornerShape(10.dp))
            .background(colors.surfaceHigh)
            .clickable(role = Role.Button) { host.open(path) }
            .semantics { contentDescription = label }
            .testTag(MediaStripTags.tile(item.key)),
        contentAlignment = Alignment.Center,
    ) {
        when (item.kind) {
            MediaKind.Picture -> {
                val widest = with(androidx.compose.ui.platform.LocalDensity.current) { TILE.roundToPx() } * 2
                val picture by produceState<ImageBitmap?>(null, path, host) { value = host.thumbnail(path, widest) }
                picture?.let { Image(it, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
                    ?: Icon(Ionicon.ImageOutline, 28.dp, colors.textSecondary)
            }
            MediaKind.Video -> Icon(Ionicon.PlayCircleOutline, 40.dp, colors.textSecondary)
            MediaKind.Page -> Icon(Ionicon.GlobeOutline, 32.dp, colors.textSecondary)
        }
        Text(
            name,
            style = happyTextStyle(fontSize = 11, lineHeight = 14),
            color = Color.White,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .align(Alignment.BottomStart)
                .fillMaxWidth()
                .background(Color(0x99000000))
                .padding(horizontal = 6.dp, vertical = 3.dp),
        )
    }
}
