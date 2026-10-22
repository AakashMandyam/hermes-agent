"""Outbound native reply targets survive the adapter's transport boundary."""
from __future__ import annotations

import pytest

from gateway.config import PlatformConfig
from plugins.platforms.photon.adapter import PhotonAdapter, PhotonSidecarError


@pytest.fixture
def transport(monkeypatch):
    adapter = PhotonAdapter(PlatformConfig(enabled=True, extra={
        "project_id": "test-project", "project_secret": "test-secret",
    }))
    calls = []

    async def call(path, body):
        calls.append((path, body))
        return {"ok": True, "messageId": "out-1"}

    monkeypatch.setattr(adapter, "_sidecar_call", call)
    return adapter, calls


@pytest.mark.asyncio
async def test_text_reply_preserves_exact_target(transport):
    adapter, calls = transport
    result = await adapter.send("space-1", "answer", reply_to="p:0/exact-target")
    assert result.success
    assert calls == [("/send", {
        "spaceId": "space-1", "text": "answer", "format": "markdown",
        "replyTo": "p:0/exact-target",
    })]


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["send_image_file", "send_voice", "send_video", "send_document", "send_image"])
async def test_media_reply_preserves_target(transport, monkeypatch, tmp_path, method):
    adapter, calls = transport
    path = tmp_path / "sample.png"
    path.write_bytes(b"image bytes")

    async def cached(url):
        return str(path)

    monkeypatch.setattr("gateway.platforms.base.cache_image_from_url", cached)
    result = await getattr(adapter, method)("space-1", str(path), caption="caption", reply_to="target-1")
    assert result.success
    assert len(calls) == 1
    endpoint, body = calls[0]
    assert endpoint == "/send-attachment"
    assert body["replyTo"] == "target-1"
    assert body["caption"] == "caption"


@pytest.mark.asyncio
async def test_plain_fallback_preserves_target(transport):
    adapter, calls = transport
    result = await adapter._send_plain_fallback("space-1", "answer", reply_to="target-1", metadata=None)
    assert result.success
    assert calls[0][1]["replyTo"] == "target-1"


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["send", "send_image_file"])
async def test_reply_mode_off_keeps_messages_top_level(transport, tmp_path, method):
    adapter, calls = transport
    adapter.config.reply_to_mode = "off"
    path = tmp_path / "sample.png"
    path.write_bytes(b"image bytes")
    result = await getattr(adapter, method)("space-1", str(path), reply_to="target-1")
    assert result.success
    assert "replyTo" not in calls[0][1]


@pytest.mark.asyncio
@pytest.mark.parametrize("content", ["notification", "https://example.com"])
async def test_no_explicit_target_never_threads_to_last_inbound(transport, content):
    adapter, calls = transport
    adapter._record_last_inbound("space-1", "recent-inbound")
    result = await adapter.send("space-1", content)
    assert result.success
    assert "replyTo" not in calls[0][1]


@pytest.mark.asyncio
async def test_richlink_reply_preserves_target(transport):
    adapter, calls = transport
    result = await adapter.send("space-1", "https://example.com", reply_to="target-1")
    assert result.success
    assert calls == [("/send-richlink", {
        "spaceId": "space-1", "url": "https://example.com", "replyTo": "target-1",
    })]


@pytest.mark.asyncio
@pytest.mark.parametrize("content", ["answer", "https://example.com"])
async def test_missing_target_does_not_retry_or_fallback(transport, monkeypatch, content):
    adapter, calls = transport

    async def missing(path, body):
        calls.append((path, body))
        raise PhotonSidecarError(path=path, status_code=500, error="reply target unavailable",
                                 error_class="reply_target_unavailable", retryable=False)

    monkeypatch.setattr(adapter, "_sidecar_call", missing)
    result = await adapter._send_with_retry("space-1", content, reply_to="missing-target")
    assert not result.success
    assert result.retryable is False
    assert len(calls) == 1
    assert result.raw_response["error_class"] == "reply_target_unavailable"
