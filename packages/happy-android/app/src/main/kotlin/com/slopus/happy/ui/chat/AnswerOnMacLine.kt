package com.slopus.happy.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import com.slopus.happy.R
import com.slopus.happy.ui.theme.HappyTheme

object AnswerOnMacTags {
    const val LINE = "permission.answerOnMac"
}

/**
 * The one line a Mac background session's card shows in place of answer
 * buttons when the phone cannot answer it ("Answer this on your Mac"): a
 * dialog the CLI could not read, an answer it cannot press, or a screen that
 * changed under it. Sits where [PermissionFooter] would, with its padding.
 */
@Composable
fun AnswerOnMacLine(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .testTag(AnswerOnMacTags.LINE)
            .padding(
                start = PermissionSpec.paddingHorizontal,
                end = PermissionSpec.paddingHorizontal,
                top = PermissionSpec.paddingTop,
                bottom = PermissionSpec.paddingBottom,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = stringResource(R.string.claude_permissions_answer_on_mac),
            style = PermissionSpec.text,
            color = HappyTheme.colors.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(vertical = PermissionSpec.buttonPaddingVertical),
        )
    }
}
