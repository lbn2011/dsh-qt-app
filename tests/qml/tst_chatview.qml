// tst_chatview.qml — Qt Quick Test suite for the message flow.
//
// Verifies that ChatView renders a ListView bound to the message model, that the
// empty state disappears once a message exists, and that the header reflects the
// session state it is given.
import QtQuick
import QtTest
import "../../qml/views"
import "../../qml/models"

TestCase {
    id: testCase

    name: "ChatView"
    when: windowShown

    MessageModel { id: model }

    ChatView {
        id: chatView
        width: 800
        height: 600
        messageModel: model
    }

    function init() {
        model.clearMessages()
        chatView.title = "Test session"
        chatView.status = "idle"
    }

    function test_exposesBoundListView() {
        const list = findChild(chatView, "messageList")
        verify(list !== null, "ChatView must expose a ListView named messageList")
        verify(list.model === model, "ListView model must be the bound message model")
        compare(list.count, 0, "fresh model renders no rows")
    }

    function test_rendersAppendedMessages() {
        model.appendUserMessage("first")
        model.appendAssistantMessage("second", false)

        tryCompare(chatView, "messageCount", 2)
        const list = findChild(chatView, "messageList")
        compare(list.count, 2)
    }

    function test_emptyStateTogglesWithContent() {
        const empty = findChild(chatView, "emptyState")
        verify(empty !== null, "empty state must exist")
        compare(empty.visible, true, "empty state shows on an empty model")

        model.appendUserMessage("hello")
        tryCompare(chatView, "messageCount", 1)
        tryCompare(empty, "visible", false)
    }

    function test_headerReflectsSessionState() {
        chatView.status = "streaming"
        tryCompare(chatView, "status", "streaming")

        const statusPill = findChild(chatView, "sessionStatus")
        verify(statusPill !== null, "status pill must exist")

        const titleLabel = findChild(chatView, "sessionTitle")
        verify(titleLabel !== null, "title label must exist")
        compare(titleLabel.text, "Test session")
    }

    SignalSpy {
        id: newSessionSpy
        target: chatView
        signalName: "newSessionRequested"
    }

    function test_newSessionSignalPropagates() {
        newSessionSpy.clear()

        const button = findChild(chatView, "newSessionButton")
        verify(button !== null, "new session button must exist")
        button.clicked()

        compare(newSessionSpy.count, 1, "header button must re-emit newSessionRequested")
    }
}
