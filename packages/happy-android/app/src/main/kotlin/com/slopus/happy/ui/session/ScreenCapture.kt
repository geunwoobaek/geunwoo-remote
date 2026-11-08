package com.slopus.happy.ui.session

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.sync.CaptureScreenResult
import com.slopus.happy.ui.call.SheetStatusIcons
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.TrackOverlay
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** What capturing asks of the session's computer (happy-cli `captureScreen` / `captureStatus`). */
interface ScreenCaptureOps {
    suspend fun captureScreen(sessionId: String, video: Boolean, seconds: Int): CaptureScreenResult
    suspend fun captureStatus(sessionId: String, path: String): CaptureScreenResult
}

/** Sync's session ops. */
class SyncScreenCaptureOps(private val account: com.slopus.happy.sync.AccountSync) : ScreenCaptureOps {
    override suspend fun captureScreen(sessionId: String, video: Boolean, seconds: Int) = account.sessionOps.captureScreen(sessionId, video, seconds)
    override suspend fun captureStatus(sessionId: String, path: String) = account.sessionOps.captureStatus(sessionId, path)
}

/** How a capture went: the file on the computer, or why not. */
sealed interface CaptureOutcome {
    data class Captured(val path: String, val video: Boolean) : CaptureOutcome
    data class Failed(val reason: String?) : CaptureOutcome
}

/**
 * The computer's screen taken from the phone: a screenshot comes back at
 * once; a recording is started (the relay won't hold a call open that long)
 * and its file asked after each [pollMillis] until it is written, giving up
 * [graceSeconds] past its length.
 */
object ScreenCapture {
    val RECORD_SECONDS = listOf(5, 15, 30)

    suspend fun capture(
        ops: ScreenCaptureOps,
        sessionId: String,
        video: Boolean,
        seconds: Int,
        pollMillis: Long = 1_000,
        graceSeconds: Int = 20,
        onTick: (elapsedSeconds: Int) -> Unit = {},
    ): CaptureOutcome {
        val started = try {
            ops.captureScreen(sessionId, video, seconds)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return CaptureOutcome.Failed(e.message)
        }
        val path = started.path
        if (!started.success || path == null) return CaptureOutcome.Failed(started.error)
        if (started.done) return CaptureOutcome.Captured(path, video)
        val polls = ((seconds + graceSeconds) * 1_000L / pollMillis).toInt().coerceAtLeast(1)
        for (i in 1..polls) {
            delay(pollMillis)
            onTick((i * pollMillis / 1_000).toInt())
            val status = try {
                ops.captureStatus(sessionId, path)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                continue
            }
            if (!status.success) return CaptureOutcome.Failed(status.error)
            if (status.done) return CaptureOutcome.Captured(path, video)
        }
        return CaptureOutcome.Failed(null)
    }
}

object ScreenCaptureTags {
    const val SHEET = "screenCapture.sheet"
    const val SCREENSHOT = "screenCapture.screenshot"
    fun record(seconds: Int) = "screenCapture.record.$seconds"
    const val WORKING = "screenCapture.working"
    const val FAILED = "screenCapture.failed"
    const val ASK = "screenCapture.ask"
}

private sealed interface SheetState {
    data object Choosing : SheetState
    data class Working(val video: Boolean, val seconds: Int, val elapsed: Int) : SheetState
    data class Done(val path: String) : SheetState
    data class Failed(val reason: String?) : SheetState
}

/**
 * The header's computer-screen sheet: a screenshot or a 5, 15 or 30 second
 * recording of the session's computer, opened in the app's viewer as soon
 * as it is written ([onOpen]); [onAsk] sends Claude a message naming it.
 * The capture runs on the computer and comes to the phone through the
 * session's encrypted channel, as its other files do.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScreenCaptureSheet(
    ops: ScreenCaptureOps,
    sessionId: String,
    onOpen: (String) -> Unit,
    onAsk: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = HappyTheme.colors
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf<SheetState>(SheetState.Choosing) }
    var job by remember { mutableStateOf<Job?>(null) }
    fun start(video: Boolean, seconds: Int) {
        state = SheetState.Working(video, seconds, 0)
        job = scope.launch {
            val outcome = ScreenCapture.capture(ops, sessionId, video, seconds) { elapsed -> state = SheetState.Working(video, seconds, elapsed) }
            state = when (outcome) {
                is CaptureOutcome.Captured -> SheetState.Done(outcome.path).also { onOpen(outcome.path) }
                is CaptureOutcome.Failed -> SheetState.Failed(outcome.reason)
            }
        }
    }
    val dismiss = {
        job?.cancel()
        onDismiss()
    }
    TrackOverlay(true, dismiss)
    ModalBottomSheet(onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(), containerColor = colors.surface, modifier = Modifier.testTag(ScreenCaptureTags.SHEET)) {
        SheetStatusIcons()
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 12.dp)) {
            Text(
                stringResource(R.string.session_capture),
                style = happyTextStyle(fontSize = 17, lineHeight = 22, weight = FontWeight.SemiBold),
                color = colors.text,
                modifier = Modifier.padding(horizontal = 24.dp).padding(bottom = 8.dp),
            )
            when (val s = state) {
                SheetState.Choosing, is SheetState.Failed -> {
                    if (s is SheetState.Failed) {
                        Text(
                            listOfNotNull(stringResource(R.string.session_capture_failed), s.reason).joinToString("\n"),
                            style = happyTextStyle(fontSize = 14, lineHeight = 19),
                            color = colors.textDestructive,
                            modifier = Modifier.padding(horizontal = 24.dp, vertical = 4.dp).testTag(ScreenCaptureTags.FAILED),
                        )
                    }
                    CaptureRow(Ionicon.ImageOutline, stringResource(R.string.session_capture_screenshot), ScreenCaptureTags.SCREENSHOT) { start(false, 0) }
                    for (seconds in ScreenCapture.RECORD_SECONDS) {
                        CaptureRow(Ionicon.Videocam, stringResource(R.string.session_capture_record, seconds), ScreenCaptureTags.record(seconds)) { start(true, seconds) }
                    }
                }
                is SheetState.Working -> Row(
                    Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 16.dp).testTag(ScreenCaptureTags.WORKING),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = colors.textSecondary, strokeWidth = 2.dp)
                    val label = if (s.video) "${stringResource(R.string.session_capture_recording)} ${minOf(s.elapsed, s.seconds)}/${s.seconds}s" else stringResource(R.string.session_capture_screenshot)
                    Text(label, style = happyTextStyle(fontSize = 15), color = colors.text)
                }
                is SheetState.Done -> {
                    CaptureRow(Ionicon.ImageOutline, s.path.substringAfterLast('/'), "screenCapture.open") { onOpen(s.path) }
                    CaptureRow(Ionicon.ChatbubbleEllipsesOutline, stringResource(R.string.session_capture_ask), ScreenCaptureTags.ASK) {
                        onAsk(s.path)
                        dismiss()
                    }
                    CaptureRow(Ionicon.Videocam, stringResource(R.string.session_capture), "screenCapture.again") { state = SheetState.Choosing }
                }
            }
        }
    }
}

@Composable
private fun CaptureRow(icon: Ionicon, label: String, tag: String, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 14.dp)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Icon(icon, 22.dp, colors.textSecondary)
        Text(label, style = happyTextStyle(fontSize = 16, lineHeight = 21), color = colors.text)
    }
}
