package com.slopus.happy.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The CLI's `metadata.remoteTasks` (happy-cli taskTracker.ts), read leniently: a bad entry never costs the metadata. */
class RemoteTasksTest {
    private fun metadata(tasks: String) = SessionMetadata.parse("""{"path":"/r","host":"h","remoteTasks":$tasks}""")

    @Test
    fun readsTasksWithTheirOptionalFields() {
        val tasks = metadata(
            """[
              {"id":"w","kind":"workflow","title":"review-changes","status":"running","startedAt":1000},
              {"id":"a","kind":"agent","title":"Explore mapper","status":"completed","startedAt":2000,"endedAt":9000,
               "agentType":"Explore","parentId":"w","background":true,"summary":"Found 3","lastTool":"Grep","tokens":1200,"toolUses":4}
            ]""",
        ).remoteTasks()

        assertEquals(2, tasks.size)
        assertEquals(RemoteTask("w", RemoteTaskKind.Workflow, "review-changes", RemoteTaskStatus.Running, 1000), tasks[0])
        assertEquals(
            RemoteTask(
                "a", RemoteTaskKind.Agent, "Explore mapper", RemoteTaskStatus.Completed, 2000,
                endedAt = 9000, agentType = "Explore", parentId = "w", background = true,
                summary = "Found 3", lastTool = "Grep", tokens = 1200, toolUses = 4,
            ),
            tasks[1],
        )
    }

    @Test
    fun skipsMalformedEntriesAndUnknownValuesFallBack() {
        val tasks = metadata(
            """[{"id":"x"},42,{"id":"m","kind":"monitor","title":"t","status":"brand-new","startedAt":5,"ambient":true}]""",
        ).remoteTasks()

        assertEquals(listOf("m"), tasks.map { it.id })
        assertEquals(RemoteTaskKind.Other, tasks[0].kind)
        assertEquals(RemoteTaskStatus.Running, tasks[0].status)
        assertTrue(tasks[0].ambient)
    }

    @Test
    fun noTasksWhenAbsentOrNotAList() {
        assertEquals(emptyList<RemoteTask>(), SessionMetadata.parse("""{"path":"/r","host":"h"}""").remoteTasks())
        assertEquals(emptyList<RemoteTask>(), metadata("\"soon\"").remoteTasks())
        assertEquals(emptyList<RemoteTask>(), (null as SessionMetadata?).remoteTasks())
    }

    @Test
    fun activeTasksAreTheOnesThatAreNotAmbientAndNotFinished() {
        val tasks = metadata(
            """[
              {"id":"a","kind":"agent","title":"a","status":"running","startedAt":1},
              {"id":"m","kind":"other","title":"m","status":"running","startedAt":1,"ambient":true},
              {"id":"d","kind":"agent","title":"d","status":"failed","startedAt":1,"endedAt":2}
            ]""",
        ).remoteTasks()

        assertEquals(listOf("a"), tasks.activeRemoteTasks().map { it.id })
    }

    @Test
    fun treeOrderPutsChildrenUnderTheirParentAndOrphansAtTheTop() {
        val tasks = metadata(
            """[
              {"id":"c","kind":"agent","title":"c","status":"running","startedAt":3,"parentId":"w"},
              {"id":"w","kind":"workflow","title":"w","status":"running","startedAt":1},
              {"id":"o","kind":"shell","title":"o","status":"running","startedAt":2,"parentId":"gone"}
            ]""",
        ).remoteTasks()

        assertEquals(listOf("w" to 0, "c" to 1, "o" to 0), tasks.inTreeOrder().map { it.first.id to it.second })
        assertNull(tasks.first().endedAt)
    }
}
