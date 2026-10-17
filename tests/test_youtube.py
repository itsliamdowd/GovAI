import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

from scripts.ingest_youtube import (YouTubeIngestor, chunk_transcript, ingestion_lock,
                                    TranscriptRequestControl, TranscriptRateLimit,
                                    paced_request, retry_after_seconds)

FIRST, SECOND, THIRD = "abcdefghijk", "lmnopqrstuv", "wxyz1234567"
CHANNEL = "UC4V0jOEL4JMCcElkGA7AJpA"


class Request:
    def __init__(self, value):
        self.value = value

    def execute(self, **kwargs):
        if isinstance(self.value, Exception):
            raise self.value
        return self.value


class FakeYouTube:
    def __init__(self):
        self.calls = []
        self.title = "Beach safety"

    def channels(self):
        return SimpleNamespace(list=lambda **kw: self.channel(kw))

    def channel(self, kw):
        self.calls.append(("channels", kw))
        if kw["id"] == "bad":
            return Request(RuntimeError("quota exceeded"))
        return Request({"items": [{"id": CHANNEL, "snippet": {"title": "Official CityTV"},
                                   "contentDetails": {"relatedPlaylists": {"uploads": "uploads-id"}}}]})

    def playlistItems(self):
        return SimpleNamespace(list=lambda **kw: self.playlist(kw))

    def playlist(self, kw):
        self.calls.append(("playlistItems", kw))
        ids = [SECOND, THIRD] if kw.get("pageToken") else [FIRST]
        response = {"items": [{"contentDetails": {"videoId": v},
                               "snippet": {"title": "Private video"}} for v in ids]}
        if not kw.get("pageToken"):
            response["nextPageToken"] = "page-two"
        return Request(response)

    def videos(self):
        return SimpleNamespace(list=lambda **kw: self.video(kw))

    def video(self, kw):
        self.calls.append(("videos", kw))
        return Request({"items": [{"id": v, "snippet": {
            "title": self.title, "description": "Official description", "publishedAt": "2026-10-01T00:00:00Z"}}
                                 for v in kw["id"].split(",") if v != SECOND]})


def track(language="en", generated=False, text="Hello   beach\nsafety"):
    return SimpleNamespace(language_code=language, is_generated=generated,
                           fetch=lambda: [SimpleNamespace(text=text, start=123.4, duration=4.2)])


class FakeTranscripts:
    def __init__(self):
        self.calls = []
        self.fail = True

    def list(self, video_id):
        self.calls.append(video_id)
        if self.fail and video_id == FIRST:
            raise type("TranscriptsDisabled", (Exception,), {})("disabled")
        return [track(generated=True)]


class IngestionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.youtube, self.transcripts = FakeYouTube(), FakeTranscripts()
        self.ingestor = YouTubeIngestor(self.youtube, self.transcripts, self.tmp.name)

    def read(self, video_id):
        return json.loads(self.ingestor.record_path(video_id).read_text())

    def test_paginated_discovery_failures_and_resume(self):
        summary = self.ingestor.ingest_all_channels({"CityTV": CHANNEL})
        self.assertFalse(summary["failed_channels"])
        self.assertEqual(summary["channels"][CHANNEL]["videos"], 3)
        self.assertEqual(self.read(FIRST)["transcript_status"], "disabled")
        self.assertEqual(self.read(SECOND)["transcript_status"], "unavailable")
        auto = self.read(THIRD)
        self.assertTrue(auto["transcript_is_generated"])
        self.assertEqual(auto["transcript_segments"], [{"text": "Hello beach safety", "start": 123.4, "duration": 4.2}])
        self.assertEqual(auto["transcript_text"], "Hello beach safety")
        self.assertEqual(auto["published_at"], "2026-10-01T00:00:00Z")
        self.assertNotIn(SECOND, self.transcripts.calls)
        # Retry the failed caption, reuse the successful one, update all metadata.
        self.transcripts.fail = False
        self.transcripts.calls.clear()
        self.youtube.title = "Updated beach safety"
        self.ingestor.ingest_all_channels({"CityTV": CHANNEL})
        self.assertEqual(self.transcripts.calls, [FIRST])
        self.assertTrue(self.read(FIRST)["transcript_available"])
        self.assertEqual(self.read(THIRD)["title"], self.youtube.title)
        before = self.ingestor.record_path(THIRD).read_bytes()
        self.ingestor.ingest_all_channels({"CityTV": CHANNEL})
        self.assertEqual(self.ingestor.record_path(THIRD).read_bytes(), before)
        records = [json.loads(s) for s in (Path(self.tmp.name) / "videos.jsonl").read_text().splitlines()]
        self.assertEqual(len({r["video_id"] for r in records}), 3)
        chunks = [json.loads(s) for s in (Path(self.tmp.name) / "chunks.jsonl").read_text().splitlines()]
        self.assertEqual(len(chunks), 2)
        self.assertTrue(all(c["title"] == self.youtube.title for c in chunks))
        self.assertTrue(any(kind == "playlistItems" and args.get("pageToken") == "page-two"
                            for kind, args in self.youtube.calls))
        self.assertTrue(all(args["playlistId"] == "uploads-id" for kind, args in self.youtube.calls if kind == "playlistItems"))

    def test_channel_failure_does_not_stop_next_channel(self):
        result = self.ingestor.ingest_all_channels({"broken": "bad", "CityTV": CHANNEL})
        self.assertEqual(result["failed_channels"], ["bad"])
        self.assertEqual(result["channels"][CHANNEL]["videos"], 3)

    def test_transcript_selection_and_failure_categories(self):
        self.ingestor.transcripts = SimpleNamespace(list=lambda _: [track("es"), track(generated=True), track()])
        rec = self.ingestor.get_transcript(FIRST)
        self.assertFalse(rec["transcript_is_generated"])
        self.assertEqual(rec["transcript_language"], "en")
        self.ingestor.transcripts = SimpleNamespace(list=lambda _: [track("es", True)])
        self.assertEqual(self.ingestor.get_transcript(FIRST)["transcript_language"], "es")
        for exception, status in [("NoTranscriptFound", "no_captions"), ("VideoUnavailable", "unavailable"),
                                  ("RequestBlocked", "blocked"), ("RuntimeError", "error")]:
            def fail(_):
                raise type(exception, (Exception,), {})("request failed")
            self.ingestor.transcripts = SimpleNamespace(list=fail)
            self.assertEqual(self.ingestor.get_transcript(FIRST)["transcript_status"], status)
        self.ingestor.transcripts = SimpleNamespace(list=lambda _: [])
        self.assertFalse(self.ingestor.get_transcript(FIRST)["transcript_available"])
        self.ingestor.transcripts = SimpleNamespace(list=lambda _: [track(text="  ")])
        self.assertEqual(self.ingestor.get_transcript(FIRST)["transcript_status"], "empty")

    def test_failed_refresh_keeps_successful_transcript(self):
        self.transcripts.fail = False
        self.ingestor.ingest_all_channels({"CityTV": CHANNEL})
        self.transcripts.fail = True
        self.ingestor.refresh_transcripts = True
        self.ingestor.ingest_all_channels({"CityTV": CHANNEL})
        self.assertTrue(self.read(FIRST)["transcript_available"])
        self.assertEqual(self.read(FIRST)["last_refresh_status"], "disabled")

    def test_chunks_have_overlap_bounded_size_and_source_times(self):
        record = dict(video_id=FIRST, youtube_url=f"https://www.youtube.com/watch?v={FIRST}",
                      channel_id=CHANNEL, channel_name="CityTV", title="Meeting", published_at=None,
                      transcript_segments=[{"text": f"cue{i} " * 10, "start": i * 0.5, "duration": 0.75}
                                           for i in range(50)])
        chunks = chunk_transcript(record, max_words=100, overlap_words=20)
        self.assertTrue(all(len(c["text"].split()) <= 100 for c in chunks))
        self.assertEqual(chunks[0]["start"], 0)
        self.assertEqual(chunks[0]["end"], 5.25)
        self.assertIn("cue8", chunks[0]["text"])
        self.assertIn("cue8", chunks[1]["text"])
        self.assertEqual(chunks[-1]["end"], 25.25)
        record["transcript_segments"] = [{"text": "word " * 700, "start": 1.2, "duration": 10.3}]
        chunks = chunk_transcript(record)
        self.assertEqual(len(chunks), 3)
        self.assertEqual(sum(len(c["text"].split()) for c in chunks), 700)
        self.assertTrue(all(c["start"] == 1.2 and c["end"] == 11.5 for c in chunks))

    def test_lock_and_path_safety(self):
        with ingestion_lock(Path(self.tmp.name)):
            with self.assertRaises(RuntimeError):
                with ingestion_lock(Path(self.tmp.name)):
                    pass
        self.assertFalse((Path(self.tmp.name) / ".ingest.lock").exists())
        with self.assertRaises(ValueError):
            self.ingestor.record_path("../../secrets")

    def test_block_stops_all_channels_and_persists_across_restart(self):
        clock = [1000.0]
        control = TranscriptRequestControl(self.tmp.name, cooldown=60, clock=lambda: clock[0])
        self.ingestor.request_control = control
        calls = []
        def blocked(video_id):
            calls.append(video_id)
            raise type("IpBlocked", (Exception,), {})()
        self.ingestor.transcripts = SimpleNamespace(list=blocked)
        result = self.ingestor.ingest_all_channels({"CityTV": CHANNEL, "Police": "other"})
        self.assertTrue(result["paused"])
        self.assertEqual(calls, [FIRST])
        self.assertEqual(len(self.youtube.calls), 3)  # one channel, one page, metadata
        self.assertEqual(self.read(FIRST)["transcript_status"], "blocked")
        self.assertTrue((Path(self.tmp.name) / "videos.jsonl").exists())
        # New process: persisted cooldown prevents all API calls.
        self.youtube.calls.clear()
        resumed = YouTubeIngestor(self.youtube, self.ingestor.transcripts, self.tmp.name,
                                 request_control=TranscriptRequestControl(
                                     self.tmp.name, cooldown=60, clock=lambda: clock[0]))
        self.assertTrue(resumed.ingest_all_channels({"CityTV": CHANNEL})["paused"])
        self.assertEqual(self.youtube.calls, [])
        self.assertEqual(calls, [FIRST])
        # After cooldown: a new block doubles the delay rather than hammering YouTube.
        clock[0] = 1061
        resumed.ingest_all_channels({"CityTV": CHANNEL})
        self.assertEqual(resumed.request_control.remaining(), 120)
        clock[0] = 1182
        resumed.transcripts = SimpleNamespace(list=lambda _: [track()])
        self.assertFalse(resumed.ingest_all_channels({"CityTV": CHANNEL})["paused"])
        self.assertTrue(self.read(FIRST)["transcript_available"])
        self.assertIsNone(self.read(FIRST)["transcript_retry_after"])
        self.assertEqual(resumed.request_control.state["blocks"], 0)

    def test_every_http_request_is_paced_and_retry_after_respected(self):
        clock, sleeps = [1000.0], []
        def sleep(delay):
            sleeps.append(delay)
            clock[0] += delay
        control = TranscriptRequestControl(self.tmp.name, delay=10, cooldown=60,
                                           clock=lambda: clock[0], sleep=sleep)
        calls = []
        def request(*args, **kwargs):
            calls.append((clock[0], kwargs["timeout"]))
            return SimpleNamespace(status_code=200)
        paced_request(control, request, "GET", "test")
        paced_request(control, request, "GET", "test")
        self.assertEqual(calls, [(1000, 30), (1010, 30)])
        self.assertTrue(all(s <= 1 for s in sleeps))
        # Persisted spacing also applies after a restart.
        again = TranscriptRequestControl(self.tmp.name, delay=10,
                                         clock=lambda: clock[0], sleep=sleep)
        again.before_request()
        self.assertEqual(clock[0], 1020)
        closed = []
        response = SimpleNamespace(status_code=429, headers={"Retry-After": "7200"},
                                   close=lambda: closed.append(True))
        with self.assertRaises(TranscriptRateLimit) as exc:
            paced_request(control, lambda *a, **kw: response, "GET", "test")
        control.block(exc.exception.retry_after)
        self.assertEqual(control.remaining(), 7200)
        self.assertEqual(closed, [True])
        with self.assertRaises(TranscriptRateLimit):
            paced_request(control, request, "GET", "test")
        self.assertEqual(len(calls), 2)
        self.assertEqual(retry_after_seconds("Thu, 01 Jan 1970 00:20:00 GMT", lambda: 1000), 200)
        self.assertEqual(retry_after_seconds("nonsense"), 0)
        self.assertEqual(retry_after_seconds("nan"), 0)

    def test_interrupt_exports_checkpoints_and_releases_lock(self):
        def interrupted(_):
            raise KeyboardInterrupt()
        self.ingestor.transcripts = SimpleNamespace(list=interrupted)
        with self.assertRaises(KeyboardInterrupt):
            with ingestion_lock(Path(self.tmp.name)):
                self.ingestor.ingest_all_channels({"CityTV": CHANNEL})
        self.assertTrue((Path(self.tmp.name) / "chunks.jsonl").exists())
        self.assertFalse((Path(self.tmp.name) / ".ingest.lock").exists())


if __name__ == "__main__":
    unittest.main()
