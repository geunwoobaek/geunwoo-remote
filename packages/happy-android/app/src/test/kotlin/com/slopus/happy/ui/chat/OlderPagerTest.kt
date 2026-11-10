package com.slopus.happy.ui.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** One older batch per reach of the top; the next one waits for the reader to reach it again or tap. */
@OptIn(ExperimentalCoroutinesApi::class)
class OlderPagerTest {
    @Test
    fun requestsOnceOnReachingTheTop() = runTest {
        val pager = OlderPager { true }
        var requests = 0
        pager.onOldestVisible(false) { requests += 1 }
        assertEquals(0, requests)
        pager.onOldestVisible(true) { requests += 1 }
        assertEquals(1, requests)
        // Staying at the top is not another reach, however often it is reported.
        repeat(3) { pager.onOldestVisible(true) { requests += 1 } }
        assertEquals(1, requests)
    }

    @Test
    fun aListThatStartsAtTheTopRequestsOnce() = runTest {
        val pager = OlderPager { true }
        var requests = 0
        pager.onOldestVisible(true) { requests += 1 }
        assertEquals(1, requests)
    }

    @Test
    fun reachingAgainRequestsAgain() = runTest {
        val pager = OlderPager { true }
        var requests = 0
        pager.onOldestVisible(false) { requests += 1 }
        pager.onOldestVisible(true) { requests += 1 }
        pager.onOldestVisible(false) { requests += 1 }
        pager.onOldestVisible(true) { requests += 1 }
        assertEquals(2, requests)
    }

    @Test
    fun leavingTheTopMidRequestAsksForNoTap() = runTest {
        val pager = OlderPager { true }
        pager.onOldestVisible(false) {}
        pager.onOldestVisible(true) {
            // The batch landed and pushed the oldest row out of view.
            pager.onOldestVisible(false) {}
        }
        assertFalse(pager.awaitingTap)
    }

    @Test
    fun stillAtTopAfterABatchWaitsForTap() = runTest {
        val scope = TestScope(UnconfinedTestDispatcher(testScheduler))
        val pager = OlderPager(scope) { true }
        var requests = 0
        val gate = CompletableDeferred<Unit>()
        val request: suspend () -> Unit = {
            requests += 1
            if (requests == 2) gate.await()
        }
        pager.onOldestVisible(false, request)
        pager.onOldestVisible(true, request)
        assertEquals(1, requests)
        assertTrue(pager.awaitingTap)
        assertEquals(OlderStatus.LoadMore, olderStatus(pager.blocked, hasMoreOlder = true, isLoadingOlder = false, awaitingTap = pager.awaitingTap))
        // It does not come by itself.
        pager.onOldestVisible(true, request)
        assertEquals(1, requests)

        pager.loadMore()
        assertEquals(2, requests)
        assertFalse(pager.awaitingTap)
        gate.complete(Unit)
        assertEquals(2, requests)
        assertTrue(pager.awaitingTap)
    }

    @Test
    fun tapRequestsOneBatchAndWaitsAgainIfStillAtTop() = runTest {
        val scope = TestScope(UnconfinedTestDispatcher(testScheduler))
        val pager = OlderPager(scope) { true }
        var requests = 0
        pager.onOldestVisible(true) { requests += 1 }
        pager.loadMore()
        assertEquals(2, requests)
        assertTrue(pager.awaitingTap)
    }

    @Test
    fun noTapButtonWithoutMoreOrWhileLoading() {
        assertEquals(OlderStatus.Idle, olderStatus(null, hasMoreOlder = false, isLoadingOlder = false, awaitingTap = true))
        assertEquals(OlderStatus.Loading, olderStatus(null, hasMoreOlder = true, isLoadingOlder = true, awaitingTap = true))
        assertEquals(OlderStatus.Idle, olderStatus(null, hasMoreOlder = true, isLoadingOlder = false))
        assertEquals(OlderStatus.Error, olderStatus(OlderBlock.Error, hasMoreOlder = true, isLoadingOlder = false, awaitingTap = true))
    }

    @Test
    fun retryAfterAFailureAsksAgain() = runTest {
        val scope = TestScope(UnconfinedTestDispatcher(testScheduler))
        var fail = true
        val pager = OlderPager(scope) { if (fail) error("offline") else true }
        var asked = 0
        val request: suspend () -> Unit = {
            asked += 1
            pager.request { null }
        }
        pager.onOldestVisible(true, request)
        assertEquals(OlderBlock.Error, pager.blocked)
        fail = false
        pager.retry()
        assertEquals(2, asked)
        assertNull(pager.blocked)
    }
}
