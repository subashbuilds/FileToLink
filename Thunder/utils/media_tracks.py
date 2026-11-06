# Thunder/utils/media_tracks.py
"""
Audio / subtitle track support for the stream page.

Browsers cannot switch the audio track (or show embedded subtitles) of an
MKV/MP4 file on their own, so the heavy lifting is done server side with ffmpeg:

* ``probe_tracks``      -> lists the audio + subtitle streams (ffprobe, cached)
* ``request_subtitle``  -> converts embedded text subtitles to WebVTT (ffmpeg, cached)
* ``AudioStream``       -> streams one audio track as MP3 so the page can play it
                           in sync with the (silenced) video.

ffmpeg reads the media through the bot's own HTTP endpoint (loopback), so the
existing Telegram streaming code (Range support, multi-client, etc.) is reused.
Nothing in this module talks to Telegram or aiohttp directly.
"""

import asyncio
import json
import shutil
import tempfile
import time
from collections import OrderedDict
from pathlib import Path
from typing import Optional

from Thunder.utils.logger import logger

# --------------------------------------------------------------------------- #
# Limits / tunables
# --------------------------------------------------------------------------- #
PROBE_TIMEOUT = 45                # seconds for ffprobe
PROBE_TTL = 6 * 3600              # how long a probe result is cached
PROBE_CACHE_SIZE = 256
MAX_PROBES = 3                    # concurrent ffprobe processes

SUBTITLE_TIMEOUT = 30 * 60        # a full scan of a big file can take a while
SUBTITLE_CACHE_SIZE = 24          # media files whose converted subtitles are kept in RAM
SUBTITLE_ERROR_TTL = 60
MAX_SUBTITLE_JOBS = 2             # concurrent subtitle extraction jobs
MAX_SUBTITLE_TRACKS = 32

MAX_AUDIO_STREAMS = 8             # concurrent transcoded audio streams
AUDIO_READ_RATE = 3               # ffmpeg reads the source at most N x real-time
AUDIO_BITRATE = "192k"

# Only these demuxers / protocols may be used by ffmpeg. Users upload arbitrary
# files to the bot, so a crafted playlist (HLS, concat, ...) must never be able
# to make ffmpeg read local files or reach other hosts.
PROTOCOL_WHITELIST = "http,tcp"
FORMAT_WHITELIST = (
    "matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,avi,mpegts,mpeg,flv,asf,ogg,"
    "ac3,eac3,mp3,flac,wav,aac,h264,hevc,mpegvideo,m4v,ogv"
)

# Audio codecs every mainstream browser can decode inside MKV/MP4/WebM.
NATIVE_AUDIO_CODECS = {"aac", "mp3", "opus", "vorbis", "flac"}

TEXT_SUBTITLE_CODECS = {
    "subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text",
    "subviewer", "subviewer1", "microdvd", "mpl2", "realtext", "sami",
    "jacosub", "vplayer", "stl", "pjs", "ttml",
}
BITMAP_SUBTITLE_NAMES = {
    "hdmv_pgs_subtitle": "PGS",
    "dvd_subtitle": "VobSub",
    "dvb_subtitle": "DVB",
    "xsub": "XSUB",
}

CODEC_NAMES = {
    "aac": "AAC", "ac3": "AC3", "eac3": "E-AC3", "dts": "DTS", "truehd": "TrueHD",
    "mlp": "MLP", "mp3": "MP3", "mp2": "MP2", "opus": "Opus", "vorbis": "Vorbis",
    "flac": "FLAC", "alac": "ALAC", "wmav2": "WMA", "wmapro": "WMA Pro",
    "subrip": "SRT", "srt": "SRT", "ass": "ASS", "ssa": "SSA", "mov_text": "MP4 text",
    "webvtt": "WebVTT", "text": "Text", "hdmv_pgs_subtitle": "PGS",
    "dvd_subtitle": "VobSub", "dvb_subtitle": "DVB",
}

LANGUAGES = {
    "eng": "English", "en": "English", "tam": "Tamil", "ta": "Tamil", "hin": "Hindi", "hi": "Hindi",
    "tel": "Telugu", "te": "Telugu", "mal": "Malayalam", "ml": "Malayalam", "kan": "Kannada",
    "kn": "Kannada", "ben": "Bengali", "bn": "Bengali", "mar": "Marathi", "mr": "Marathi",
    "guj": "Gujarati", "gu": "Gujarati", "pan": "Punjabi", "pa": "Punjabi", "urd": "Urdu",
    "ur": "Urdu", "sin": "Sinhala", "nep": "Nepali", "ori": "Odia", "asm": "Assamese",
    "jpn": "Japanese", "ja": "Japanese", "kor": "Korean", "ko": "Korean",
    "chi": "Chinese", "zho": "Chinese", "cmn": "Chinese", "zh": "Chinese", "yue": "Cantonese",
    "spa": "Spanish", "es": "Spanish", "fre": "French", "fra": "French", "fr": "French",
    "ger": "German", "deu": "German", "de": "German", "ita": "Italian", "it": "Italian",
    "por": "Portuguese", "pt": "Portuguese", "rus": "Russian", "ru": "Russian",
    "ara": "Arabic", "ar": "Arabic", "tur": "Turkish", "tr": "Turkish", "tha": "Thai",
    "th": "Thai", "vie": "Vietnamese", "vi": "Vietnamese", "ind": "Indonesian",
    "id": "Indonesian", "may": "Malay", "msa": "Malay", "fil": "Filipino", "tgl": "Filipino",
    "dut": "Dutch", "nld": "Dutch", "nl": "Dutch", "pol": "Polish", "pl": "Polish",
    "swe": "Swedish", "sv": "Swedish", "nor": "Norwegian", "nob": "Norwegian", "dan": "Danish",
    "da": "Danish", "fin": "Finnish", "fi": "Finnish", "gre": "Greek", "ell": "Greek",
    "heb": "Hebrew", "he": "Hebrew", "per": "Persian", "fas": "Persian", "ukr": "Ukrainian",
    "cze": "Czech", "ces": "Czech", "hun": "Hungarian", "rum": "Romanian", "ron": "Romanian",
    "bul": "Bulgarian", "hrv": "Croatian", "srp": "Serbian", "slv": "Slovenian",
    "slo": "Slovak", "slk": "Slovak", "cat": "Catalan", "lat": "Latin",
    "mul": "Multiple languages", "zxx": "No language",
}


class TrackError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def tools_available() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def _input_args(url: str, *, reconnect: bool = False) -> list[str]:
    args = ["-protocol_whitelist", PROTOCOL_WHITELIST, "-format_whitelist", FORMAT_WHITELIST]
    if reconnect:
        args += ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "2"]
    return args


async def _run(cmd: list[str], timeout: float) -> tuple[int, bytes, bytes]:
    """Run a command, kill it on timeout / cancellation, return (rc, stdout, stderr)."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        _kill(proc)
        await _reap(proc)
        raise TrackError(504, "Timed out while reading the media file")
    except BaseException:
        _kill(proc)
        await _reap(proc)
        raise
    return proc.returncode or 0, out, err


def _kill(proc: asyncio.subprocess.Process) -> None:
    try:
        if proc.returncode is None:
            proc.kill()
    except ProcessLookupError:
        pass


async def _reap(proc: asyncio.subprocess.Process) -> None:
    try:
        await asyncio.wait_for(proc.wait(), timeout=5)
    except Exception:
        pass


def _language_name(code: str) -> str:
    code = (code or "").strip().lower()
    if not code or code == "und":
        return ""
    return LANGUAGES.get(code, LANGUAGES.get(code[:2], code.upper() if len(code) <= 3 else code.title()))


def _channel_text(stream: dict) -> str:
    layout = (stream.get("channel_layout") or "").lower()
    channels = stream.get("channels") or 0
    if layout.startswith(("5.1", "7.1", "6.1", "2.1", "4.0", "4.1", "5.0", "3.0")):
        return layout.split("(")[0]
    names = {1: "Mono", 2: "Stereo", 6: "5.1", 7: "6.1", 8: "7.1"}
    if channels in names:
        return names[channels]
    return f"{channels}ch" if channels else ""


def _flag(stream: dict, name: str) -> bool:
    return bool((stream.get("disposition") or {}).get(name))


def _describe(parts: list[str]) -> str:
    return " · ".join(p for p in parts if p)


def _parse_probe(data: dict) -> dict:
    audio, subtitles = [], []
    for stream in data.get("streams") or []:
        kind = stream.get("codec_type")
        tags = {str(k).lower(): v for k, v in (stream.get("tags") or {}).items()}
        codec = (stream.get("codec_name") or "").lower()
        lang_code = (tags.get("language") or "").lower()
        language = _language_name(lang_code)
        title = (tags.get("title") or "").strip()
        if kind == "audio":
            number = len(audio) + 1
            label = language or title or f"Track {number}"
            extra_title = title if title and title.lower() != language.lower() else ""
            audio.append({
                "index": stream["index"],
                "codec": codec,
                "lang": lang_code,
                "label": label,
                "detail": _describe([extra_title, CODEC_NAMES.get(codec, codec.upper()), _channel_text(stream)]),
                "default": _flag(stream, "default"),
                "native": codec in NATIVE_AUDIO_CODECS,
            })
        elif kind == "subtitle":
            number = len(subtitles) + 1
            supported = codec in TEXT_SUBTITLE_CODECS
            label = language or title or f"Track {number}"
            extra_title = title if title and title.lower() != language.lower() else ""
            flags = []
            if _flag(stream, "forced"):
                flags.append("Forced")
            if _flag(stream, "hearing_impaired"):
                flags.append("SDH")
            subtitles.append({
                "index": stream["index"],
                "codec": codec,
                "lang": lang_code,
                "label": label,
                "detail": _describe([extra_title, CODEC_NAMES.get(codec, codec.upper()), *flags]),
                "default": _flag(stream, "default"),
                "forced": _flag(stream, "forced"),
                "supported": supported,
                "reason": "" if supported else (
                    f"Image-based ({BITMAP_SUBTITLE_NAMES.get(codec, codec.upper() or 'unknown')}) "
                    "subtitles can't be shown in the browser"
                ),
            })

    # The track the browser itself plays when nothing is changed: the one flagged
    # "default", otherwise the first. Selecting it again means "use the original audio".
    native_index = None
    if audio:
        chosen = next((a for a in audio if a["default"]), audio[0])
        native_index = chosen["index"]
    return {
        "available": True,
        "audio": audio,
        "subtitles": subtitles[:MAX_SUBTITLE_TRACKS * 2],
        "native_audio": native_index,
    }


# --------------------------------------------------------------------------- #
# Probing (ffprobe)
# --------------------------------------------------------------------------- #
_probe_sem = asyncio.Semaphore(MAX_PROBES)
_probe_cache: "OrderedDict[str, tuple[float, asyncio.Task]]" = OrderedDict()


async def _probe(url: str) -> dict:
    async with _probe_sem:
        cmd = [
            "ffprobe", "-v", "error", "-hide_banner",
            *_input_args(url),
            "-probesize", "10M", "-analyzeduration", "10M",
            "-of", "json", "-show_streams", "-i", url,
        ]
        rc, out, err = await _run(cmd, PROBE_TIMEOUT)
    if rc != 0:
        msg = err.decode("utf-8", "replace").strip()[-300:]
        logger.debug(f"ffprobe failed: {msg}")
        raise TrackError(422, "Could not read the media tracks of this file")
    try:
        return _parse_probe(json.loads(out.decode("utf-8", "replace") or "{}"))
    except (ValueError, KeyError) as e:
        raise TrackError(422, "Could not parse the media tracks of this file") from e


def _silence(task: asyncio.Task) -> None:
    if not task.cancelled():
        task.exception()


async def probe_tracks(key: str, url: str) -> dict:
    now = time.monotonic()
    entry = _probe_cache.get(key)
    task = None
    if entry:
        started, cached = entry
        if not cached.done() or (not cached.cancelled() and cached.exception() is None
                                 and now - started < PROBE_TTL):
            task = cached
            _probe_cache.move_to_end(key)
    if task is None:
        task = asyncio.create_task(_probe(url))
        task.add_done_callback(_silence)
        _probe_cache[key] = (now, task)
        while len(_probe_cache) > PROBE_CACHE_SIZE:
            _probe_cache.popitem(last=False)
    return await asyncio.shield(task)


# --------------------------------------------------------------------------- #
# Subtitles (ffmpeg -> WebVTT)
# --------------------------------------------------------------------------- #
_subtitle_sem = asyncio.Semaphore(MAX_SUBTITLE_JOBS)
_sub_cache: "OrderedDict[str, dict[int, str]]" = OrderedDict()
_sub_jobs: dict[str, asyncio.Task] = {}
_sub_errors: dict[str, tuple[float, str]] = {}


async def _extract_subtitles(url: str, indexes: list[int]) -> dict[int, str]:
    async with _subtitle_sem:
        with tempfile.TemporaryDirectory(prefix="thunder_subs_") as tmp:
            cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                   *_input_args(url, reconnect=True), "-i", url]
            for idx in indexes:
                cmd += ["-map", f"0:{idx}", "-c:s", "webvtt", "-f", "webvtt", str(Path(tmp) / f"{idx}.vtt")]
            rc, _, err = await _run(cmd, SUBTITLE_TIMEOUT)
            results: dict[int, str] = {}
            for idx in indexes:
                path = Path(tmp) / f"{idx}.vtt"
                if path.exists() and path.stat().st_size > 0:
                    results[idx] = path.read_text("utf-8", errors="replace")
            if not results:
                detail = err.decode("utf-8", "replace").strip()[-300:]
                logger.warning(f"Subtitle extraction produced nothing (rc={rc}): {detail}")
                raise TrackError(500, "Could not extract the subtitles from this file")
            return results


async def _subtitle_worker(key: str, url: str, indexes: list[int]) -> None:
    try:
        results = await _extract_subtitles(url, indexes)
        _sub_cache[key] = results
        _sub_cache.move_to_end(key)
        while len(_sub_cache) > SUBTITLE_CACHE_SIZE:
            _sub_cache.popitem(last=False)
    except TrackError as e:
        _sub_errors[key] = (time.monotonic(), e.message)
    except Exception as e:  # noqa: BLE001 - never let a background task die silently
        logger.error(f"Subtitle worker failed: {e}", exc_info=True)
        _sub_errors[key] = (time.monotonic(), "Could not extract the subtitles from this file")
    finally:
        _sub_jobs.pop(key, None)


async def request_subtitle(key: str, url: str, index: int) -> Optional[str]:
    """Return WebVTT text, or None while the conversion is still running."""
    tracks = await probe_tracks(key, url)
    wanted = next((s for s in tracks["subtitles"] if s["index"] == index), None)
    if wanted is None:
        raise TrackError(404, "No such subtitle track")
    if not wanted["supported"]:
        raise TrackError(415, wanted["reason"])

    cached = _sub_cache.get(key)
    if cached is not None:
        _sub_cache.move_to_end(key)
        if index in cached:
            return cached[index]
        raise TrackError(500, "This subtitle track could not be converted")

    failed = _sub_errors.get(key)
    if failed:
        if time.monotonic() - failed[0] < SUBTITLE_ERROR_TTL:
            raise TrackError(500, failed[1])
        _sub_errors.pop(key, None)

    if key not in _sub_jobs:
        indexes = [s["index"] for s in tracks["subtitles"] if s["supported"]][:MAX_SUBTITLE_TRACKS]
        _sub_jobs[key] = asyncio.create_task(_subtitle_worker(key, url, indexes))
    return None


# --------------------------------------------------------------------------- #
# Audio (ffmpeg -> MP3 stream)
# --------------------------------------------------------------------------- #
_audio_active = 0
_audio_encoder: Optional[tuple[str, str, str]] = None


async def _pick_audio_encoder() -> tuple[str, str, str]:
    """(encoder, container, mime) - MP3 streams everywhere; AAC/ADTS is the fallback."""
    global _audio_encoder
    if _audio_encoder is None:
        _, out, _ = await _run(["ffmpeg", "-hide_banner", "-encoders"], 15)
        text = out.decode("utf-8", "replace")
        if "libmp3lame" in text:
            _audio_encoder = ("libmp3lame", "mp3", "audio/mpeg")
        elif " aac " in text:
            _audio_encoder = ("aac", "adts", "audio/aac")
        else:
            raise TrackError(501, "This server's ffmpeg has no usable audio encoder")
    return _audio_encoder


class AudioStream:
    """One running ffmpeg process turning a single audio track into a stream."""

    def __init__(self, url: str, index: int, start: float = 0.0):
        self.url = url
        self.index = index
        self.start = max(0.0, start)
        self.mime = "audio/mpeg"
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._err_task: Optional[asyncio.Task] = None
        self._err = b""
        self._counted = False

    async def open(self) -> None:
        global _audio_active
        if _audio_active >= MAX_AUDIO_STREAMS:
            raise TrackError(503, "Too many audio streams are active, please retry shortly")
        # Reserve the slot right away (before any await) so concurrent requests can't all slip past the cap.
        _audio_active += 1
        self._counted = True
        encoder, container, self.mime = await _pick_audio_encoder()
        cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
               *_input_args(self.url, reconnect=True), "-readrate", str(AUDIO_READ_RATE)]
        if self.start > 0:
            cmd += ["-ss", f"{self.start:.3f}"]
        cmd += ["-i", self.url, "-map", f"0:{self.index}", "-vn", "-sn", "-dn",
                "-af", "aresample=async=1:first_pts=0",
                "-c:a", encoder, "-b:a", AUDIO_BITRATE, "-ac", "2", "-ar", "48000",
                "-f", container, "pipe:1"]
        self._proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._err_task = asyncio.create_task(self._drain_stderr())

    async def _drain_stderr(self) -> None:
        try:
            while True:
                chunk = await self._proc.stderr.read(4096)
                if not chunk:
                    return
                self._err = (self._err + chunk)[-2000:]
        except Exception:  # noqa: BLE001
            return

    @property
    def error_text(self) -> str:
        return self._err.decode("utf-8", "replace").strip()

    async def read(self, size: int = 65536, timeout: float = 2.0) -> Optional[bytes]:
        """Next chunk; b'' at end of stream; None if nothing arrived within ``timeout``."""
        try:
            return await asyncio.wait_for(self._proc.stdout.read(size), timeout)
        except asyncio.TimeoutError:
            return None

    async def close(self) -> None:
        global _audio_active
        if self._proc is not None:
            _kill(self._proc)
        if self._counted:
            self._counted = False
            _audio_active = max(0, _audio_active - 1)
        if self._err_task is not None:
            self._err_task.cancel()
        if self._proc is not None:
            await _reap(self._proc)
