"""Real tunnel smoke check using synthetic Codex data, never the user's account."""
from __future__ import annotations

import json
import os
import shlex
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import codex_pocket as pocket


def main() -> None:
    ready = threading.Event()
    failures = []
    with tempfile.TemporaryDirectory(prefix="pocket-live-") as directory:
        pocket.DATA_DIR = Path(directory)
        pocket.LOG_PATH = pocket.DATA_DIR / "desktop.log"
        os.environ["RELAY_DATA_DIR"] = directory
        os.environ["CODEX_HOME"] = str(pocket.DATA_DIR / "synthetic-codex-home")
        os.environ.pop("CODEX_APP_TOOLS_PIPE_PATH", None)
        node = pocket.find_node()
        fixture = pocket.APP_DIR / "scripts" / "fixtures" / "fake-codex.mjs"
        command = pocket.DATA_DIR / ("codex.cmd" if os.name == "nt" else "codex")
        command.write_text(
            f'@echo off\n"{node}" "{fixture}" %*\n' if os.name == "nt"
            else f'#!/bin/sh\nexec {shlex.quote(node)} {shlex.quote(str(fixture))} "$@"\n',
            encoding="utf-8",
        )
        command.chmod(0o700)
        os.environ["CODEX_BIN"] = str(command)
        manager = pocket.ServiceManager(
            on_status=lambda _value: None,
            on_ready=lambda _url, _key: ready.set(),
            on_failure=failures.append,
        )
        try:
            manager.start()
            assert ready.is_set(), "Service did not start"
            viewer = manager.viewer_process
            access_key = manager.access_key
            request = urllib.request.Request(
                f"http://127.0.0.1:{manager.port}/api/bootstrap",
                headers={"Authorization": f"Bearer {access_key}"},
            )
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(request, timeout=25) as response:
                assert isinstance(json.load(response)["threads"], list)
            print("Authenticated synthetic Codex connection passed", flush=True)

            public_request = urllib.request.Request(
                f"{manager.public_url}/api/sync",
                headers={"Authorization": f"Bearer {access_key}"},
            )
            for attempt in range(10):
                try:
                    with urllib.request.urlopen(public_request, timeout=10) as response:
                        events = json.load(response)["events"]
                        assert any(event["event"] == "threads" for event in events)
                    break
                except urllib.error.URLError:
                    if attempt == 9:
                        raise
                    time.sleep(1)
            print("Authenticated HTTPS synchronization through Quick Tunnel passed", flush=True)

            ready.clear()
            pocket.terminate_process_tree(manager.tunnel_process)
            if not ready.wait(90):
                raise RuntimeError(f"Tunnel did not recover: {failures}")
            assert not failures, failures
            assert manager.viewer_process is viewer and viewer.poll() is None
            assert manager.access_key == access_key
            with opener.open(request, timeout=25) as response:
                assert response.status == 200
            print("Tunnel process recovery preserved local service and access key", flush=True)
        finally:
            manager.request_shutdown()
            manager.stop()
        assert not manager.running
        print("Owned service and tunnel stopped cleanly", flush=True)


if __name__ == "__main__":
    main()
