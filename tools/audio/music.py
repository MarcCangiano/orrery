#!/usr/bin/env python3
"""Generate the music beds.

The sound effects are synthesised in the browser and have no assets. Music is
different: a frame drum, a horn and a lyre do not come out of an oscillator
convincingly, so the beds are generated once and shipped as files.

    /usr/bin/python3 tools/audio/music.py            # everything missing
    /usr/bin/python3 tools/audio/music.py --force    # everything, again
    /usr/bin/python3 tools/audio/music.py norse-1    # one track

Tracks land in server/src/main/resources/public/music/ as MP3, and the client
reads the manifest written alongside them. Roughly four cents a track.

The prompts avoid two things on purpose. No percussion transients at the very
start, because a bed that begins on a downbeat makes an audible seam when the
playlist wraps. And no vocals anywhere: a voice in a game bed pulls attention
away from what a player is meant to be listening to, which here is the shove
cue and the countdown.
"""

import json
import pathlib
import subprocess
import sys
import time

import requests

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "server" / "src" / "main" / "resources" / "public" / "music"
RAW = pathlib.Path(__file__).resolve().parent / "raw"
ENV = pathlib.Path.home() / ".openclaw" / "master.env"

# The model returns 44.1k stereo PCM, which is sixteen megabytes for ninety
# seconds and not something to make a player download. 96k stereo is
# indistinguishable for a sustained ambient bed and is a sixteenth of the size.
BITRATE = "96k"
# -23 was broadcast-quiet and the verdict on it was "too subtle". -18 is still
# under the effects rather than over them, but it is music you notice.
LUFS = -18
# The fade in is short and the fade out is long, which is not symmetry for its
# own sake. A long fade in at the start of a session is indistinguishable from
# the music being broken: you press START and nothing appears to happen. A long
# fade out is what makes the wrap into the next track inaudible.
FADE_IN = 0.5
FADE_OUT = 2.5

MODEL = "fal-ai/stable-audio-25/text-to-audio"

# The first pass at these asked for restraint to match the art, and restraint is
# what it got: correct, atmospheric, and too subtle to notice. This is a fight
# over a star between two pantheons, and the music is allowed to say so.
#
# What has NOT changed is the ban on vocals. A voice in a bed pulls attention
# away from what a player needs to be listening to, which here is the shove cue
# and the countdown.
COMMON = (
    "Instrumental only, no vocals, no singing, no choir, no voices. "
    "Driving, dramatic, cinematic, epic. A clear steady tempo around 100 BPM. "
    "Strong rhythm section throughout, powerful percussion. "
    "Starts immediately with full energy, no slow build, no long intro. "
    "Heroic and urgent. Video game battle music. "
)

TRACKS = {
    # The lobby is the first thing anyone hears, and the job it has is to make
    # someone want to press START. It gets a pulse and a build, unlike the
    # first version of it, which was a drone and made the game feel like it had
    # not loaded yet.
    "lobby-1": {
        "seconds": 95,
        "prompt": COMMON + (
            "Epic orchestral pre-battle theme. Low taiko drums on a steady "
            "driving pulse from the first beat. Rising string ostinato, "
            "urgent and repeating. Brass swells building tension. Deep "
            "booming hits every four bars. Anticipation before a fight. "
            "Minor key, powerful, gathering force."
        ),
    },
    # Norse: skin and iron, and now it hits. War drums rather than a heartbeat.
    "norse-1": {
        "seconds": 110,
        "prompt": COMMON + (
            "Nordic war music, hard and driving. Huge frame drums and taiko "
            "hammering a relentless marching rhythm. Aggressive bowed "
            "tagelharpa riff, low and rough and rhythmic. Blaring bronze war "
            "horns. Nyckelharpa playing a fast urgent modal melody. Iron, "
            "snow, a shield wall advancing. Minor and modal, ferocious."
        ),
    },
    "norse-2": {
        "seconds": 110,
        "prompt": COMMON + (
            "Viking battle instrumental, fast and pounding. Thundering war "
            "drums with heavy accents. Driving bowed lyre riff repeating. "
            "Stamping rhythm, bone rattles and clashing metal on the beat. "
            "Low brass stabs. Overtone flute cutting through high above. "
            "Savage, relentless, triumphant."
        ),
    },
    # Greek: bronze and strings rather than skin and iron, and more melodic
    # than Norse. The two have to be told apart in three seconds with a game
    # on top of them, so the difference is instrumentation and shape, not tempo.
    "greek-1": {
        "seconds": 110,
        "prompt": COMMON + (
            "Ancient Greek battle music, grand and heroic. Fast driving "
            "kithara and lyre arpeggios. Soaring aulos double reed melody, "
            "bright and piercing. Bronze cymbals and hand drums on a strong "
            "marching beat. Crashing bronze bowls. Dorian mode, golden, "
            "triumphant, an army of heroes marching out."
        ),
    },
    "greek-2": {
        "seconds": 110,
        "prompt": COMMON + (
            "Epic ancient Greek instrumental, dramatic and urgent. Rapid "
            "plucked kithara ostinato under a wild aulos melody. Driving "
            "frame drums and finger cymbals at speed. Bronze gongs on the "
            "downbeat. Phrygian mode, fierce and bright, gods at war above "
            "a marble city."
        ),
    },
}


def load_key() -> str:
    if not ENV.exists():
        raise SystemExit(f"no env file at {ENV}")
    for line in ENV.read_text().splitlines():
        if line.strip().startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() == "FAL_KEY":
            return v.strip()
    raise SystemExit("no FAL_KEY in the env file")


def submit(payload: dict, headers: dict, label: str) -> dict:
    r = requests.post(f"https://queue.fal.run/{MODEL}", headers=headers,
                      json=payload, timeout=180).json()
    status_url, response_url = r.get("status_url"), r.get("response_url")
    if not status_url:
        raise RuntimeError(f"{label}: fal returned no status_url: {str(r)[:400]}")
    # Two minutes of audio takes a while; give it ten and then give up loudly
    # rather than hanging a build.
    for _ in range(200):
        s = requests.get(status_url, headers=headers, timeout=120).json()
        if s.get("status") == "COMPLETED":
            return requests.get(response_url, headers=headers, timeout=180).json()
        if s.get("status") == "FAILED":
            raise RuntimeError(f"{label}: FAILED {str(s)[:400]}")
        time.sleep(3)
    raise TimeoutError(f"{label}: still queued after ten minutes")


def content_end(src: pathlib.Path, seconds: float) -> float:
    """Where the music actually stops, which is not where the file stops.

    The model is asked for 110 seconds and gives back 110 seconds, but it runs
    out of ideas before then: norse-1 went quiet with twenty seconds left. That
    tail is not silence a listener forgives, it is the bed dropping out in the
    middle of a match. So the last stretch of quiet that runs to the end of the
    file gets cut, and the fade is moved to land on the last real note.

    Only a trailing quiet region counts. These pieces are deliberately sparse
    and have quiet passages in the middle that are the arrangement, not a fault.
    """
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(src),
         "-af", "silencedetect=noise=-42dB:d=2", "-f", "null", "-"],
        capture_output=True, text=True,
    ).stderr

    start, ends_at_eof = None, False
    for line in out.splitlines():
        if "silence_start:" in line:
            start = float(line.split("silence_start:")[1].strip())
            ends_at_eof = True
        elif "silence_end:" in line:
            # A region that closes again is a quiet passage, not the tail.
            if float(line.split("silence_end:")[1].split("|")[0]) < seconds - 0.5:
                ends_at_eof = False

    if start is None or not ends_at_eof:
        return seconds
    # A second and a half past the last note, so the decay is kept and only the
    # dead air after it is thrown away.
    return max(20.0, min(seconds, start + 1.5))


def encode(src: pathlib.Path, dest: pathlib.Path, seconds: float) -> None:
    """PCM to a small, quiet, consistently loud MP3.

    The two filters both matter. loudnorm makes every track sit at the same
    level, without which the playlist gets louder and quieter as it cycles and
    a player reaches for the volume. The fades hide the wrap: the model does not
    produce a seamless loop, and two seconds of fade at each end turns an
    audible edit into a breath.
    """
    end = content_end(src, seconds)
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-t", f"{end:.2f}",
        "-af", (f"loudnorm=I={LUFS}:TP=-2:LRA=11,"
                f"afade=t=in:st=0:d={FADE_IN},"
                f"afade=t=out:st={max(0.0, end - FADE_OUT):.2f}:d={FADE_OUT}"),
        "-c:a", "libmp3lame", "-b:a", BITRATE, "-ac", "2",
        str(dest),
    ], check=True)
    if end < seconds - 1:
        print(f"    trimmed {seconds - end:.0f}s of dead tail")


def generate(name: str, spec: dict, headers: dict) -> pathlib.Path:
    res = submit({
        "prompt": spec["prompt"],
        "seconds_total": spec["seconds"],
        "num_inference_steps": 8,
    }, headers, name)

    url = (res.get("audio_file") or res.get("audio") or {}).get("url")
    if not url:
        raise RuntimeError(f"{name}: no audio in response: {str(res)[:400]}")

    RAW.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    # The PCM is kept. Re-encoding is free; regenerating is not, and the raw
    # file is the only way to change the bitrate later without paying again.
    raw = RAW / f"{name}.wav"
    raw.write_bytes(requests.get(url, timeout=600).content)

    dest = OUT / f"{name}.mp3"
    encode(raw, dest, spec["seconds"])
    print(f"  {name:10s} {raw.stat().st_size // 1024:6d} KB raw "
          f"-> {dest.stat().st_size // 1024:5d} KB")
    return dest


def write_manifest() -> None:
    """The client reads this rather than guessing filenames.

    A missing file has to be a visible absence, not a silent one: the player
    skips anything the manifest does not list, so a half-finished generation run
    produces a shorter playlist instead of a 404 on every wrap.
    """
    manifest = {
        "lobby": [n for n in TRACKS if n.startswith("lobby") and (OUT / f"{n}.mp3").exists()],
        "norse": [n for n in TRACKS if n.startswith("norse") and (OUT / f"{n}.mp3").exists()],
        "greek": [n for n in TRACKS if n.startswith("greek") and (OUT / f"{n}.mp3").exists()],
    }
    path = OUT / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"  manifest   {sum(len(v) for v in manifest.values())} tracks")


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv

    headers = {"Authorization": f"Key {load_key()}"}
    wanted = args or list(TRACKS)

    for name in wanted:
        if name not in TRACKS:
            print(f"unknown track: {name}")
            return 1
        if not force and (OUT / f"{name}.mp3").exists():
            print(f"  {name:10s} already there, skipping")
            continue
        generate(name, TRACKS[name], headers)

    write_manifest()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
