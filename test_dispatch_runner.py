import copy
from contextlib import redirect_stderr, redirect_stdout
import datetime as dt
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import urllib.error

import dispatch_runner as runner

IDENTIFIER = "8c54d220-f632-40e7-a10a-24d777b2da82"
PING = "https://opspulse.ru/ping/8c54d220-f632-40e7-a10a-24d777b2da82"


class Store:
    def __init__(self, value=None):
        self.value = value

    def load(self):
        return copy.deepcopy(self.value)

    def save(self, value):
        self.value = copy.deepcopy(value)


class Clock:
    def __init__(self):
        self.value = 1800000000

    def now(self):
        return self.value

    def wait(self, seconds):
        self.value += seconds

    def iso(self, offset=0):
        return dt.datetime.fromtimestamp(self.value + offset, dt.timezone.utc).isoformat()


class Client:
    def __init__(self, clock):
        self.clock = clock
        self.calls = []
        self.posts = 0
        self.pings = 0
        self.dispatched = False
        self.accept_dispatch = True
        self.listing_incomplete = False
        self.dispatch_error = None
        self.legacy_response = False
        self.phase = "completed"
        self.conclusion = "success"
        self.missing_step = False
        self.identity_mismatch = False
        self.created = clock.iso()
        self.completed_offset = 0
        self.poll_count = 0
        self.queued_polls = 0

    def run(self):
        self.poll_count += 1
        return {"id": 123, "event": "workflow_dispatch", "head_branch": "main",
                "repository": {"full_name": runner.REPO}, "path": runner.WORKFLOW_PATH,
                "display_title": runner.TITLE_PREFIX + ("wrong" if self.identity_mismatch else IDENTIFIER),
                "created_at": self.created, "conclusion": self.conclusion,
                "status": "queued" if self.poll_count <= self.queued_polls else self.phase}

    def github(self, suffix, method="GET", data=None):
        self.calls.append((suffix, method, data))
        if method == "POST":
            self.posts += 1
            self.dispatched = self.accept_dispatch
            self.created = self.clock.iso()
            assert data == {"ref": "main", "inputs": {"test_alert": False, "external_run_id": IDENTIFIER}}
            if self.dispatch_error:
                raise runner.MonitorError(self.dispatch_error)
            return None if self.legacy_response else {"workflow_run_id": 123}
        if suffix == "workflows/availability.yml":
            return {"path": runner.WORKFLOW_PATH, "state": "active"}
        if suffix.startswith("workflows/availability.yml/runs?"):
            runs = [self.run()] if self.dispatched else []
            return {"total_count": 1000 if self.listing_incomplete else len(runs), "workflow_runs": runs}
        if suffix == "runs/123":
            return self.run()
        if suffix.startswith("runs/123/jobs?"):
            return {"total_count": 1, "jobs": [{"name": "check", "status": "completed", "conclusion": "success",
                    "completed_at": self.clock.iso(self.completed_offset), "steps": [
                        {"name": "Test monitoring logic", "status": "completed", "conclusion": "success"},
                        {"name": "Check public endpoints", "status": "completed", "conclusion": "skipped" if self.missing_step else "success"}]}]}
        raise AssertionError(suffix)

    def heartbeat(self):
        self.calls.append(("HEARTBEAT", "POST", None))
        self.pings += 1


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.clock, self.store = Clock(), Store()
        self.client = Client(self.clock)

    def invoke(self):
        return runner.run_once(self.client, self.store, self.clock.now, self.clock.wait, lambda: IDENTIFIER)

    def test_success_waits_for_report_step_then_pings_once(self):
        self.client.queued_polls = 2
        self.assertEqual(self.invoke()["status"], "completed")
        self.assertEqual((self.client.posts, self.client.pings), (1, 1))
        self.assertEqual(self.client.calls[-2][0], "runs/123/jobs?filter=latest&per_page=100")
        self.assertEqual(self.client.calls[-1][0], "HEARTBEAT")
        self.assertEqual(self.store.value["phase"], "complete")
        self.assertEqual(self.invoke(), {"status": "cooldown"})
        self.assertEqual((self.client.posts, self.client.pings), (1, 1))

    def test_successful_dispatch_is_not_a_heartbeat(self):
        self.client.phase = "queued"
        with self.assertRaisesRegex(runner.MonitorError, "workflow_wait_timeout"):
            self.invoke()
        self.assertEqual(self.client.pings, 0)
        self.assertEqual(self.store.value["phase"], "pending")
        self.clock.wait(600)
        self.client.phase = "completed"
        self.assertEqual(self.invoke()["status"], "completed")
        self.assertEqual(self.client.posts, 1, "restart must wait for same pending run")

    def test_five_minute_job_completes_before_runner_deadline(self):
        started_at = self.clock.now()
        original_run = self.client.run

        def delayed_run():
            run = original_run()
            run["status"] = "in_progress" if self.clock.now() - started_at < 270 else "completed"
            return run

        with mock.patch.object(self.client, "run", side_effect=delayed_run):
            self.assertEqual(self.invoke()["status"], "completed")
        self.assertEqual(self.clock.now() - started_at, 270)
        self.assertEqual((self.client.posts, self.client.pings), (1, 1))
        self.assertEqual(self.store.value["phase"], "complete")
        self.clock.wait(600 - (self.clock.now() - started_at))
        self.assertEqual(self.invoke()["status"], "completed")
        self.assertEqual((self.client.posts, self.client.pings), (2, 2),
                         "a 4–5 minute job must not consume the next scheduled tick")

    def test_dispatch_timeout_that_was_accepted_is_found_without_duplicate(self):
        self.client.dispatch_error = "github_transport_error"
        self.assertEqual(self.invoke()["status"], "completed")
        self.assertEqual((self.client.posts, self.client.pings), (1, 1))

    def test_legacy_204_uses_unique_correlation(self):
        self.client.legacy_response = True
        self.assertEqual(self.invoke()["status"], "completed")
        self.assertEqual(self.client.posts, 1)

    def test_lost_dispatch_can_recover_only_after_complete_empty_lookup(self):
        self.client.dispatch_error = "github_transport_error"
        self.client.accept_dispatch = False
        with self.assertRaisesRegex(runner.MonitorError, "workflow_wait_timeout"):
            self.invoke()
        self.assertEqual(self.store.value["phase"], "pending")
        self.clock.wait(700)
        with self.assertRaisesRegex(runner.MonitorError, "dispatch_not_created"):
            self.invoke()
        self.assertEqual(self.store.value["phase"], "failed")
        self.assertEqual((self.client.posts, self.client.pings), (1, 0))
        self.clock.wait(600)
        self.client.dispatch_error = None
        self.client.accept_dispatch = True
        self.assertEqual(self.invoke()["status"], "completed")
        self.assertEqual(self.client.posts, 2)

    def test_truncated_lookup_does_not_release_ambiguous_dispatch(self):
        self.client.dispatch_error = "github_transport_error"
        self.client.accept_dispatch = False
        self.client.listing_incomplete = True
        with self.assertRaisesRegex(runner.MonitorError, "workflow_wait_timeout"):
            self.invoke()
        self.clock.wait(900)
        with self.assertRaisesRegex(runner.MonitorError, "workflow_wait_timeout"):
            self.invoke()
        self.assertEqual(self.store.value["phase"], "pending")
        self.assertEqual((self.client.posts, self.client.pings), (1, 0))

    def test_failure_never_pings_but_can_retry_next_interval(self):
        self.client.conclusion = "failure"
        with self.assertRaisesRegex(runner.MonitorError, "workflow_failed"):
            self.invoke()
        self.assertEqual(self.client.pings, 0)
        self.assertEqual(self.store.value["phase"], "failed")
        self.clock.wait(600)
        self.client.conclusion = "success"
        self.assertEqual(self.invoke()["status"], "completed")
        self.assertEqual(self.client.posts, 2)

    def test_run_success_with_skipped_monitor_step_is_not_healthy(self):
        self.client.missing_step = True
        with self.assertRaisesRegex(runner.MonitorError, "report_step_not_successful"):
            self.invoke()
        self.assertEqual(self.client.pings, 0)

    def test_wrong_run_identity_never_pings(self):
        self.client.identity_mismatch = True
        with self.assertRaisesRegex(runner.MonitorError, "run_identity_mismatch"):
            self.invoke()
        self.assertEqual(self.client.pings, 0)

    def test_expired_token_fails_without_ping(self):
        self.client.dispatch_error = "github_http_401"
        with self.assertRaisesRegex(runner.MonitorError, "github_http_401"):
            self.invoke()
        self.assertEqual(self.client.pings, 0)
        self.assertEqual(self.store.value["phase"], "failed")

    def test_old_completion_does_not_reset_deadman(self):
        self.client.completed_offset = -901
        with self.assertRaisesRegex(runner.MonitorError, "completed_report_stale"):
            self.invoke()
        self.assertEqual(self.client.pings, 0)
        self.assertEqual(self.store.value["phase"], "stale")

    def test_all_requests_are_only_actions_or_empty_heartbeat(self):
        self.invoke()
        self.assertFalse(any("issues" in call[0] for call in self.client.calls))
        self.assertFalse(any(call[2] for call in self.client.calls if call[0] == "HEARTBEAT"))

    def test_rejected_heartbeat_does_not_complete_or_redispatch(self):
        original_heartbeat = self.client.heartbeat
        self.client.heartbeat = mock.Mock(side_effect=runner.MonitorError("heartbeat_not_accepted"))
        with self.assertRaisesRegex(runner.MonitorError, "heartbeat_not_accepted"):
            self.invoke()
        self.assertEqual(self.store.value["phase"], "pending")
        self.assertNotIn("heartbeat_at", self.store.value)
        self.client.heartbeat = original_heartbeat
        self.assertEqual(self.invoke()["status"], "completed")
        self.assertEqual((self.client.posts, self.client.pings), (1, 1))


class Reply(io.BytesIO):
    def __init__(self, value, status=200):
        super().__init__(value)
        self.status = status


class HttpTests(unittest.TestCase):
    def test_no_credential_is_sent_to_opspulse(self):
        client = runner.HttpClient("unit-test-not-secret", PING)
        captured = []
        class Opener:
            def open(self, req, timeout):
                captured.append(req)
                return Reply(b'{"status":"ok"}')
        client.opener = Opener()
        self.assertTrue(client.heartbeat())
        self.assertIsNone(captured[0].get_header("Authorization"))
        self.assertIsNone(captured[0].get_header("X-github-api-version"))
        self.assertEqual(captured[0].get_header("Accept"), "application/json")
        self.assertEqual(captured[0].full_url, PING)
        self.assertEqual(captured[0].data, b"")
        self.assertEqual(captured[0].method, "POST")

    def test_http200_requires_json_object_with_status_ok(self):
        client = runner.HttpClient("unit-test-not-secret", PING)
        client.opener = mock.Mock()
        for body in (b"", b"OK", b"OK (not found)", b"<html>OK</html>", b"{",
                     b'\xff', b"null", b"true", b'"ok"', b"[]", b"{}",
                     b'{"status":"error"}', b'{"status":true}', b'{"status":"OK"}',
                     b'{"message":"ok"}', b'{"status":"ok"} trailing'):
            with self.subTest(body=body):
                client.opener.open.return_value = Reply(body)
                with self.assertRaisesRegex(runner.MonitorError, "heartbeat_not_accepted"):
                    client.heartbeat()
        for body in (b'{"status":"ok"}', b' \n { "status": "ok" } \n', b'{"status":"ok","recorded":true}'):
            with self.subTest(body=body):
                client.opener.open.return_value = Reply(body)
                self.assertTrue(client.heartbeat())

    def test_heartbeat_requires_http200_and_bounded_body(self):
        client = runner.HttpClient("unit-test-not-secret", PING)
        client.opener = mock.Mock()
        for status in (201, 202, 204, 301, 302, 307, 308, 400, 429, 500):
            with self.subTest(status=status):
                client.opener.open.return_value = Reply(b'{"status":"ok"}', status=status)
                with self.assertRaisesRegex(runner.MonitorError, "heartbeat_not_accepted"):
                    client.heartbeat()
        client.opener.open.return_value = Reply(b'{"status":"ok"}' + b" " * 64)
        with self.assertRaisesRegex(runner.MonitorError, "oversized_response"):
            client.heartbeat()

    def test_heartbeat_http_and_transport_errors_are_fixed_identifiers(self):
        client = runner.HttpClient("unit-test-not-secret", PING)
        client.opener = mock.Mock()
        for code in (301, 302, 303, 307, 308, 400, 404, 429, 500):
            with self.subTest(code=code):
                client.opener.open.side_effect = urllib.error.HTTPError(PING, code, PING, {}, io.BytesIO(PING.encode()))
                with self.assertRaisesRegex(runner.MonitorError, "^heartbeat_http_" + str(code) + "$"):
                    client.heartbeat()
        for error in (urllib.error.URLError(PING), TimeoutError(PING), OSError(PING)):
            with self.subTest(error_type=type(error).__name__):
                client.opener.open.side_effect = error
                with self.assertRaisesRegex(runner.MonitorError, "^heartbeat_transport_error$"):
                    client.heartbeat()

    def test_redirects_are_disabled(self):
        client = runner.HttpClient("unit-test-not-secret", PING)
        self.assertTrue(any(isinstance(handler, runner.NoRedirect) for handler in client.opener.handlers))
        for code in (301, 302, 303, 307, 308):
            self.assertIsNone(runner.NoRedirect().redirect_request(None, None, code, "", {}, "https://example.org"))

    def test_bad_destinations_and_body_sizes_fail_closed(self):
        for url in (None, 123, "", PING.replace("https:", "http:"),
                    PING.replace("opspulse.ru", "opspulse.ru:443"),
                    PING.replace("opspulse.ru", "opspulse.ru:8443"),
                    PING.replace("opspulse.ru", "user@opspulse.ru"),
                    PING.replace("opspulse.ru", "user:password@opspulse.ru"),
                    PING.replace("opspulse.ru", "opspulse.ru.example.org"),
                    PING.replace("opspulse.ru", "opspulse.ru."),
                    PING.replace("/ping/", "/ping//"),
                    PING.replace("/ping/", "/ping/../ping/"),
                    PING.replace("/ping/", "/ping%2f"),
                    PING.replace(IDENTIFIER, IDENTIFIER.replace("-", "")),
                    PING.replace(IDENTIFIER, "-" * 36),
                    PING + "?x=1", PING + "?", PING + "#fragment", PING + "#",
                    PING + "/", PING + "/fail", PING + "\n", " " + PING,
                    "https://example.org/" + IDENTIFIER,
                    "https://hc-ping.com/" + IDENTIFIER):
            with self.subTest(url=url):
                with self.assertRaisesRegex(runner.MonitorError, "^invalid_opspulse_url$"):
                    runner.HttpClient("unit-test", url)
        self.assertEqual(runner.HttpClient("unit-test", PING.replace(IDENTIFIER, IDENTIFIER.upper())).ping_url,
                         PING.replace(IDENTIFIER, IDENTIFIER.upper()))
        client = runner.HttpClient("unit-test", PING)
        with self.assertRaisesRegex(runner.MonitorError, "unexpected_github_destination"):
            client.request("https://example.org/")
        for url in (PING + "/fail", "https://example.org/" + IDENTIFIER):
            with self.assertRaisesRegex(runner.MonitorError, "unexpected_heartbeat_destination"):
                client.request(url, "POST", github=False)
        class Opener:
            def open(self, req, timeout):
                return Reply(b"x" * (512 * 1024 + 1))
        client.opener = Opener()
        with self.assertRaisesRegex(runner.MonitorError, "oversized_response"):
            client.github("workflows/availability.yml")

    def test_main_uses_only_opspulse_environment_setting(self):
        for setting, expected in (("OPSPULSE_PING_URL", 0), ("HEALTHCHECKS_PING_URL", 1)):
            with self.subTest(setting=setting), mock.patch.dict(os.environ, {
                    "MONITOR_GITHUB_TOKEN": "unit-test-not-secret", setting: PING}, clear=True), \
                    mock.patch("sys.argv", ["dispatch_runner.py"]), \
                    mock.patch.object(runner, "run_once", return_value={"status": "completed"}) as run_once, \
                    redirect_stdout(io.StringIO()) as output:
                self.assertEqual(runner.main(), expected)
                if expected == 0:
                    self.assertEqual(run_once.call_args.args[0].ping_url, PING)
                else:
                    run_once.assert_not_called()
                    self.assertEqual(json.loads(output.getvalue())["reason"], "invalid_opspulse_url")

    def test_main_never_logs_credential_url_response_or_exception(self):
        secret_token = "unit-test-secret-token"
        private_body = b"unit-test-private-response"
        cases = (
            (Reply(private_body), None, "heartbeat_not_accepted"),
            (None, urllib.error.HTTPError(PING, 404, secret_token, {}, io.BytesIO(private_body)), "heartbeat_http_404"),
            (None, urllib.error.URLError(PING + secret_token), "heartbeat_transport_error"),
            (None, RuntimeError(PING + secret_token), "internal_error"),
        )
        for response, error, reason in cases:
            opener = mock.Mock()
            opener.open.return_value, opener.open.side_effect = response, error
            with self.subTest(reason=reason), mock.patch.dict(os.environ, {
                    "MONITOR_GITHUB_TOKEN": secret_token, "OPSPULSE_PING_URL": PING}, clear=True), \
                    mock.patch("sys.argv", ["dispatch_runner.py"]), \
                    mock.patch.object(runner.urllib.request, "build_opener", return_value=opener), \
                    mock.patch.object(runner, "run_once", side_effect=lambda client, store: client.heartbeat()), \
                    redirect_stdout(io.StringIO()) as output, redirect_stderr(io.StringIO()) as errors:
                # Capture the service's stdout and stderr independently; no traceback
                # or provider-controlled text should escape even on unknown errors.
                self.assertEqual(runner.main(), 1)
                self.assertEqual(json.loads(output.getvalue()), {"status": "failed", "reason": reason})
                self.assertEqual(errors.getvalue(), "")
                for secret in (secret_token, PING, IDENTIFIER, private_body.decode()):
                    self.assertNotIn(secret, output.getvalue())

    def test_storage_is_private_and_malformed_state_does_not_dispatch(self):
        with tempfile.TemporaryDirectory() as directory:
            store = runner.FileStore(directory)
            self.assertIsNone(store.load())
            value = {"version": 1, "attempt_at": 1800000000, "correlation": IDENTIFIER, "phase": "pending"}
            store.save(value)
            self.assertEqual(store.load(), value)
            self.assertEqual(os.stat(Path(directory) / "dispatch-state.json").st_mode & 0o777, 0o600)
            store.save({"wrong": "state"})
            with self.assertRaisesRegex(runner.MonitorError, "invalid_local_state"):
                store.load()


if __name__ == "__main__":
    unittest.main()
