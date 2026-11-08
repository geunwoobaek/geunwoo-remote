package com.slopus.happy.ui.session

import com.slopus.happy.sync.ScreenFrameResult
import com.slopus.happy.sync.ScreenStreamResult
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Base64

/**
 * The live screen's fallback when no direct connection forms: a still a
 * second through the relay, a bad still skipped, five in a row ending it
 * with the computer's reason, and nothing more asked once it is closed.
 */
class LiveScreenTest {
    private class Computer(val frames: List<ScreenFrameResult>) : LiveScreenOps {
        var asked = 0
        override suspend fun screenStreamStart(sessionId: String, sdp: String, maxWidth: Int, fps: Int) = ScreenStreamResult(false)
        override suspend fun screenStreamStop(sessionId: String, id: String?) = Unit
        override suspend fun screenFrame(sessionId: String, maxWidth: Int): ScreenFrameResult {
            assertEquals(LiveScreenSpec.FRAME_WIDTH, maxWidth)
            return frames.getOrElse(asked++) { frames.last() }
        }
    }

    private fun jpeg(vararg bytes: Int) = ScreenFrameResult(true, Base64.getEncoder().encodeToString(ByteArray(bytes.size) { bytes[it].toByte() }))

    @Test fun stillsArriveOncePerIntervalAndABadOneIsSkipped() = runTest {
        val computer = Computer(listOf(jpeg(1, 2), ScreenFrameResult(false, error = "busy"), jpeg(3)))
        val got = ArrayList<ByteArray>()
        val job = launch { pollScreenFrames(computer, "s", onFrame = { got += it }, intervalMillis = 1_000) }
        runCurrent()
        assertEquals(1, got.size)
        advanceTimeBy(1_001)
        assertEquals(1, got.size)
        advanceTimeBy(1_000)
        assertEquals(2, got.size)
        assertArrayEquals(byteArrayOf(3), got[1])
        job.cancel()
        val asked = computer.asked
        advanceTimeBy(5_000)
        assertEquals("closed: nothing more asked", asked, computer.asked)
    }

    @Test fun fiveFailuresInARowEndItWithTheReason() = runTest {
        val computer = Computer(listOf(ScreenFrameResult(false, error = "Screen capture is only available on macOS")))
        assertEquals("Screen capture is only available on macOS", pollScreenFrames(computer, "s", onFrame = {}, intervalMillis = 10))
        assertEquals(5, computer.asked)
    }

    @Test fun theVideoKeepsTheFramesShape() {
        assertEquals(16f / 9f, liveVideoAspect(1280, 720)!!, 0.0001f)
        assertEquals(0.5f, liveVideoAspect(500, 1000)!!, 0.0001f)
        assertNull(liveVideoAspect(0, 720))
        assertNull(liveVideoAspect(1280, 0))
    }
}
