# Thunder/utils/render_template.py

import asyncio
import urllib.parse
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from pyrogram.errors import FloodWait

from Thunder.bot import StreamBot
from Thunder.server.exceptions import InvalidHash
from Thunder.utils.file_properties import get_fname, get_uniqid
from Thunder.utils.logger import logger
from Thunder.vars import Var

template_env = Environment(
    loader=FileSystemLoader('Thunder/template'),
    autoescape=select_autoescape(enabled_extensions=("html",), default_for_string=True),
    enable_async=True,
    cache_size=200,
    auto_reload=False,
    optimized=True
)

_STATIC_DIR = Path(__file__).resolve().parent.parent / 'static'


def _asset_version() -> str:
    # Cache-buster for the stream page's own CSS/JS: changes whenever the files change.
    try:
        return str(int(max(f.stat().st_mtime for f in _STATIC_DIR.glob('tracks.*'))))
    except (OSError, ValueError):
        return "1"


ASSET_VERSION = _asset_version()


async def render_media_page(
    file_name: str,
    src: str,
    requested_action: str | None = None,
    media_key: str | None = None
) -> str:
    # NOTE: src must be a pre-encoded URL. Templates use |safe to avoid double-encoding.
    # media_key identifies the file for the audio/subtitle track API (see server/track_routes.py).
    if requested_action == 'stream':
        template = template_env.get_template('req.html')
        context = {
            'heading': f"View {file_name}",
            'file_name': file_name,
            'src': f"{src}?disposition=inline",
            'media_key': media_key if (media_key and Var.ENABLE_TRACK_SWITCHER) else '',
            'asset_v': ASSET_VERSION
        }
    else:
        template = template_env.get_template('dl.html')
        context = {
            'file_name': file_name,
            'src': src
        }
    return await template.render_async(**context)


async def render_page(message_id: int, secure_hash: str, requested_action: str | None = None) -> str:
    try:
        try:
            message = await StreamBot.get_messages(chat_id=int(Var.BIN_CHANNEL), message_ids=message_id)
        except FloodWait as e:
            await asyncio.sleep(e.value)
            message = await StreamBot.get_messages(chat_id=int(Var.BIN_CHANNEL), message_ids=message_id)

        if not message:
            raise InvalidHash("Message not found")

        file_unique_id = get_uniqid(message)
        file_name = get_fname(message)

        if not file_unique_id or file_unique_id[:6] != secure_hash:
            raise InvalidHash("File unique ID or secure hash mismatch during rendering.")

        quoted_filename = urllib.parse.quote(file_name.replace('/', '_'), safe="")
        src = urllib.parse.urljoin(Var.URL, f'{secure_hash}{message_id}/{quoted_filename}')
        return await render_media_page(
            file_name, src, requested_action, media_key=f"{secure_hash}{message_id}"
        )
    except Exception as e:
        logger.error(
            f"Error in render_page for message_id {message_id} and hash {secure_hash}: {e}",
            exc_info=True
        )
        raise
