package com.slopus.happy.ui.chat

import com.slopus.happy.chat.AgentQuestionOption
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class QuestionAnswersTest {
    private fun question(id: String, text: String, multiSelect: Boolean, vararg labels: String) =
        InlineQuestion(id, text, text.removeSuffix("?"), labels.map { AgentQuestionOption(it, null) }, multiSelect, true)

    private val fruits = question("question-0", "Which fruits?", true, "Apple", "Banana", "Cherry")
    private val size = question("question-1", "Which size?", false, "Small, tidy", "Large")

    private fun text(value: String) = JsonPrimitive(value)

    @Test
    fun singleAnswerFromTheResultText() {
        val result = text("""Your questions have been answered: "Which fruits?"="Apple". You can now continue with these answers in mind.""")
        assertEquals(mapOf("question-0" to listOf("Apple")), questionAnswersFromResult(result, listOf(fruits)))
    }

    @Test
    fun multiSelectValueSplitsIntoTheSelectedLabels() {
        val result = text("""Your questions have been answered: "Which fruits?"="Apple, Cherry". You can now continue with these answers in mind.""")
        assertEquals(mapOf("question-0" to listOf("Apple", "Cherry")), questionAnswersFromResult(result, listOf(fruits)))
    }

    @Test
    fun twoQuestionsAreMatchedByTheirText() {
        val result = text("""Your questions have been answered: "Which size?"="Small, tidy", "Which fruits?"="Banana". You can now continue with these answers in mind.""")
        assertEquals(
            mapOf("question-0" to listOf("Banana"), "question-1" to listOf("Small, tidy")),
            questionAnswersFromResult(result, listOf(fruits, size)),
        )
    }

    @Test
    fun theOlderWordingOfTheResultIsReadToo() {
        val result = text("""User has answered your questions: "Which fruits?"="Apple".""")
        assertEquals(mapOf("question-0" to listOf("Apple")), questionAnswersFromResult(result, listOf(fruits)))
    }

    @Test
    fun aQuestionWithoutAnAnswerIsLeftOut() {
        val result = text("""Your questions have been answered: "Which fruits?"="Apple". You can now continue with these answers in mind.""")
        assertEquals(mapOf("question-0" to listOf("Apple")), questionAnswersFromResult(result, listOf(fruits, size)))
    }

    @Test
    fun noMatchGivesNothing() {
        assertEquals(emptyMap<String, List<String>>(), questionAnswersFromResult(text("Approved"), listOf(fruits)))
        assertEquals(emptyMap<String, List<String>>(), questionAnswersFromResult(text("""Your questions have been answered: "Other?"="x"."""), listOf(fruits)))
        assertEquals(emptyMap<String, List<String>>(), questionAnswersFromResult(null, listOf(fruits)))
    }

    @Test
    fun structuredAnswersWinOverTheText() {
        val result = Json.parseToJsonElement(
            """{"answers":{"Which fruits?":"Banana, Cherry"},"text":"Your questions have been answered: \"Which fruits?\"=\"Apple\"."}""",
        )
        assertEquals(mapOf("question-0" to listOf("Banana", "Cherry")), questionAnswersFromResult(result, listOf(fruits)))
    }

    @Test
    fun textInsideContentBlocksIsRead() {
        val result = Json.parseToJsonElement("""[{"type":"text","text":"Your questions have been answered: \"Which fruits?\"=\"Apple\"."}]""")
        assertEquals(mapOf("question-0" to listOf("Apple")), questionAnswersFromResult(result, listOf(fruits)))
    }
}
