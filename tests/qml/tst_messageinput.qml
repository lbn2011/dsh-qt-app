// tst_messageinput.qml — Qt Quick Test suite for the composer.
//
// Run with `qmltestrunner -input tests/qml` (the CI job that invokes it is added
// together with the workflow update, since .github/workflows is outside this
// task's scope). It only exercises the public surface: the `send` signal, the
// `text` alias, `busy` gating and the send button's enabled state.
import QtQuick
import QtQuick.Controls
import QtTest
import "../../qml/views"

TestCase {
    id: testCase

    name: "MessageInput"
    when: windowShown

    MessageInput {
        id: input
        width: 640
        height: 96
    }

    SignalSpy {
        id: sendSpy
        target: input
        signalName: "send"
    }

    function init() {
        input.clear()
        input.busy = false
        sendSpy.clear()
    }

    function test_emitsTrimmedTextAndClears() {
        input.text = "  hello world  "
        input.submit()

        compare(sendSpy.count, 1, "send() must fire exactly once")
        compare(sendSpy.signalArguments[0][0], "hello world", "payload must be trimmed")
        compare(input.text, "", "editor must be cleared after sending")
    }

    function test_ignoresEmptyInput() {
        input.text = "   "
        input.submit()

        compare(sendSpy.count, 0, "whitespace-only input must not send")
        compare(input.text, "   ", "editor keeps its contents when nothing is sent")
    }

    function test_ignoresInputWhileBusy() {
        input.busy = true
        input.text = "still typing"

        compare(input.canSend, false, "canSend must be false while busy")
        input.submit()

        compare(sendSpy.count, 0, "busy composer must not send")
        compare(input.text, "still typing", "busy composer keeps the draft")
    }

    function test_sendButtonFollowsCanSend() {
        const button = findChild(input, "sendButton")
        verify(button !== null, "send button must exist")

        input.text = ""
        compare(button.enabled, false, "send disabled when empty")

        input.text = "ready"
        compare(button.enabled, true, "send enabled with content")

        input.busy = true
        compare(button.enabled, false, "send disabled while busy")
    }

    function test_maxLengthIsEnforced() {
        compare(input.maxLength, 8000, "default cap must stay at 8000 characters")

        const editor = findChild(input, "messageInput")
        verify(editor !== null, "editor must exist")
        compare(editor.maximumLength, input.maxLength)
    }
}
