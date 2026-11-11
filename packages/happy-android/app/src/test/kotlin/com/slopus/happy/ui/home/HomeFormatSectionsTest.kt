package com.slopus.happy.ui.home

import org.junit.Assert.assertEquals
import org.junit.Test

/** How long a home row has waited or worked: the largest whole unit, as `claude agents` shows it. */
class HomeFormatSectionsTest {
    @Test fun elapsedUsesTheLargestWholeUnit() {
        assertEquals("40s", formatElapsed(40_000))
        assertEquals("12m", formatElapsed(12 * 60_000L))
        assertEquals("2h", formatElapsed(2 * 3_600_000L + 5))
        assertEquals("3d", formatElapsed(3 * 86_400_000L))
        assertEquals("0s", formatElapsed(-5))
    }
}
