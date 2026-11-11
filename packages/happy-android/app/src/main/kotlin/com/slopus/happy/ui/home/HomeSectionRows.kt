package com.slopus.happy.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.HomeCardSpec
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.delay

object HomeSectionTags {
    const val CHIPS = "home.sectionChips"
    const val CHIP = "home.sectionChip"
    const val HEADER = "home.sectionHeader"
    const val SHOW_MORE = "home.showMore"
}

object HomeSectionSpec {
    val headerHeight = 38.dp
    val showMoreHeight = 44.dp
    val chipGap = 6.dp
    val chipRadius = 14.dp
    val chip = happyTextStyle(fontSize = 13, lineHeight = 18, weight = FontWeight.SemiBold)
    val header = happyTextStyle(fontSize = 13, lineHeight = 18, weight = FontWeight.SemiBold)
    val showMore = happyTextStyle(fontSize = 15, lineHeight = 20, weight = FontWeight.SemiBold)
}

/** A section's colour: orange while it waits on the user, blue while it works, none once done. */
fun sectionAccent(section: HomeSection): Color? = when (section) {
    HomeSection.NeedsInput -> BlockedDotColor
    HomeSection.Working -> UnreadDotColor
    HomeSection.Completed -> null
}

/** The clock elapsed times count to, ticking every [periodMs]. */
@Composable
fun rememberNow(periodMs: Long = 30_000): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(periodMs) {
        while (true) {
            delay(periodMs)
            now = System.currentTimeMillis()
        }
    }
    return now
}

/** The counts above the sections, one chip each; a tap goes to that section. */
@Composable
fun SectionChipsRow(counts: List<Pair<HomeSection, Int>>, onChip: (HomeSection) -> Unit) {
    val colors = HappyTheme.colors
    Row(
        modifier = Modifier
            .contentMaxWidth(LocalWindowLayout.current)
            .testTag(HomeSectionTags.CHIPS)
            .horizontalScroll(rememberScrollState())
            .padding(start = HomeCardSpec.inset, end = HomeCardSpec.inset, top = 4.dp, bottom = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(HomeSectionSpec.chipGap),
    ) {
        for ((section, count) in counts) {
            val accent = sectionAccent(section)
            val label = when (section) {
                HomeSection.NeedsInput -> stringResource(R.string.home_chip_needs_input, count)
                HomeSection.Working -> stringResource(R.string.home_chip_working, count)
                HomeSection.Completed -> stringResource(R.string.home_chip_done, count)
            }
            Text(
                text = label,
                style = HomeSectionSpec.chip,
                color = accent ?: colors.textSecondary,
                maxLines = 1,
                modifier = Modifier
                    .testTag(HomeSectionTags.CHIP)
                    .clip(RoundedCornerShape(HomeSectionSpec.chipRadius))
                    .background(accent?.copy(alpha = 0.14f) ?: colors.surfaceHigh)
                    .clickable { onChip(section) }
                    .padding(horizontal = 12.dp, vertical = 6.dp),
            )
        }
    }
}

/** A section's heading inside its card: its name and how many it holds. */
@Composable
fun SectionHeaderRow(section: HomeSection, count: Int) {
    val colors = HappyTheme.colors
    val name = when (section) {
        HomeSection.NeedsInput -> stringResource(R.string.home_section_needs_input)
        HomeSection.Working -> stringResource(R.string.home_section_working)
        HomeSection.Completed -> stringResource(R.string.home_section_completed)
    }
    Row(
        modifier = Modifier.fillMaxSize().testTag(HomeSectionTags.HEADER).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(name, style = HomeSectionSpec.header, color = sectionAccent(section) ?: colors.text, maxLines = 1)
        Text("$count", style = HomeSectionSpec.header, color = colors.textSecondary, maxLines = 1)
    }
}

/** "Show N more", the last row of the Completed card. */
@Composable
fun ShowMoreRow(hidden: Int, callbacks: HomeListCallbacks) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .testTag(HomeSectionTags.SHOW_MORE)
            .clickable { callbacks.onShowMoreCompleted() }
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(stringResource(R.string.home_show_more, hidden), style = HomeSectionSpec.showMore, color = UnreadDotColor, maxLines = 1)
    }
}
