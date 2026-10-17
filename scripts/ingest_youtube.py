"""Discover official channel uploads and checkpoint public captions for GovAI.

Run from the repository root: python -m scripts.ingest_youtube
Only the CLI needs third-party packages; clients can be injected in tests.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import logging
import math
import os
from pathlib import Path
import re
import tempfile

CHANNELS = {
    "City of Santa Monica / CityTV": "UC4V0jOEL4JMCcElkGA7AJpA",
    "Santa Monica Police Department": "UCyq1UTKGqCmUtsJi984yF5A",
}
DEFAULT_DIR = Path(__file__).resolve().parents[1] / "data" / "youtube"
LOG = logging.getLogger(__name__)


def now():
    return datetime.now(timezone.utc).isoformat()


def normalize(text):
    return " ".join(text.split())


def atomic_write(path, text):
    """Readers see either the previous complete file or the next complete file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            if isinstance(text, str):
                f.write(text)
            else:
                f.writelines(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def chunk_transcript(record, max_words=250, overlap_words=35):
    """Word-budget windows with overlap, preserving exact enclosing cue times.

    Prefer caption boundaries; exceptionally long cues are split into word groups
    sharing their original time range (no invented word-level timestamps).
    """
    if max_words < 1 or not 0 <= overlap_words < max_words:
        raise ValueError("Require 0 <= overlap_words < max_words")
    units = []
    for segment in record.get("transcript_segments", []):
        words = segment["text"].split()
        for offset in range(0, len(words), max_words):
            units.append({"words": words[offset:offset + max_words],
                          "start": segment["start"],
                          "end": segment["start"] + segment["duration"]})
    chunks = []
    i = 0
    while i < len(units):
        j, count = i, 0
        while j < len(units) and count + len(units[j]["words"]) <= max_words:
            count += len(units[j]["words"])
            j += 1
        window = units[i:j]
        start = min(u["start"] for u in window)
        end = max(u["end"] for u in window)
        chunks.append({
            "chunk_id": f"{record['video_id']}:{len(chunks)}",
            **{k: record[k] for k in ("video_id", "youtube_url", "channel_id",
                                      "channel_name", "title", "published_at")},
            "transcript_language": record.get("transcript_language"),
            "transcript_is_generated": record.get("transcript_is_generated"),
            "start": start, "end": end,
            "url": f"{record['youtube_url']}&t={math.floor(start)}s",
            "text": " ".join(w for u in window for w in u["words"]),
        })
        if j == len(units):
            break
        # Retain complete trailing cues within the overlap budget; always advance.
        k, overlap = j, 0
        while k > i + 1 and overlap + len(units[k - 1]["words"]) <= overlap_words:
            k -= 1
            overlap += len(units[k]["words"])
        i = k
    return chunks


class YouTubeIngestor:
    def __init__(self, youtube, transcripts, data_dir=DEFAULT_DIR,
                 languages=("en",), refresh_transcripts=False):
        self.youtube = youtube
        self.transcripts = transcripts
        self.data_dir = Path(data_dir)
        self.languages = tuple(languages)
        self.refresh_transcripts = refresh_transcripts
        self.channels = {}

    def get_upload_playlist(self, channel_id):
        response = self.youtube.channels().list(
            part="snippet,contentDetails", id=channel_id).execute(num_retries=3)
        items = response.get("items", [])
        if not items:
            raise ValueError(f"Channel not found: {channel_id}")
        channel = items[0]
        self.channels[channel_id] = channel
        atomic_write(self.data_dir / "channels" / f"{channel_id}.json",
                     json.dumps(channel, ensure_ascii=False, indent=2) + "\n")
        return channel["contentDetails"]["relatedPlaylists"]["uploads"]

    def get_all_channel_videos(self, channel_id):
        """Paginate uploads, then hydrate metadata in batches of at most 50."""
        playlist = self.get_upload_playlist(channel_id)
        token = None
        seen = set()
        while True:
            args = dict(part="snippet,contentDetails", playlistId=playlist, maxResults=50)
            if token:
                args["pageToken"] = token
            page = self.youtube.playlistItems().list(**args).execute(num_retries=3)
            entries = {}
            for item in page.get("items", []):
                video_id = item.get("contentDetails", {}).get("videoId")
                if video_id and video_id not in seen:
                    entries[video_id] = item
                    seen.add(video_id)
            details = {}
            if entries:
                response = self.youtube.videos().list(
                    part="snippet,status", id=",".join(entries), maxResults=50
                ).execute(num_retries=3)
                details = {v["id"]: v for v in response.get("items", [])}
            for video_id, item in entries.items():
                snippet = details.get(video_id, {}).get("snippet", {})
                fallback = item.get("snippet", {})
                yield {
                    "video_id": video_id,
                    "youtube_url": f"https://www.youtube.com/watch?v={video_id}",
                    "channel_id": channel_id,
                    "channel_name": self.channels[channel_id]["snippet"]["title"],
                    "title": snippet.get("title", fallback.get("title", "Unavailable video")),
                    "description": snippet.get("description", fallback.get("description", "")),
                    "published_at": snippet.get("publishedAt") or item.get(
                        "contentDetails", {}).get("videoPublishedAt"),
                    "video_available": video_id in details,
                }
            token = page.get("nextPageToken")
            if not token:
                break

    def get_transcript(self, video_id):
        result = {"transcript_available": False, "transcript_text": "",
                  "transcript_segments": [], "transcript_language": None,
                  "transcript_is_generated": None, "transcript_checked_at": now(),
                  "transcript_status": "no_captions", "transcript_error": None}
        try:
            tracks = list(self.transcripts.list(video_id))
            # Prefer requested languages, manual before auto within each language.
            # Fall back to another original language rather than discard captions.
            tracks.sort(key=lambda t: (
                self.languages.index(t.language_code) if t.language_code in self.languages
                else len(self.languages), t.is_generated))
            if not tracks:
                return result
            track = tracks[0]
            segments = []
            for cue in track.fetch():
                text = normalize(cue.text)
                start, duration = float(cue.start), float(cue.duration)
                if not math.isfinite(start) or not math.isfinite(duration) or start < 0 or duration < 0:
                    raise ValueError("Invalid caption timestamp")
                if text:
                    segments.append({"text": text, "start": start, "duration": duration})
            segments.sort(key=lambda s: s["start"])
            result.update(transcript_available=bool(segments),
                          transcript_segments=segments,
                          transcript_text=normalize(" ".join(s["text"] for s in segments)),
                          transcript_language=track.language_code,
                          transcript_is_generated=track.is_generated,
                          transcript_status="available" if segments else "empty")
        except Exception as exc:
            # Third-party exceptions can embed request URLs; don't log API keys or
            # raw responses. Keep a machine-readable reason for every failed video.
            name = type(exc).__name__
            result["transcript_status"] = {
                "TranscriptsDisabled": "disabled", "NoTranscriptFound": "no_captions",
                "VideoUnavailable": "unavailable", "VideoUnplayable": "unavailable",
                "AgeRestricted": "unavailable", "RequestBlocked": "blocked",
                "IpBlocked": "blocked",
            }.get(name, "error")
            result["transcript_error"] = name
            LOG.warning("Transcript %s: %s", video_id, name)
        return result

    def record_path(self, video_id):
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            raise ValueError("Invalid YouTube video ID")
        return self.data_dir / "records" / f"{video_id}.json"

    def ingest_channel(self, channel_name, channel_id, max_videos=None):
        counts = {"videos": 0, "transcripts": 0, "reused": 0}
        for metadata in self.get_all_channel_videos(channel_id):
            path = self.record_path(metadata["video_id"])
            previous = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
            if not metadata["video_available"] and previous:
                # Preserve last known metadata if the video becomes private/deleted.
                for field in ("title", "description", "published_at"):
                    metadata[field] = previous.get(field, metadata[field])
            record = {**previous, **metadata, "configured_channel_name": channel_name}
            if previous.get("transcript_available") and not self.refresh_transcripts:
                counts["reused"] += 1
            elif metadata["video_available"]:
                attempt = self.get_transcript(metadata["video_id"])
                if previous.get("transcript_available") and not attempt["transcript_available"]:
                    # A temporary fetch failure must not erase a usable transcript.
                    record["last_refresh_status"] = attempt["transcript_status"]
                    record["last_refresh_error"] = attempt["transcript_error"]
                    record["last_refresh_at"] = attempt["transcript_checked_at"]
                else:
                    record.update(attempt)
                    for field in ("last_refresh_status", "last_refresh_error", "last_refresh_at"):
                        record.pop(field, None)
            else:
                record.update(transcript_available=False, transcript_text="",
                              transcript_segments=[], transcript_status="unavailable",
                              transcript_language=None, transcript_is_generated=None,
                              transcript_error=None, transcript_checked_at=now())
            if record != previous:
                record["updated_at"] = now()
                atomic_write(path, json.dumps(record, ensure_ascii=False) + "\n")
            counts["videos"] += 1
            counts["transcripts"] += int(record["transcript_available"])
            if max_videos is not None and counts["videos"] >= max_videos:
                break
        return counts

    def export(self):
        """Rebuild deduplicated JSONL snapshots from durable per-video checkpoints."""
        paths = sorted((self.data_dir / "records").glob("*.json"))
        def records():
            for path in paths:
                yield json.loads(path.read_text(encoding="utf-8"))
        # Stream one video at a time, rather than holding whole-channel captions
        # and serialized JSONL copies in memory during multi-year backfills.
        atomic_write(self.data_dir / "videos.jsonl", (
            json.dumps(r, ensure_ascii=False) + "\n" for r in records()))
        atomic_write(self.data_dir / "chunks.jsonl", (
            json.dumps(c, ensure_ascii=False) + "\n"
            for r in records() if r["transcript_available"] for c in chunk_transcript(r)))

    def ingest_all_channels(self, channels=None, max_videos=None):
        summary, failures = {}, []
        try:
            for name, channel_id in (CHANNELS if channels is None else channels).items():
                try:
                    summary[channel_id] = self.ingest_channel(name, channel_id, max_videos)
                except Exception as exc:
                    failures.append(channel_id)
                    LOG.error("Channel %s failed: %s (saved records retained)", channel_id,
                              type(exc).__name__)
        finally:
            self.export()
        return {"channels": summary, "failed_channels": failures}


@contextmanager
def ingestion_lock(data_dir):
    data_dir.mkdir(parents=True, exist_ok=True)
    lock = data_dir / ".ingest.lock"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise RuntimeError(f"Importer already running; if interrupted, remove {lock} after verifying it stopped") from None
    try:
        with os.fdopen(fd, "w") as f:
            f.write(str(os.getpid()))
        yield
    finally:
        lock.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DIR)
    parser.add_argument("--channel-id", choices=CHANNELS.values(), action="append")
    parser.add_argument("--languages", default="en", help="Comma-separated preference order")
    parser.add_argument("--refresh-transcripts", action="store_true")
    parser.add_argument("--max-videos", type=int, help="Optional per-channel smoke-test limit; default: all")
    args = parser.parse_args()
    if args.max_videos is not None and args.max_videos < 1:
        parser.error("--max-videos must be positive")
    key = os.environ.get("YOUTUBE_API_KEY")
    if not key:
        parser.error("Set YOUTUBE_API_KEY in the environment (or use npm run ingest:youtube)")
    from googleapiclient.discovery import build
    from youtube_transcript_api import YouTubeTranscriptApi
    import httplib2
    from requests import Session

    class TimeoutSession(Session):
        def request(self, *a, **kw):
            kw.setdefault("timeout", 30)
            return super().request(*a, **kw)

    youtube = build("youtube", "v3", developerKey=key, cache_discovery=False,
                    http=httplib2.Http(timeout=30))
    importer = YouTubeIngestor(youtube, YouTubeTranscriptApi(http_client=TimeoutSession()),
                              args.data_dir, tuple(x.strip() for x in args.languages.split(",") if x.strip()),
                              args.refresh_transcripts)
    channels = {name: cid for name, cid in CHANNELS.items()
                if not args.channel_id or cid in args.channel_id}
    with ingestion_lock(args.data_dir):
        result = importer.ingest_all_channels(channels, args.max_videos)
    print(json.dumps(result, indent=2))
    return 1 if result["failed_channels"] else 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    raise SystemExit(main())
