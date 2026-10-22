"""Inbound event anchors deliver through the real sidecar and pinned SDK.

Only the native iMessage transport is in memory; no credentials or messaging
service are used. Requires the sidecar's pinned npm dependencies and Node 22+.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import shutil

import httpx
import pytest
import pytest_asyncio

from gateway.config import PlatformConfig
from gateway.platforms.base import _reply_anchor_for_event
from plugins.platforms.photon.adapter import PhotonAdapter

SIDECAR = Path(__file__).resolve().parents[4] / "plugins/platforms/photon/sidecar"
DESTINATION = "any;+;destination-room"


@pytest_asyncio.fixture
async def sdk_sidecar(tmp_path):
    node = shutil.which("node")
    assert node, "Node is required for the pinned-SDK transport regressions"
    env = {key: os.environ[key] for key in ("PATH", "TMPDIR") if key in os.environ}
    env.update({
        "HOME": str(tmp_path), "HERMES_HOME": str(tmp_path / ".hermes"),
        "HERMES_RUNTIME_DIR": str(tmp_path / "runtime"),
        "PHOTON_PROJECT_ID": "in-memory-project", "PHOTON_PROJECT_SECRET": "in-memory-secret",
        "PHOTON_SIDECAR_TOKEN": "in-memory-token", "PHOTON_SIDECAR_PORT": "0",
        "PHOTON_READ_RECEIPTS": "false", "PHOTON_STREAM_SILENCE_PROBE_MS": "0",
    })
    with (tmp_path / "sidecar.log").open("w+") as log:
        process = await asyncio.create_subprocess_exec(
            node, str(SIDECAR / "sdk-transport.fixture.mjs"), cwd=SIDECAR, env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=log,
        )
        assert process.stdout is not None and process.stdin is not None

        async def receive() -> dict:
            async with asyncio.timeout(15):
                while line := await process.stdout.readline():
                    try:
                        return json.loads(line)
                    except json.JSONDecodeError:
                        continue  # SDK lifecycle logs are not fixture control responses.
            log.seek(0)
            raise AssertionError(f"SDK fixture exited {process.returncode}: {log.read()}")

        try:
            ready = await receive()
            assert ready.get("ready"), ready
            adapter = PhotonAdapter(PlatformConfig(enabled=True, extra={
                "project_id": "in-memory-project", "project_secret": "in-memory-secret",
            }))
            adapter._sidecar_port = ready["port"]
            adapter._sidecar_token = "in-memory-token"
            adapter._http_client = httpx.AsyncClient(trust_env=False)

            async def control(**command):
                process.stdin.write((json.dumps(command) + "\n").encode())
                await process.stdin.drain()
                result = await receive()
                assert "error" not in result, result
                return result["calls"]

            try:
                yield adapter, control
            finally:
                await adapter._http_client.aclose()
        finally:
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), 5)
                except TimeoutError:
                    process.kill()
                    await process.wait()
            log.seek(0)
            print(log.read())


async def inbound(adapter, control, kind):
    async def read_event():
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            async with client.stream("GET", adapter._sidecar_url("/inbound"),
                                     headers=adapter._sidecar_headers()) as response:
                assert response.status_code == 200
                async for line in response.aiter_lines():
                    if line:
                        return json.loads(line)
    task = asyncio.create_task(read_event())
    try:
        await control(op="emit", kind=kind)
        return await asyncio.wait_for(task, 15)
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize(("kind", "event_id", "anchor"), [
    ("reaction", "original-guid:reaction:42", "original-guid"),
    ("poll", "poll-guid:user-1:choice-id:selected:123", ""),
])
async def test_synthetic_inbound_id_is_not_used_as_native_reply_target(
    sdk_sidecar, monkeypatch, kind, event_id, anchor,
):
    adapter, control = sdk_sidecar
    received = await inbound(adapter, control, kind)
    events, results = [], []

    async def respond(event):
        events.append(event)
        results.append(await adapter._send_with_retry(
            event.source.chat_id, "answer", reply_to=_reply_anchor_for_event(event)))

    monkeypatch.setattr(adapter, "handle_message", respond)
    await adapter._dispatch_inbound(received)
    assert events[0].message_id == event_id  # preserve synthetic dedup identity
    assert results[0].success, results[0]
    assert _reply_anchor_for_event(events[0]) == anchor
    calls = await control(op="calls")
    sent = [call for call in calls if call["op"] == "sendText"]
    assert len(sent) == 1
    assert sent[0]["chat"] == DESTINATION
    assert sent[0].get("options", {}).get("replyTo") == (anchor or None)
    assert not any(call.get("id") == event_id for call in calls)


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["/send", "/send-richlink", "/send-attachment"])
async def test_unsupported_cached_poll_reply_is_explicit_failure(sdk_sidecar, tmp_path, endpoint):
    adapter, control = sdk_sidecar
    created = await adapter._sidecar_call("/send-poll", {
        "spaceId": DESTINATION, "title": "Choose", "options": ["Yes", "No"],
    })
    assert created["messageId"] == "poll-guid"  # warms the real provider's poll target cache
    path = tmp_path / "photo.png"
    path.write_bytes(b"image bytes")
    body = {"spaceId": DESTINATION, "replyTo": "poll-guid", "text": "answer",
            "url": "https://example.com", "path": str(path), "caption": "caption"}
    async with httpx.AsyncClient(trust_env=False) as client:
        response = await client.post(adapter._sidecar_url(endpoint), json=body,
                                     headers=adapter._sidecar_headers())
    calls = await control(op="calls")
    assert not [call for call in calls if call["op"] in {"sendText", "sendAttachment", "upload"}]
    assert response.status_code == 500, response.text
    assert response.json() == {"ok": False, "error": "internal sidecar error",
                               "error_class": "message_not_delivered", "retryable": False}


@pytest.mark.asyncio
@pytest.mark.parametrize("content", ["answer", "https://example.com"])
async def test_unsupported_reply_does_not_retry_or_send_top_level(sdk_sidecar, content):
    adapter, control = sdk_sidecar
    await adapter._sidecar_call("/send-poll", {
        "spaceId": DESTINATION, "title": "Choose", "options": ["Yes", "No"],
    })
    result = await adapter._send_with_retry(DESTINATION, content, reply_to="poll-guid")
    assert not result.success
    assert result.retryable is False
    assert result.raw_response["error_class"] == "message_not_delivered"
    calls = await control(op="calls")
    assert [call for call in calls if call["op"] == "get"] == [{"op": "get", "id": "poll-guid"}]
    assert not [call for call in calls if call["op"] == "sendText"]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["unsupported", "error"])
async def test_delivered_media_is_not_retried_when_caption_fails(sdk_sidecar, tmp_path, failure):
    adapter, control = sdk_sidecar
    await control(op="captionFailure", kind=failure)
    path = tmp_path / "photo.png"
    path.write_bytes(b"image bytes")
    result = await adapter.send_image_file(DESTINATION, str(path), caption="caption", reply_to="original-guid")
    assert result.success, result
    calls = await control(op="calls")
    assert len([call for call in calls if call["op"] == "sendAttachment"]) == 1
    assert len([call for call in calls if call["op"] == "upload"]) == 1
    captions = [call for call in calls if call["op"] == "sendText"]
    assert len(captions) == 1
    assert captions[0]["options"]["replyTo"] == "original-guid"
