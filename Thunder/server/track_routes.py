# Thunder/server/track_routes.py
"""HTTP endpoints used by the stream page to list / switch audio and subtitle tracks."""

import re
import secrets
import time
from pathlib import Path
from urllib.parse import unquote

from aiohttp import web

from Thunder.utils import media_tracks as mt
from Thunder.utils.logger import logger
from Thunder.vars import Var

routes = web.RouteTableDef()

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# Same shapes the stream page is served under (see stream_routes.py):
#   /watch/<hash6><message_id>/<name>   ->  media key  "<hash6><message_id>"
#   /watch/f/<public_hash>/<name>       ->  media key  "f/<public_hash>"
PATTERN_HASH_FIRST = re.compile(r"^([a-zA-Z0-9_-]{6})(\d+)(?:/.*)?$")
PATTERN_CANONICAL = re.compile(r"^f/([0-9a-f]{6,64})(?:/.*)?$")

COMMON_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
}
NO_STORE = {"Cache-Control": "no-store"}

AUDIO_FIRST_BYTE_TIMEOUT = 120
MAX_START_SECONDS = 3 * 24 * 3600


def _internal_base() -> str:
    """Address ffmpeg uses to reach this very server (never the public URL)."""
    host = Var.BIND_ADDRESS
    if host in ("", "0.0.0.0"):
        host = "127.0.0.1"
    elif host in ("::", "::0"):
        host = "[::1]"
    elif ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"http://{host}:{Var.PORT}"


def _resolve_source(path: str) -> tuple[str, str]:
    """Validate the media key from the URL and build the loopback URL ffmpeg will read.

    Only strictly matched components are used, so nothing user-controlled other than a
    message id / hash can end up in the URL.
    """
    clean = unquote(path).strip("/")
    match = PATTERN_CANONICAL.match(clean)
    if match:
        public_hash = match.group(1)
        return f"f/{public_hash}", f"{_internal_base()}/f/{public_hash}/media"
    match = PATTERN_HASH_FIRST.match(clean)
    if match:
        key = f"{match.group(1)}{match.group(2)}"
        return key, f"{_internal_base()}/{key}/media"
    raise web.HTTPNotFound(text="Resource not found", headers=COMMON_HEADERS)


def _error(status: int, message: str) -> web.Response:
    return web.json_response({"error": message}, status=status, headers={**COMMON_HEADERS, **NO_STORE})


def _enabled() -> bool:
    return Var.ENABLE_TRACK_SWITCHER and mt.tools_available()


@routes.get(r"/api/tracks/{path:.+}")
async def list_tracks(request: web.Request):
    key, url = _resolve_source(request.match_info["path"])
    if not _enabled():
        return web.json_response({"available": False, "reason": "disabled"},
                                 headers={**COMMON_HEADERS, **NO_STORE})
    try:
        data = await mt.probe_tracks(key, url)
    except mt.TrackError as e:
        # Not a media file / unreadable: the page simply hides the track buttons.
        return web.json_response({"available": False, "reason": e.message},
                                 headers={**COMMON_HEADERS, **NO_STORE})
    except Exception as e:  # noqa: BLE001
        error_id = secrets.token_hex(6)
        logger.error(f"Track listing error {error_id}: {e}", exc_info=True)
        return _error(500, f"Server error occurred: {error_id}")
    return web.json_response(data, headers={**COMMON_HEADERS, "Cache-Control": "private, max-age=300"})


@routes.get(r"/api/subtitle/{index:\d+}/{path:.+}")
async def get_subtitle(request: web.Request):
    key, url = _resolve_source(request.match_info["path"])
    if not _enabled():
        return _error(404, "Track switching is disabled")
    index = int(request.match_info["index"])
    try:
        vtt = await mt.request_subtitle(key, url, index)
    except mt.TrackError as e:
        return _error(e.status, e.message)
    except Exception as e:  # noqa: BLE001
        error_id = secrets.token_hex(6)
        logger.error(f"Subtitle error {error_id}: {e}", exc_info=True)
        return _error(500, f"Server error occurred: {error_id}")

    if vtt is None:
        # Still converting - the page polls this URL until it gets the file.
        return web.json_response({"status": "processing"}, status=202,
                                 headers={**COMMON_HEADERS, **NO_STORE, "Retry-After": "2"})
    return web.Response(text=vtt, content_type="text/vtt", charset="utf-8",
                        headers={**COMMON_HEADERS, "Cache-Control": "private, max-age=3600"})


def _client_gone(request: web.Request) -> bool:
    transport = request.transport
    return transport is None or transport.is_closing()


@routes.get(r"/api/audio/{index:\d+}/{path:.+}", allow_head=False)
async def get_audio(request: web.Request):
    key, url = _resolve_source(request.match_info["path"])
    if not _enabled():
        return _error(404, "Track switching is disabled")
    index = int(request.match_info["index"])
    try:
        start = float(request.query.get("start", "0") or 0)
    except ValueError:
        return _error(400, "Invalid start time")
    if not 0 <= start <= MAX_START_SECONDS:
        return _error(400, "Invalid start time")

    try:
        tracks = await mt.probe_tracks(key, url)
    except mt.TrackError as e:
        return _error(e.status, e.message)
    if not any(a["index"] == index for a in tracks["audio"]):
        return _error(404, "No such audio track")

    stream = mt.AudioStream(url, index, start)
    response = None
    began = time.monotonic()
    try:
        await stream.open()
        while True:
            chunk = await stream.read(timeout=2.0)
            if chunk is None:
                if _client_gone(request):
                    return web.Response(status=204)
                if response is None and time.monotonic() - began > AUDIO_FIRST_BYTE_TIMEOUT:
                    return _error(504, "Timed out while preparing the audio track")
                continue
            if not chunk:
                break
            if response is None:
                response = web.StreamResponse(status=200, headers={
                    **COMMON_HEADERS,
                    **NO_STORE,
                    "Content-Type": stream.mime,
                    "Accept-Ranges": "none",
                })
                await response.prepare(request)
            await response.write(chunk)
        if response is None:
            logger.warning(f"Audio extraction produced no data: {stream.error_text[-300:]}")
            return _error(500, "Could not extract this audio track")
        await response.write_eof()
        return response
    except mt.TrackError as e:
        if response is not None:
            return response
        return _error(e.status, e.message)
    except ConnectionResetError:
        # Player seeked / switched track / closed the page: just stop transcoding.
        return response if response is not None else web.Response(status=204)
    except Exception as e:  # noqa: BLE001
        error_id = secrets.token_hex(6)
        logger.error(f"Audio stream error {error_id}: {e}", exc_info=True)
        if response is not None:
            return response
        return _error(500, f"Server error occurred: {error_id}")
    finally:
        await stream.close()


ASSET_TYPES = {"tracks.js": "application/javascript", "tracks.css": "text/css"}


@routes.get(r"/player-assets/{name:tracks\.(?:js|css)}")
async def player_asset(request: web.Request):
    name = request.match_info["name"]
    try:
        body = (STATIC_DIR / name).read_bytes()
    except OSError:
        raise web.HTTPNotFound(text="Resource not found")
    return web.Response(body=body, content_type=ASSET_TYPES[name], charset="utf-8",
                        headers={"Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff"})
