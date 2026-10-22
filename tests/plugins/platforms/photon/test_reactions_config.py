"""YAML reaction policy overrides the legacy Photon environment flag."""
import pytest
from utils import fast_safe_load

from gateway.config import PlatformConfig
from gateway.platforms.event import MessageEvent, ProcessingOutcome
from plugins.platforms.photon.adapter import PhotonAdapter


@pytest.mark.asyncio
@pytest.mark.parametrize("configured,legacy,enabled", [
    (True, "false", True), (False, "true", False),
    (True, None, True), (False, None, False),
    (None, "true", True), (None, "false", False), (None, None, False),
])
async def test_yaml_controls_processing_reactions(monkeypatch, configured, legacy, enabled):
    if legacy is None:
        monkeypatch.delenv("PHOTON_REACTIONS", raising=False)
    else:
        monkeypatch.setenv("PHOTON_REACTIONS", legacy)
    raw = fast_safe_load(f"""
    gateway:
      platforms:
        photon:
          enabled: true
          reactions: {"null" if configured is None else str(configured).lower()}
    """)
    adapter = PhotonAdapter(PlatformConfig.from_dict(raw["gateway"]["platforms"]["photon"]))
    calls = []

    async def call(path, body):
        calls.append((path, body))
        return {"ok": True}

    monkeypatch.setattr(adapter, "_sidecar_call", call)
    event = MessageEvent(text="question", message_id="in-1", source=adapter.build_source(
        chat_id="space-1", chat_type="dm", user_id="user-1"))
    await adapter.on_processing_start(event)
    await adapter.on_processing_complete(event, ProcessingOutcome.SUCCESS)
    assert calls == ([
        ("/react", {"spaceId": "space-1", "messageId": "in-1", "emoji": "👀"}),
        ("/unreact", {"spaceId": "space-1", "messageId": "in-1"}),
        ("/react", {"spaceId": "space-1", "messageId": "in-1", "emoji": "👍"}),
    ] if enabled else [])
