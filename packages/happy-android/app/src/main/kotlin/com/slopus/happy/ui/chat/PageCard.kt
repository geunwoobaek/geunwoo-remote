package com.slopus.happy.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

/** The page card's measures, shared with its layout test. */
object PageCardSpec {
    val margin = MessageSpec.agentMarginHorizontal
    val marginVertical = 4.dp
    val radius = 12.dp
    val padding = 12.dp
    val badge = 44.dp
    val badgeRadius = 10.dp
    val glyph = 24.dp
    val gap = 12.dp
    val chevron = 20.dp
    val title = happyTextStyle(fontSize = 15, lineHeight = 20, weight = FontWeight.SemiBold)
    val subtitle = happyTextStyle(fontSize = 13, lineHeight = 18)
}

object PageCardTags {
    const val TITLE = "chat.pageCard.title"
}

/**
 * A page the agent wrote, as the Claude app shows an artifact it made: a
 * full-width card under the turn naming the page by its `<title>` (read once
 * from the file's first bytes, [SessionMediaHost.title]; its file name until
 * then and when it has none), its folder and file name under it
 * (`fms-guide/body.html`), and a tap
 * opens it in the file viewer already rendered, its source a tab away. Kept
 * cheap: text and a glyph, never a WebView in the list.
 *
 * Spec: 16 in from the column's sides and 4 above and below; surfaceHigh,
 * radius 12, padding 12. A 44 badge (radius 10, surface) holding the 24
 * browsers glyph in textSecondary; 12 after it the title (15/20 semibold,
 * text, at most 2 lines) over the subtitle (13/18, textSecondary); 12 after
 * that the 20 chevron in textSecondary. At least 68 high (the badge and its
 * padding), growing with the text.
 */
@Composable
fun PageCard(host: SessionMediaHost, item: MediaItem, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val name = item.key.substringAfterLast('/')
    val title by produceState<String?>(null, item.key, host) { value = host.title(item.path) }
    val shown = title ?: name
    val label = stringResource(R.string.page_card_open, shown)
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = PageCardSpec.margin, vertical = PageCardSpec.marginVertical)
            .testTag(MediaStripTags.card(item.key))
            .heightIn(min = PageCardSpec.badge + PageCardSpec.padding * 2)
            .clip(RoundedCornerShape(PageCardSpec.radius))
            .background(colors.surfaceHigh)
            .clickable(role = Role.Button) { host.open(item.path) }
            .semantics { contentDescription = label }
            .padding(PageCardSpec.padding),
        horizontalArrangement = Arrangement.spacedBy(PageCardSpec.gap),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(PageCardSpec.badge).clip(RoundedCornerShape(PageCardSpec.badgeRadius)).background(colors.surface),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Ionicon.BrowsersOutline, PageCardSpec.glyph, colors.textSecondary)
        }
        Column(Modifier.weight(1f)) {
            Text(shown, style = PageCardSpec.title, color = colors.text, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag(PageCardTags.TITLE))
            Text(com.slopus.happy.ui.files.ReadablePage.shortName(item.path), style = PageCardSpec.subtitle, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Icon(Ionicon.ChevronForward, PageCardSpec.chevron, colors.textSecondary)
    }
}
