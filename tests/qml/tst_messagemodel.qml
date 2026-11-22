// tst_messagemodel.qml — Qt Quick Test suite for the message model contract.
//
// Locks the four roles (role / text / timestamp / pending) that the C++
// `MessageListModel : QAbstractListModel` must expose in Phase 2, so the views do
// not silently depend on anything else.
import QtQuick
import QtTest
import "../../qml/models"

TestCase {
    id: testCase

    name: "MessageModel"
    when: windowShown

    MessageModel { id: model }

    function init() {
        model.clearMessages()
    }

    function test_roleConstants() {
        compare(model.roleUser, "user")
        compare(model.roleAssistant, "assistant")
        compare(model.roleSystem, "system")
        compare(model.roleTool, "tool")
    }

    function test_appendMessageFillsAllRoles() {
        const index = model.appendMessage("tool", "ran ls", "2026-11-22T10:00:00Z", true)
        compare(index, 0)
        compare(model.count, 1)

        const message = model.messageAt(0)
        compare(message.role, "tool")
        compare(message.text, "ran ls")
        compare(message.timestamp, "2026-11-22T10:00:00Z")
        compare(message.pending, true)
    }

    function test_convenienceHelpers() {
        compare(model.appendUserMessage("hi"), 0)
        compare(model.appendAssistantMessage("hello", true), 1)
        compare(model.appendSystemMessage("connected"), 2)
        compare(model.count, 3)

        compare(model.messageAt(0).role, "user")
        compare(model.messageAt(1).role, "assistant")
        compare(model.messageAt(1).pending, true)
        compare(model.messageAt(2).role, "system")
    }

    function test_timestampDefaultsToNow() {
        model.appendMessage("assistant", "no timestamp given")
        const message = model.messageAt(0)
        verify(message.timestamp.length > 0, "a timestamp must always be present")
    }

    function test_updateMessage() {
        model.appendAssistantMessage("partial", true)
        compare(model.updateMessage(0, "complete", false), true)

        const message = model.messageAt(0)
        compare(message.text, "complete")
        compare(message.pending, false)
    }

    function test_updateMessageRejectsInvalidIndex() {
        compare(model.updateMessage(0, "nope", false), false)
        compare(model.updateMessage(-1, "nope", false), false)
    }

    function test_messageAtRejectsInvalidIndex() {
        compare(model.messageAt(0), null)
        compare(model.messageAt(5), null)
    }

    function test_clearMessages() {
        model.appendUserMessage("one")
        model.appendUserMessage("two")
        compare(model.count, 2)

        model.clearMessages()
        compare(model.count, 0)
        compare(model.messageAt(0), null)
    }
}
