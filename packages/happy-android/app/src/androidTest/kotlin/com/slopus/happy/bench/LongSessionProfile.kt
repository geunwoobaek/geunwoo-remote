package com.slopus.happy.bench

import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.slopus.happy.chat.ChatPage
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.groupChatRowsForDisplay
import com.slopus.happy.data.HappyDatabase
import com.slopus.happy.data.HappyStore
import com.slopus.happy.data.MessageRecord
import com.slopus.happy.data.SessionRecord
import java.io.File
import java.util.Locale
import java.util.Random
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Where the open path of a long chat spends its time on the device: the SQLite read
 * of the stored records, [ChatReduction.apply] (ChatNormalizer, reducer and row
 * building) and [groupChatRowsForDisplay]. Measured with the whole chat (10,000
 * records) and with the newest 300, the size a recent window opens. Results go to
 * files/long-session-profile.txt in the app's external files.
 */
@RunWith(AndroidJUnit4::class)
class LongSessionProfile {
    private val app = InstrumentationRegistry.getInstrumentation().targetContext
    private val results = File(app.getExternalFilesDir(null), "long-session-profile.txt")

    private fun report(line: String) {
        android.util.Log.i("LongSessionProfile", line)
        results.appendText(line + "\n")
    }

    private fun quote(text: String) = JsonPrimitive(text).toString()

    private fun user(seq: Long, text: String) = MessageRecord(
        "s", seq, "m$seq", null, """{"role":"user","content":{"type":"text","text":${quote(text)}}}""", seq, seq,
    )

    private fun envelope(seq: Long, turn: String, ev: String) = MessageRecord(
        "s", seq, "m$seq", null,
        """{"role":"session","content":{"id":"e-$seq","time":$seq,"role":"agent","turn":"$turn","ev":$ev}}""",
        seq, seq,
    )

    private fun text(seq: Long, turn: String, text: String) = envelope(seq, turn, """{"t":"text","text":${quote(text)}}""")

    private fun toolCall(seq: Long, turn: String, call: String, name: String, command: String) = envelope(
        seq, turn,
        """{"t":"tool-call-start","call":"$call","name":"$name","title":"$name","description":"run","args":{"command":${quote(command)}}}""",
    )

    private fun toolResult(seq: Long, turn: String, call: String, result: String) =
        envelope(seq, turn, """{"t":"tool-call-end","call":"$call","result":${quote(result)}}""")

    /** One turn = 1 user + 2 agent texts + 4 tool calls + 4 results (11 records); a fixed seed. */
    private fun records(count: Int): List<MessageRecord> {
        val random = Random(42)
        val tools = listOf("Bash", "Read", "Grep", "Edit")
        val out = ArrayList<MessageRecord>(count)
        var seq = 1L
        var turn = 0
        fun sentence(words: Int) = (0 until words).joinToString(" ") { "word${random.nextInt(500)}" }
        while (out.size < count) {
            val t = "turn-${turn++}"
            out += user(seq++, "Please look into ${sentence(12)} in /Users/tester/project/src/file$turn.kt")
            out += text(seq++, t, "I'll start by checking ${sentence(20)}.")
            for (k in 0 until 4) {
                val call = "call-$turn-$k"
                out += toolCall(seq++, t, call, tools[random.nextInt(tools.size)], "run ${sentence(6)}")
                out += toolResult(seq++, t, call, "result ${sentence(40)}")
            }
            out += text(seq++, t, "Done: ${sentence(60)}.")
        }
        return out.take(count)
    }

    private fun ms(nanos: Long) = nanos / 1_000_000.0

    private class Measured<T>(val median: Double, val runs: List<Double>, val value: T)

    /** Runs [block] [runs] times; the first run is the coldest, the median is the figure. */
    private fun <T> measure(runs: Int = 3, block: () -> T): Measured<T> {
        val samples = ArrayList<Long>()
        var last: T? = null
        repeat(runs) {
            val start = SystemClock.elapsedRealtimeNanos()
            last = block()
            samples += SystemClock.elapsedRealtimeNanos() - start
        }
        @Suppress("UNCHECKED_CAST")
        return Measured(ms(samples.sorted()[samples.size / 2]), samples.map(::ms), last as T)
    }

    private fun line(name: String, result: Measured<*>, extra: String) = String.format(
        Locale.US, "%-40s median %8.1f ms  runs [%s]  %s", name, result.median,
        result.runs.joinToString(", ") { String.format(Locale.US, "%.1f", it) }, extra,
    )

    @Test
    fun profileTenThousandRecords() {
        results.delete()
        val total = 10_000
        val store = HappyStore(HappyDatabase(app, name = null))
        store.upsertSessions(
            listOf(
                SessionRecord(
                    "s", total.toLong(), 1, 1, true, 5,
                    """{"path":"/Users/tester/project","host":"box"}""", 1, null, 1, "", null,
                ),
            ),
        )
        store.insertMessages("s", records(total))
        val info = ChatSessionInfo.from(store.session("s")!!)
        assertEquals(total, store.messages("s").size)
        report("records=$total; per turn 1 user + 2 text + 4 tool call + 4 result; seed 42")

        // The whole chat: what the open path reads today.
        val readAll = measure { store.messages("s") }
        report(line("1  store.messages(all)", readAll, "n=${readAll.value.size}"))
        val records10k = readAll.value
        val reduceAll = measure { ChatReduction().apply(ChatPage(records10k, loaded = true), info) }
        report(line("2  ChatReduction.apply(10k records)", reduceAll, "rows=${reduceAll.value.rows.size}"))
        val rows10k: List<ChatRow> = reduceAll.value.rows
        val groupAll = measure { groupChatRowsForDisplay(rows10k, enabled = true, collapseCurrentTurn = true) }
        report(line("4  groupChatRowsForDisplay(10k rows)", groupAll, "items=${groupAll.value.size}"))

        // The newest 300: what a recent window opens.
        val readRecent = measure { store.messages("s", 300) }
        report(line("1' store.messages(300)", readRecent, "n=${readRecent.value.size}"))
        val records300 = readRecent.value
        val reduceRecent = measure { ChatReduction().apply(ChatPage(records300, loaded = true), info) }
        report(line("3  ChatReduction.apply(300 records)", reduceRecent, "rows=${reduceRecent.value.rows.size}"))
        val rows300: List<ChatRow> = reduceRecent.value.rows
        val groupRecent = measure { groupChatRowsForDisplay(rows300, enabled = true, collapseCurrentTurn = true) }
        report(line("4' groupChatRowsForDisplay(300 rows)", groupRecent, "items=${groupRecent.value.size}"))

        report(String.format(Locale.US, "SUM 10k path (1+2+4)     %8.1f ms", readAll.median + reduceAll.median + groupAll.median))
        report(String.format(Locale.US, "SUM 300 path (1'+3+4')    %8.1f ms", readRecent.median + reduceRecent.median + groupRecent.median))
    }
}
