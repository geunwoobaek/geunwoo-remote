package com.slopus.happy.ui.session

import com.slopus.happy.sync.CaptureScreenResult
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The computer's screen from the phone: a screenshot comes back from the
 * one call; a recording is asked after until written; a refusal (no
 * permission, not a Mac, an older CLI) says why; a recording that never
 * finishes gives up a little past its length.
 */
class ScreenCaptureTest {
    private class Computer(
        val start: CaptureScreenResult,
        val statuses: List<CaptureScreenResult> = emptyList(),
    ) : ScreenCaptureOps {
        val asked = ArrayList<Pair<Boolean, Int>>()
        var polls = 0
        override suspend fun captureScreen(sessionId: String, video: Boolean, seconds: Int): CaptureScreenResult {
            asked += video to seconds
            return start
        }
        override suspend fun captureStatus(sessionId: String, path: String): CaptureScreenResult =
            statuses.getOrElse(polls++) { statuses.lastOrNull() ?: CaptureScreenResult(true, path, done = false) }
    }

    @Test fun aScreenshotComesBackAtOnce() = runTest {
        val computer = Computer(CaptureScreenResult(true, "/Users/me/.happy/captures/a.png", done = true))
        assertEquals(CaptureOutcome.Captured("/Users/me/.happy/captures/a.png", false), ScreenCapture.capture(computer, "s", video = false, seconds = 0))
        assertEquals(listOf(false to 0), computer.asked)
        assertEquals(0, computer.polls)
    }

    @Test fun aRecordingIsAskedAfterUntilWritten() = runTest {
        val path = "/c/r.mov"
        val computer = Computer(
            CaptureScreenResult(true, path, done = false),
            listOf(CaptureScreenResult(true, path, done = false), CaptureScreenResult(true, path, done = false), CaptureScreenResult(true, path, done = true, size = 9)),
        )
        val ticks = ArrayList<Int>()
        assertEquals(CaptureOutcome.Captured(path, true), ScreenCapture.capture(computer, "s", video = true, seconds = 5) { ticks += it })
        assertEquals(listOf(1, 2, 3), ticks)
        assertEquals(listOf(true to 5), computer.asked)
    }

    @Test fun refusalsSayWhyAndAStuckRecordingGivesUp() = runTest {
        val refused = Computer(CaptureScreenResult(false, error = "Screen capture is only available on macOS"))
        assertEquals(CaptureOutcome.Failed("Screen capture is only available on macOS"), ScreenCapture.capture(refused, "s", false, 0))
        val olderCli = Computer(CaptureScreenResult(false, error = "Method not found"))
        assertEquals(CaptureOutcome.Failed("Method not found"), ScreenCapture.capture(olderCli, "s", true, 5))
        val failedLater = Computer(CaptureScreenResult(true, "/c/r.mov"), listOf(CaptureScreenResult(false, error = "screencapture exited 1")))
        assertEquals(CaptureOutcome.Failed("screencapture exited 1"), ScreenCapture.capture(failedLater, "s", true, 5))
        val stuck = Computer(CaptureScreenResult(true, "/c/r.mov"))
        assertEquals(CaptureOutcome.Failed(null), ScreenCapture.capture(stuck, "s", true, 5, graceSeconds = 3))
        assertEquals(8, stuck.polls)
    }
}
