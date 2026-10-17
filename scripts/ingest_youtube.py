"""Discover official channel uploads and checkpoint public captions for GovAI.

Run from the repository root: python -m scripts.ingest_youtube
Only the CLI needs third-party packages; clients can be injected in tests.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import date, datetime, timezone
from email.utils import parsedate_to_datetime
import json
import logging
import math
import os
from pathlib import Path
import re
import tempfile
import time

CHANNELS = {
    "City of Santa Monica / CityTV": "UC4V0jOEL4JMCcElkGA7AJpA",
    "Santa Monica Police Department": "UCyq1UTKGqCmUtsJi984yF5A",
}
DEFAULT_DIR = Path(__file__).resolve().parents[1] / "data" / "youtube"
DEFAULT_SOURCES = Path(__file__).resolve().parents[1] / "config" / "youtube_sources.json"
LOG = logging.getLogger(__name__)


def load_sources(path=DEFAULT_SOURCES, regions=None):
    sources = json.loads(Path(path).read_text(encoding="utf-8"))
    selected = {}
    metadata = {}
    for source in sources:
        if not source.get("enabled", True) or (regions and source["region"] not in regions):
            continue
        ref = source["channel_ref"]
        if not re.fullmatch(r"UC[A-Za-z0-9_-]{22}|@[A-Za-z0-9_.-]+|user:[A-Za-z0-9_.-]+", ref):
            raise ValueError(f"Invalid channel reference: {ref}")
        if source["name"] in selected or ref in metadata:
            raise ValueError("Duplicate configured channel")
        selected[source["name"]] = ref
        metadata[ref] = {"region": source["region"], "jurisdiction": source["jurisdiction"],
                         "source_reference_url": source["official_source_url"]}
    if not selected:
        raise ValueError("No enabled channels match the selected regions")
    return selected, metadata


def calendar_year_ago(today):
    try:
        return today.replace(year=today.year - 1)
    except ValueError:  # February 29 -> February 28
        return today.replace(year=today.year - 1, day=28)


def parse_date(value):
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise argparse.ArgumentTypeError("Use a publication date in YYYY-MM-DD format") from None


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


class TranscriptRateLimit(RuntimeError):
    def __init__(self, retry_after=0):
        super().__init__("YouTube caption requests are rate limited")
        self.retry_after = retry_after


def retry_after_seconds(value, clock=time.time):
    """Honor HTTP Retry-After in either seconds or HTTP-date format."""
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        try:
            seconds = parsedate_to_datetime(value).timestamp() - clock()
        except (TypeError, ValueError, OverflowError):
            return 0
    return max(0, seconds) if math.isfinite(seconds) else 0


def paced_request(control, request, *args, **kwargs):
    """Wrap Session.request without retrying a rejected request in a tight loop."""
    kwargs.setdefault("timeout", 30)
    control.before_request()
    response = request(*args, **kwargs)
    if response.status_code == 429:
        delay = retry_after_seconds(response.headers.get("Retry-After"), control.clock)
        response.close()
        raise TranscriptRateLimit(delay)
    return response


class TranscriptRequestControl:
    """Pace every caption HTTP request and persist a circuit breaker across runs."""
    def __init__(self, data_dir, delay=10, cooldown=1800, clock=time.time, sleep=time.sleep):
        if not math.isfinite(delay) or delay < 0:
            raise ValueError("Request delay must be finite and nonnegative")
        if not math.isfinite(cooldown) or cooldown <= 0:
            raise ValueError("Block cooldown must be finite and positive")
        self.path = Path(data_dir) / "request-state.json"
        self.delay, self.cooldown, self.clock, self.sleep = delay, cooldown, clock, sleep
        self.state = {"next_request_at": 0, "cooldown_until": 0, "blocks": 0}
        if self.path.exists():
            # Fail closed on corrupt state; do not silently drop an active cooldown.
            self.state.update(json.loads(self.path.read_text(encoding="utf-8")))
        if (any(not isinstance(self.state[k], (int, float)) or
                not math.isfinite(self.state[k]) or self.state[k] < 0
                for k in ("next_request_at", "cooldown_until")) or
                type(self.state["blocks"]) is not int or self.state["blocks"] < 0):
            raise ValueError("Invalid persisted caption request state; refusing requests")

    def save(self):
        atomic_write(self.path, json.dumps(self.state) + "\n")

    def remaining(self):
        return max(0, self.state["cooldown_until"] - self.clock())

    def before_request(self):
        if self.remaining():
            raise TranscriptRateLimit(self.remaining())
        # Small bounded sleeps keep Ctrl+C responsive, even with a long delay.
        while self.clock() < self.state["next_request_at"]:
            self.sleep(min(1, self.state["next_request_at"] - self.clock()))
        self.state["next_request_at"] = self.clock() + self.delay
        self.save()

    def block(self, retry_after=0):
        if not self.remaining():
            count = self.state["blocks"]
            duration = max(min(self.cooldown * 2 ** min(count, 10), 86400),
                           self.cooldown, retry_after)
            self.state.update(blocks=count + 1, cooldown_until=self.clock() + duration)
            self.save()
        return self.state["cooldown_until"]

    def completed(self):
        # Reset escalating cooldowns only after an uninterrupted successful run.
        self.state.update(blocks=0, cooldown_until=0)
        self.save()


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
            **{k: record[k] for k in ("region", "jurisdiction", "source_reference_url") if k in record},
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
                 languages=("en",), refresh_transcripts=False, request_control=None,
                 published_since=None, published_until=None, metadata_only=False,
                 source_metadata=None):
        self.youtube = youtube
        self.transcripts = transcripts
        self.data_dir = Path(data_dir)
        self.languages = tuple(languages)
        self.refresh_transcripts = refresh_transcripts
        self.channels = {}
        self.request_control = request_control
        self.blocked = False
        self.published_since, self.published_until = published_since, published_until
        self.metadata_only = metadata_only
        self.source_metadata = source_metadata or {}

    def get_upload_playlist(self, channel_id):
        # Resolve official handles/usernames through Data API v3, never search.list.
        selector = ({"forHandle": channel_id} if channel_id.startswith("@") else
                    {"forUsername": channel_id[5:]} if channel_id.startswith("user:") else
                    {"id": channel_id})
        response = self.youtube.channels().list(
            part="snippet,contentDetails", **selector).execute(num_retries=3)
        items = response.get("items", [])
        if not items:
            raise ValueError(f"Channel not found: {channel_id}")
        channel = items[0]
        self.channels[channel_id] = channel
        actual_id = channel["id"]
        if not re.fullmatch(r"UC[A-Za-z0-9_-]{22}", actual_id):
            raise ValueError("Invalid channel ID in API response")
        atomic_write(self.data_dir / "channels" / f"{actual_id}.json",
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
                    "channel_id": self.channels[channel_id]["id"],
                    "channel_name": self.channels[channel_id]["snippet"]["title"],
                    "title": snippet.get("title", fallback.get("title", "Unavailable video")),
                    "description": snippet.get("description", fallback.get("description", "")),
                    "published_at": snippet.get("publishedAt") or item.get(
                        "contentDetails", {}).get("videoPublishedAt"),
                    "video_available": video_id in details,
                    **self.source_metadata.get(channel_id, {}),
                }
            token = page.get("nextPageToken")
            if not token:
                break

    def get_transcript(self, video_id):
        result = {"transcript_available": False, "transcript_text": "",
                  "transcript_segments": [], "transcript_language": None,
                  "transcript_is_generated": None, "transcript_checked_at": now(),
                  "transcript_status": "no_captions", "transcript_error": None,
                  "transcript_retry_after": None}
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
                "TranscriptRateLimit": "blocked",
            }.get(name, "error")
            result["transcript_error"] = name
            if result["transcript_status"] == "blocked":
                self.blocked = True
                if self.request_control:
                    until = self.request_control.block(getattr(exc, "retry_after", 0))
                    result["transcript_retry_after"] = datetime.fromtimestamp(until, timezone.utc).isoformat()
            LOG.warning("Transcript %s: %s", video_id, name)
        return result

    def record_path(self, video_id):
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            raise ValueError("Invalid YouTube video ID")
        return self.data_dir / "records" / f"{video_id}.json"

    def ingest_channel(self, channel_name, channel_id, max_videos=None):
        counts = {"videos": 0, "transcripts": 0, "reused": 0,
                  "outside_date_range": 0, "undated": 0}
        for metadata in self.get_all_channel_videos(channel_id):
            path = self.record_path(metadata["video_id"])
            previous = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
            if not metadata["video_available"] and previous:
                # Preserve last known metadata if the video becomes private/deleted.
                for field in ("title", "description", "published_at"):
                    metadata[field] = previous.get(field, metadata[field])
            published = metadata.get("published_at")
            try:
                published_date = date.fromisoformat(published[:10]) if published else None
            except (ValueError, TypeError):
                published_date = None
            dated_filter = self.published_since is not None or self.published_until is not None
            if published_date and ((self.published_since and published_date < self.published_since) or
                                   (self.published_until and published_date > self.published_until)):
                counts["outside_date_range"] += 1
                continue
            undated = dated_filter and published_date is None
            if undated:
                counts["undated"] += 1
            record = {**previous, **metadata, "configured_channel_name": channel_name}
            if self.metadata_only or undated:
                # Discovery can run during a caption cooldown; metadata isn't a transcript.
                if "transcript_available" not in record:
                    record.update(transcript_available=False, transcript_text="",
                                  transcript_segments=[], transcript_language=None,
                                  transcript_is_generated=None, transcript_checked_at=None,
                                  transcript_error=None,
                                  transcript_status="pending" if metadata["video_available"] else "unavailable")
            elif previous.get("transcript_available") and not self.refresh_transcripts:
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
            LOG.info("%s: %d videos saved, %d transcripts (%d reused)",
                     channel_name, counts["videos"], counts["transcripts"], counts["reused"])
            if self.blocked:
                # Checkpoint the blocked record, then stop across ALL channels.
                break
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
        self.blocked = bool(not self.metadata_only and self.request_control and self.request_control.remaining())
        try:
            if self.blocked:
                LOG.warning("Caption cooldown active; no requests made. Retry after %s",
                            datetime.fromtimestamp(self.request_control.state["cooldown_until"], timezone.utc).isoformat())
                return {"channels": {}, "failed_channels": [], "paused": True,
                        "retry_after": datetime.fromtimestamp(
                            self.request_control.state["cooldown_until"], timezone.utc).isoformat()}
            for name, channel_id in (CHANNELS if channels is None else channels).items():
                try:
                    summary[channel_id] = self.ingest_channel(name, channel_id, max_videos)
                except Exception as exc:
                    failures.append(channel_id)
                    LOG.error("Channel %s failed: %s (saved records retained)", channel_id,
                              type(exc).__name__)
                if self.blocked:
                    LOG.warning("Stopping after YouTube blocked caption requests; saved transcripts retained")
                    break
        finally:
            self.export()
        if self.request_control and not self.blocked and not failures and not self.metadata_only:
            self.request_control.completed()
        return {"channels": summary, "failed_channels": failures, "paused": self.blocked,
                "metadata_only": self.metadata_only,
                "published_since": self.published_since.isoformat() if self.published_since else None,
                "published_until": self.published_until.isoformat() if self.published_until else None,
                "retry_after": datetime.fromtimestamp(
                    self.request_control.state["cooldown_until"], timezone.utc).isoformat()
                if self.blocked and self.request_control else None}


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
    parser.add_argument("--channel-id", action="append", help="Channel ID, @handle, or user:legacyname")
    parser.add_argument("--regional", action="store_true", help="Use the official regional source registry")
    parser.add_argument("--region", action="append", choices=["los-angeles", "orange-county", "san-diego"])
    parser.add_argument("--sources-file", type=Path, default=DEFAULT_SOURCES)
    parser.add_argument("--since", type=parse_date, help="Inclusive publication date YYYY-MM-DD")
    parser.add_argument("--until", type=parse_date, help="Inclusive publication date YYYY-MM-DD")
    parser.add_argument("--past-year", action="store_true", help="One calendar year through today")
    parser.add_argument("--metadata-only", action="store_true", help="Catalog videos without caption requests")
    parser.add_argument("--languages", default="en", help="Comma-separated preference order")
    parser.add_argument("--refresh-transcripts", action="store_true")
    parser.add_argument("--request-delay", type=float,
                        default=os.environ.get("YOUTUBE_REQUEST_DELAY_SECONDS", "10"),
                        help="Minimum seconds between caption HTTP requests (default 10)")
    parser.add_argument("--block-cooldown", type=float,
                        default=os.environ.get("YOUTUBE_BLOCK_COOLDOWN_SECONDS", "1800"),
                        help="Initial cooldown after a block; repeated blocks double it (default 1800)")
    parser.add_argument("--max-videos", type=int, help="Optional per-channel smoke-test limit; default: all")
    args = parser.parse_args()
    if args.past_year:
        if args.since or args.until:
            parser.error("Use --past-year or explicit --since/--until dates")
        args.until = date.today()
        args.since = calendar_year_ago(args.until)
    if args.since and args.until and args.since > args.until:
        parser.error("--since must not be later than --until")
    if args.max_videos is not None and args.max_videos < 1:
        parser.error("--max-videos must be positive")
    if not math.isfinite(args.request_delay) or args.request_delay < 1:
        parser.error("--request-delay must be at least 1 second")
    if not math.isfinite(args.block_cooldown) or args.block_cooldown < 1:
        parser.error("--block-cooldown must be at least 1 second")
    key = os.environ.get("YOUTUBE_API_KEY")
    if not key:
        parser.error("Set YOUTUBE_API_KEY in the environment (or use npm run ingest:youtube)")
    from googleapiclient.discovery import build
    from youtube_transcript_api import YouTubeTranscriptApi
    import httplib2
    from requests import Session

    class PacedSession(Session):
        def request(self, *a, **kw):
            return paced_request(control, super().request, *a, **kw)

    youtube = build("youtube", "v3", developerKey=key, cache_discovery=False,
                    http=httplib2.Http(timeout=30))
    source_metadata = {}
    if args.regional or args.region:
        channels, source_metadata = load_sources(args.sources_file, args.region)
    else:
        channels = dict(CHANNELS)
    if args.channel_id:
        configured = {ref: name for name, ref in channels.items()}
        channels = {configured.get(ref, ref): ref for ref in args.channel_id}
    with ingestion_lock(args.data_dir):
        # Read persistent state under the same single-writer lock as video files.
        control = TranscriptRequestControl(args.data_dir, args.request_delay, args.block_cooldown)
        importer = YouTubeIngestor(youtube, YouTubeTranscriptApi(http_client=PacedSession()),
                                  args.data_dir, tuple(x.strip() for x in args.languages.split(",") if x.strip()),
                                  args.refresh_transcripts, request_control=control,
                                  published_since=args.since, published_until=args.until,
                                  metadata_only=args.metadata_only, source_metadata=source_metadata)
        try:
            result = importer.ingest_all_channels(channels, args.max_videos)
        except KeyboardInterrupt:
            LOG.warning("Interrupted; saved records exported and lock released")
            return 130
    print(json.dumps(result, indent=2))
    return 2 if result["paused"] else 1 if result["failed_channels"] else 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    raise SystemExit(main())
