#!/usr/bin/env python3
"""Existing-VM clock for the public GitHub monitor; no application access.

GitHub still runs monitor.mjs as github-actions[bot]. This process can only
dispatch/read Actions, and pings OpsPulse after the report-producing job
has really finished. No credential or third-party response is logged.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

REPO = "KlochkovN/masterskaya-monitoring"
WORKFLOW = "availability.yml"
WORKFLOW_PATH = ".github/workflows/availability.yml"
API = "https://api.github.com/repos/" + REPO
WAIT_SECONDS = 360
COOLDOWN_SECONDS = 540
FRESH_SECONDS = 900
MISSING_DISPATCH_SECONDS = 900
TITLE_PREFIX = "External monitor "


class MonitorError(Exception):
    """Only fixed, non-sensitive error identifiers are allowed here."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class HttpClient:
    def __init__(self, token, ping_url):
        if not isinstance(token, str) or not token.strip():
            raise MonitorError("missing_github_token")
        if not isinstance(ping_url, str) or not re.fullmatch(
                r"https://opspulse\.ru/ping/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-"
                r"[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", ping_url):
            raise MonitorError("invalid_opspulse_url")
        try:
            uuid.UUID(ping_url.rsplit("/", 1)[1])
        except ValueError:
            raise MonitorError("invalid_opspulse_url") from None
        self.token, self.ping_url = token, ping_url
        # urllib uses the system CA store and verifies hostname/certificate.
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, url, method="GET", data=None, github=True):
        headers = {"User-Agent": "Workshop-monitor-clock/1",
                   "Accept": "application/vnd.github+json" if github else "application/json"}
        if github:
            if not url.startswith(API + "/actions/"):
                raise MonitorError("unexpected_github_destination")
            headers.update({"Authorization": "Bearer " + self.token,
                            "X-GitHub-Api-Version": "2026-03-10"})
        elif url != self.ping_url:
            raise MonitorError("unexpected_heartbeat_destination")
        payload = json.dumps(data).encode() if data is not None else (b"" if method == "POST" else None)
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=payload, method=method, headers=headers)
        try:
            with self.opener.open(request, timeout=10) as response:
                limit = 512 * 1024 if github else 64
                raw = response.read(limit + 1)
                if len(raw) > limit:
                    raise MonitorError("oversized_response")
                if github:
                    if response.status == 204:
                        return None
                    if response.status != 200:
                        raise MonitorError("unexpected_github_status")
                    try:
                        return json.loads(raw)
                    except (ValueError, UnicodeDecodeError):
                        raise MonitorError("invalid_github_response") from None
                # Only OpsPulse's explicit acknowledgement confirms the ping;
                # HTTP 200 alone (or an HTML/error body) is not sufficient.
                if response.status != 200:
                    raise MonitorError("heartbeat_not_accepted")
                try:
                    acknowledgement = json.loads(raw)
                except (ValueError, UnicodeDecodeError):
                    raise MonitorError("heartbeat_not_accepted") from None
                if not isinstance(acknowledgement, dict) or acknowledgement.get("status") != "ok":
                    raise MonitorError("heartbeat_not_accepted")
                return True
        except urllib.error.HTTPError as error:
            prefix = "github" if github else "heartbeat"
            raise MonitorError(prefix + "_http_" + str(error.code)) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise MonitorError("github_transport_error" if github else "heartbeat_transport_error") from None

    def github(self, suffix, method="GET", data=None):
        return self.request(API + "/actions/" + suffix, method, data)

    def heartbeat(self):
        return self.request(self.ping_url, "POST", github=False)


class FileStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.path = self.directory / "dispatch-state.json"

    def load(self):
        try:
            value = json.loads(self.path.read_text())
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            raise MonitorError("invalid_local_state") from None
        if (not isinstance(value, dict) or value.get("version") != 1
                or not isinstance(value.get("attempt_at"), (int, float))
                or not re.fullmatch(r"[0-9a-f-]{36}", value.get("correlation", ""))
                or value.get("phase") not in ("pending", "complete", "failed", "stale")):
            raise MonitorError("invalid_local_state")
        return value

    def save(self, value):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        name = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", dir=self.directory, delete=False) as output:
                name = output.name
                os.chmod(name, 0o600)
                json.dump(value, output)
                output.flush()
                os.fsync(output.fileno())
            os.replace(name, self.path)
        finally:
            if name and os.path.exists(name):
                os.unlink(name)


def timestamp(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.timestamp()
    except (AttributeError, ValueError, TypeError):
        raise MonitorError("invalid_run_timestamp") from None


def run_matches(run, state):
    return (isinstance(run, dict)
            and run.get("display_title") == TITLE_PREFIX + state["correlation"]
            and run.get("event") == "workflow_dispatch"
            and run.get("head_branch") == "main"
            and run.get("path") == WORKFLOW_PATH
            and run.get("repository", {}).get("full_name") == REPO
            and isinstance(run.get("id"), int) and not isinstance(run.get("id"), bool)
            and run["id"] > 0
            and timestamp(run.get("created_at")) >= state["attempt_at"] - 30)


def discover_run(client, state):
    earliest = dt.datetime.fromtimestamp(state["attempt_at"] - 30, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    query = urllib.parse.urlencode({"event": "workflow_dispatch", "branch": "main", "per_page": 100, "created": ">=" + earliest})
    listing = client.github("workflows/" + WORKFLOW + "/runs?" + query)
    if not isinstance(listing, dict) or not isinstance(listing.get("workflow_runs"), list):
        raise MonitorError("invalid_run_list")
    matching = [run for run in listing["workflow_runs"] if run_matches(run, state)]
    if len(matching) > 1:
        raise MonitorError("ambiguous_run")
    if not matching and (not isinstance(listing.get("total_count"), int)
                         or listing["total_count"] != len(listing["workflow_runs"])):
        # A truncated/unavailable listing cannot prove the POST was not accepted.
        raise MonitorError("incomplete_run_list")
    return matching[0] if matching else None


def report_finished(client, run):
    jobs = client.github("runs/" + str(run["id"]) + "/jobs?filter=latest&per_page=100")
    if not isinstance(jobs, dict) or jobs.get("total_count", 101) > 100 or not isinstance(jobs.get("jobs"), list):
        raise MonitorError("invalid_job_list")
    candidates = [job for job in jobs["jobs"] if job.get("name") == "check"]
    if len(candidates) != 1:
        raise MonitorError("missing_report_job")
    job = candidates[0]
    if job.get("status") != "completed" or job.get("conclusion") != "success":
        raise MonitorError("report_job_not_successful")
    for required in ("Test monitoring logic", "Check public endpoints"):
        steps = [step for step in job.get("steps", []) if step.get("name") == required]
        if len(steps) != 1 or steps[0].get("status") != "completed" or steps[0].get("conclusion") != "success":
            raise MonitorError("report_step_not_successful")
    return timestamp(job.get("completed_at"))


def run_once(client, store, now=time.time, wait=time.sleep, make_id=lambda: str(uuid.uuid4())):
    state = store.load()
    if state and now() < state["attempt_at"] - 30:
        raise MonitorError("clock_moved_backwards")
    if state and state["phase"] != "pending" and now() - state["attempt_at"] < COOLDOWN_SECONDS:
        return {"status": "cooldown"}
    if not state or state["phase"] != "pending":
        workflow = client.github("workflows/" + WORKFLOW)
        if not isinstance(workflow, dict) or workflow.get("state") != "active" or workflow.get("path") != WORKFLOW_PATH:
            raise MonitorError("workflow_not_active")
        state = {"version": 1, "attempt_at": now(), "correlation": make_id(), "phase": "pending"}
        # Persist before the POST. A timeout may mean that GitHub accepted it;
        # recovery finds that same run, and never blindly sends another POST.
        store.save(state)
        try:
            result = client.github("workflows/" + WORKFLOW + "/dispatches", "POST",
                                   {"ref": "main", "inputs": {"test_alert": False, "external_run_id": state["correlation"]}})
            if isinstance(result, dict) and isinstance(result.get("workflow_run_id"), int) and not isinstance(result.get("workflow_run_id"), bool):
                state["run_id"] = result["workflow_run_id"]
                store.save(state)
        except MonitorError as error:
            if str(error) in ("github_http_400", "github_http_401", "github_http_403", "github_http_404", "github_http_422"):
                state["phase"] = "failed"
                store.save(state)
                raise
            # Ambiguous transport/5xx outcome: discover by correlation, no retry
            # of the mutating request. A missing run leaves the watchdog red.

    deadline = now() + WAIT_SECONDS
    while now() < deadline:
        try:
            run = (client.github("runs/" + str(state["run_id"])) if state.get("run_id") else discover_run(client, state))
        except MonitorError as error:
            if str(error) in ("github_http_401", "github_http_403"):
                raise
            wait(5)
            continue
        if run is None:
            if now() - state["attempt_at"] >= MISSING_DISPATCH_SECONDS:
                # Only a successful, complete API lookup can release an ambiguous
                # POST. A genuine queued/in-progress run is never duplicated.
                state["phase"] = "failed"
                store.save(state)
                raise MonitorError("dispatch_not_created")
            wait(5)
            continue
        if not run_matches(run, state):
            raise MonitorError("run_identity_mismatch")
        state["run_id"] = run["id"]
        store.save(state)
        if run.get("status") != "completed":
            wait(5)
            continue
        if run.get("conclusion") != "success":
            state["phase"] = "failed"
            store.save(state)
            raise MonitorError("workflow_failed")
        completed_at = report_finished(client, run)
        age = now() - completed_at
        if age < -60 or age > FRESH_SECONDS:
            state["phase"] = "stale"
            store.save(state)
            raise MonitorError("completed_report_stale")
        client.heartbeat()
        state.update(phase="complete", completed_at=completed_at, heartbeat_at=now())
        store.save(state)
        return {"status": "completed", "run": "https://github.com/" + REPO + "/actions/runs/" + str(run["id"])}
    raise MonitorError("workflow_wait_timeout")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", default="/var/lib/workshop-monitor")
    args = parser.parse_args()
    try:
        client = HttpClient(os.environ.get("MONITOR_GITHUB_TOKEN"), os.environ.get("OPSPULSE_PING_URL"))
        result = run_once(client, FileStore(args.state_dir))
        print(json.dumps(result))
        return 0
    except MonitorError as error:
        print(json.dumps({"status": "failed", "reason": str(error)}))
        return 1
    except Exception:
        # Tracebacks may include request URLs; do not emit them from the service.
        print(json.dumps({"status": "failed", "reason": "internal_error"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
