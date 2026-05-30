"""Unit tests for WeChatService inbound-message decomposition."""
from __future__ import annotations

import os
import unittest
from unittest import mock

from server.services import wechat_service as wx


class FakeBot:
    def extract_text(self, msg: dict) -> str:
        return str(msg.get("text", ""))


class FakeAgentInner:
    llm_no = 1

    def get_llm_name(self) -> str:
        return "mock-llm"

    def list_llms(self):
        return [(0, "a", False), (1, "mock-llm", True)]


class FakeAgentService:
    def __init__(self):
        self.agent = FakeAgentInner()
        self.aborted = False
        self.switched: list[int] = []

    def abort(self) -> None:
        self.aborted = True

    def switch_llm(self, n: int) -> None:
        self.switched.append(n)
        self.agent.llm_no = n

    def list_llms(self):
        return self.agent.list_llms()


class WeChatServiceHelperTests(unittest.TestCase):
    def test_build_agent_prompt_keeps_original_format(self):
        self.assertEqual(
            wx._build_agent_prompt("hello", []),
            "If you need to show files to user, use [FILE:filepath] in your response.\n\nhello",
        )
        self.assertEqual(
            wx._build_agent_prompt("hello", [r"C:\tmp\a.png", "b.txt"]),
            "If you need to show files to user, use [FILE:filepath] in your response.\n\n"
            r"hello\n[用户发送文件: C:\tmp\a.png]\n[用户发送文件: b.txt]".replace("\\n", "\n"),
        )
        self.assertEqual(
            wx._build_agent_prompt("", ["only.bin"]),
            "If you need to show files to user, use [FILE:filepath] in your response.\n\n"
            "[用户发送文件: only.bin]",
        )

    def test_extract_file_paths_filters_placeholders_and_echoed_uploads(self):
        default_dir = r"C:\ga\tmp"
        sent = [os.path.join(default_dir, "upload.png"), r"D:\abs\sent.txt"]
        result = (
            "see [FILE:filepath] [FILE:<path>] "
            r"[FILE:report.pdf] [FILE:upload.png] [FILE:D:\abs\sent.txt] "
            r"[FILE:D:\abs\new.txt]"
        )
        self.assertEqual(
            wx._extract_file_paths(result, sent, default_dir),
            ["report.pdf", r"D:\abs\new.txt"],
        )


class WeChatServiceInboundTests(unittest.TestCase):
    def make_service(self) -> wx.WeChatService:
        with mock.patch.object(wx, "WxBotClient", return_value=mock.Mock()), \
             mock.patch.object(wx, "_load_log_tail", return_value=[]):
            svc = wx.WeChatService(FakeAgentService(), allowlist=["*"])
        svc._persist_entry = mock.Mock()
        svc._send_text = mock.Mock()
        return svc

    def test_dispatch_command_stop_consumes_message(self):
        svc = self.make_service()
        self.assertTrue(svc._dispatch_command("u1", "/stop", "ctx"))
        self.assertTrue(svc.agent_service.aborted)
        svc._send_text.assert_called_once_with("u1", "已停止", "ctx")

    def test_on_message_records_and_starts_worker_thread(self):
        svc = self.make_service()
        svc._run_agent_stream = mock.Mock()
        started = []

        class ImmediateThread:
            def __init__(self, target, args=(), daemon=None, name=None):
                self.target = target
                self.args = args
                self.daemon = daemon
                self.name = name

            def start(self):
                started.append((self.name, self.daemon, self.args))
                self.target(*self.args)

        with mock.patch.object(wx, "download_media", return_value=["m.png"]), \
             mock.patch.object(wx.threading, "Thread", ImmediateThread):
            svc._on_message(FakeBot(), {"from_user_id": "u1", "context_token": "ctx", "text": " hi "})

        self.assertEqual(len(svc.log), 1)
        self.assertEqual(svc.log[0].text, "hi")
        self.assertEqual(svc.log[0].media, ["m.png"])
        self.assertEqual(svc.contacts["u1"].msg_count, 1)
        self.assertEqual(started[0][0], "wx-handle")
        svc._run_agent_stream.assert_called_once()
        uid, prompt, media, ctx = svc._run_agent_stream.call_args.args
        self.assertEqual((uid, media, ctx), ("u1", ["m.png"], "ctx"))
        self.assertIn("hi\n[用户发送文件: m.png]", prompt)


if __name__ == "__main__":
    unittest.main()
