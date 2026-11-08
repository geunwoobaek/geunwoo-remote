package com.slopus.happy.ui.chat

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import com.slopus.happy.chat.WorkHeaderPlacement
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.files.MediaKind
import com.slopus.happy.ui.files.MediaRead
import com.slopus.happy.ui.files.SessionFileOps
import com.slopus.happy.ui.files.SessionFilePaths
import com.slopus.happy.ui.files.SessionMedia
import com.slopus.happy.ui.files.readMediaToFile
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
}

/**
 * What a chat's media strip reads from: the session, its folder (for
 * relative paths), the computer's files, the cache, and where a tap goes.
 * Pictures' thumbnails are kept in memory and their files in the cache,
 * so scrolling back never reads them again.
 */
class SessionMediaHost(
    val sessionId: String,
    val sessionPath: String?,
    private val ops: SessionFileOps,
    private val cacheDir: File,
    val open: (String) -> Unit,
) {
    private val thumbnails = LruCache<String, ImageBitmap>(32)

    /** Paths that couldn't be read, so scrolling past them doesn't ask the computer again. */
    private val unreadable = java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<String, Boolean>())

    /** One read at a time: the same picture under two rows must not write one cache file twice. */
    private val reading = Mutex()

    /** [path] resolved against the session's folder; null when relative with no folder to resolve it by. */
    fun absolute(path: String): String? = SessionFilePaths.resolve(path, sessionPath)?.absolutePath?.takeIf { it.startsWith("/") || it.getOrNull(1) == ':' }

    /** A picture's thumbnail about [widest] pixels across, read once into the cache. */
    suspend fun thumbnail(path: String, widest: Int): ImageBitmap? {
        thumbnails.get(path)?.let { return it }
        if (path in unreadable) return null
        return reading.withLock {
            thumbnails.get(path) ?: decodeThumbnail(path, widest).also { if (it == null) unreadable += path else thumbnails.put(path, it) }
        }
    }

    private suspend fun decodeThumbnail(path: String, widest: Int): ImageBitmap? {
        val file = SessionMedia.cacheFile(cacheDir, sessionId, path)
        return withContext(Dispatchers.IO) {
            if (!file.exists() && ops.readMediaToFile(sessionId, path, file, SessionMedia.MAX_PICTURE_BYTES) != MediaRead.Done) return@withContext null
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
 * finished turn's answer, those of the work folded away above it.
 */
fun chatMediaPaths(items: List<ChatListItem>): Map<String, List<String>> {
    val open = items.mapNotNullTo(HashSet()) { (it as? ChatListItem.WorkHeader)?.takeIf { h -> h.placement == WorkHeaderPlacement.Trailing }?.group?.id }
    val out = LinkedHashMap<String, MutableList<String>>()
    for (item in items) {
        when (item) {
            is ChatListItem.Row -> SessionMedia.pathsOf(item.row).takeIf { it.isNotEmpty() }?.let { out.getOrPut(item.row.key) { ArrayList() }.addAll(it) }
            is ChatListItem.WorkHeader -> if (item.placement == WorkHeaderPlacement.Leading && item.group.id !in open) {
                val folded = item.group.rows.flatMap(SessionMedia::pathsOf)
                if (folded.isNotEmpty()) out.getOrPut(item.group.id.removePrefix("work-")) { ArrayList() }.addAll(folded)
            }
        }
    }
    return out.mapValues { (_, paths) -> paths.distinct().take(SessionMedia.MAX_PER_MESSAGE) }
}

private val TILE = 112.dp

/**
 * A row of tiles under a message, one per picture, recording or page it
 * names: a picture's thumbnail, a recording's play mark, a page's globe,
 * each with its name. A tap opens it full size in the app.
 */
@Composable
fun MediaStrip(paths: List<String>, modifier: Modifier = Modifier) {
    val host = LocalSessionMedia.current ?: return
    val shown = remember(paths, host) { paths.mapNotNull(host::absolute).distinct() }
    if (shown.isEmpty()) return
    Row(
        modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = MessageSpec.agentMarginHorizontal, vertical = 4.dp)
            .testTag(MediaStripTags.STRIP),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (path in shown) MediaTile(host, path)
    }
}

@Composable
private fun MediaTile(host: SessionMediaHost, path: String) {
    val colors = HappyTheme.colors
    val name = path.substringAfterLast('/')
    val kind = SessionMedia.kindOf(path) ?: return
    val label = stringResource(R.string.session_media_open, name)
    Box(
        Modifier
            .size(TILE)
            .clip(RoundedCornerShape(10.dp))
            .background(colors.surfaceHigh)
            .clickable(role = Role.Button) { host.open(path) }
            .semantics { contentDescription = label }
            .testTag(MediaStripTags.tile(path)),
        contentAlignment = Alignment.Center,
    ) {
        when (kind) {
            MediaKind.Picture -> {
                val widest = with(androidx.compose.ui.platform.LocalDensity.current) { TILE.roundToPx() } * 2
                val picture by produceState<ImageBitmap?>(null, path) { value = host.thumbnail(path, widest) }
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
