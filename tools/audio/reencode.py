#!/usr/bin/env python3
"""Re-encode the shipped MP3s from the kept PCM, without paying fal again.

Every knob worth turning after the fact — bitrate, loudness target, how much
dead tail gets trimmed — lives in the encode step, not the generation step. So
this exists to make changing one of them cost nothing.

    /usr/bin/python3 tools/audio/reencode.py
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import music  # noqa: E402


def main() -> int:
    for name, spec in music.TRACKS.items():
        raw = music.RAW / f"{name}.wav"
        if not raw.exists():
            print(f"  {name:10s} no raw file, skipping")
            continue
        dest = music.OUT / f"{name}.mp3"
        music.encode(raw, dest, spec["seconds"])
        print(f"  {name:10s} -> {dest.stat().st_size // 1024:5d} KB")
    music.write_manifest()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
