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

import audioop
import json
import pathlib
import subprocess
import sys
import time
import wave

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

# The bar a track has to clear to ship. Calibrated against the tracks that were
# judged by ear rather than picked: greek-1 measured 0.63 and was fine, norse-2
# measured 0.31 and was "banging". 0.55 sits above everything that was rejected.
MIN_STEADINESS = 0.55

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
    "Fast driving tempo, 140 BPM, energetic and urgent. "
    "A continuous repeating rhythmic ostinato running the entire time, "
    "constant sixteenth note motion that never stops. "
    "Busy and dense, always something playing, no gaps, no space, "
    "no pauses between hits, no sparse isolated drum hits, no long decays. "
    "Full energy from the very first beat, no intro, no build, no fade in. "
    "A melody playing continuously from the start. "
    "Heroic cinematic video game battle music. "
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
            "Nordic war music at a gallop. Fast tight frame drums playing a "
            "constant rolling pattern, not big spaced out hits. A bowed "
            "tagelharpa riff repeating every two bars without pause. "
            "Nyckelharpa playing a fast continuous modal melody over the top. "
            "War horns sustained underneath. Minor and modal, ferocious, "
            "relentless forward motion."
        ),
    },
    "norse-2": {
        "seconds": 110,
        "prompt": COMMON + (
            "Viking battle instrumental, fast and galloping. Rapid tight "
            "drum pattern, continuous rolls and constant snare-like hits, "
            "never stopping. A low bowed lyre riff cycling endlessly. "
            "Overtone flute playing a fast continuous melody. Clashing metal "
            "on every beat. Savage, relentless, driving."
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
            "plucked kithara ostinato cycling continuously without pause, "
            "under a wild fast aulos melody that never rests. Quick frame "
            "drums and finger cymbals keeping constant time. Phrygian mode, "
            "fierce and bright, gods at war above a marble city."
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


def envelope(src: pathlib.Path, window: float = 0.5) -> list:
    """Loudness per window, straight off the PCM.

    Everything about where a track starts and stops is decided from this. Doing
    it with ffmpeg's silencedetect works for the tail, where the question is
    "has it stopped", but not for the head, where the question is "has it got
    going yet" — and an intro is rarely silent, it is just thin.
    """
    with wave.open(str(src), "rb") as w:
        width, rate, frames = w.getsampwidth(), w.getframerate(), w.getnframes()
        step = int(rate * window)
        levels = []
        read = 0
        while read < frames:
            chunk = w.readframes(min(step, frames - read))
            if not chunk:
                break
            read += step
            levels.append(audioop.rms(chunk, width))
    return levels


def steadiness(src: pathlib.Path, start: float, end: float) -> float:
    """How continuous the music is, from 0 to 1. Higher is more driving.

    This exists because loudness turned out to be the wrong question. The first
    Norse tracks measured perfectly well on level — norse-1 peaks at 148% of its
    own busy level two seconds in — and still got described as banging with no
    tempo, because a big drum hit every second and a half is loud and sparse at
    the same time. Level says it is playing; it says nothing about whether there
    is a pulse.

    So: the ratio of the quiet windows to the loud ones across the body of the
    track. A continuous ostinato barely dips between beats and scores high. A
    track that is a boom followed by most of a second of decay scores low.

    Measured, on the tracks that were judged by ear:
        greek-1  0.62   even, described as fine
        norse-1  0.42   sparse booming, rejected
    """
    levels = envelope(src, 0.5)
    lo = max(0, int(start / 0.5))
    hi = min(len(levels), int(end / 0.5))
    body = [v for v in levels[lo:hi] if v > 0]
    if len(body) < 8:
        return 0.0
    ordered = sorted(body)
    quiet = ordered[int(len(ordered) * 0.15)]
    loud = ordered[int(len(ordered) * 0.85)]
    return 0.0 if loud <= 0 else quiet / loud


def content_start(src: pathlib.Path, window: float = 0.5) -> float:
    """Where the track is actually up and running.

    The verdict on the first cut of these was that they take too long to build.
    They do: the model likes an intro, and an intro is exactly the wrong shape
    for a bed that begins the moment you press START. So the quiet run-up is cut
    and the track starts where it is already at full strength.

    What counts as started is SUSTAINED energy, not loud energy, and the
    difference is the whole point. lobby-1 opens at 155% of its own busy level
    and still had to be cut: it is a big hit, four seconds of near silence,
    another big hit, and it does not become continuous music until 21 seconds
    in. Measuring the peak said "started at 0s". Measuring the floor over the
    next six seconds says 21s, which is where a listener would say it starts,
    and cutting to there removes the booming-with-gaps opening that got
    described as banging.

    Full strength is a fraction of the track's own busy level rather than an
    absolute, because these are normalised afterwards and the numbers here are
    arbitrary until then.
    """
    levels = envelope(src, window)
    if not levels:
        return 0.0
    busy = sorted(levels)[int(len(levels) * 0.75)]
    if busy <= 0:
        return 0.0

    hold = busy * 0.45
    span = max(2, int(round(6.0 / window)))     # six seconds of it
    for i in range(len(levels) - span):
        if min(levels[i:i + span]) >= hold:
            # Back off half a window so the first beat is not clipped off.
            return max(0.0, (i * window) - window / 2)
    # Nothing sustained anywhere. Better to ship the whole track than to guess.
    return 0.0


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

    Both ends are cut. The model writes an intro and an outro whether or not it
    was asked for one, and both are wrong here: the intro because the bed starts
    the moment somebody presses START and has to be going already, the outro
    because it is dead air in the middle of a match. What is kept is the part
    where the track is actually playing.

    The filters both matter too. loudnorm makes every track sit at the same
    level, without which the playlist gets louder and quieter as it cycles and a
    player reaches for the volume. The fades hide the wrap, since the model does
    not produce a seamless loop.
    """
    start = content_start(src)
    end = content_end(src, seconds)
    span = max(5.0, end - start)
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        # -ss before -i so the decoder seeks rather than decoding and throwing
        # away, which on a two minute file is the difference between instant
        # and not.
        "-ss", f"{start:.2f}", "-i", str(src), "-t", f"{span:.2f}",
        "-af", (f"loudnorm=I={LUFS}:TP=-2:LRA=11,"
                f"afade=t=in:st=0:d={FADE_IN},"
                f"afade=t=out:st={max(0.0, span - FADE_OUT):.2f}:d={FADE_OUT}"),
        "-c:a", "libmp3lame", "-b:a", BITRATE, "-ac", "2",
        str(dest),
    ], check=True)
    cuts = []
    if start > 0.5:
        cuts.append(f"{start:.0f}s of intro")
    if end < seconds - 1:
        cuts.append(f"{seconds - end:.0f}s of dead tail")
    if cuts:
        print(f"    trimmed {' and '.join(cuts)}")


def fetch_one(name: str, spec: dict, headers: dict, dest: pathlib.Path) -> None:
    res = submit({
        "prompt": spec["prompt"],
        "seconds_total": spec["seconds"],
        # Eight is the maximum this endpoint accepts; asking for more is a 422,
        # not a slower render. So quality per attempt is fixed and the only
        # lever left is asking again, which is what generate() does.
        "num_inference_steps": 8,
    }, headers, name)

    url = (res.get("audio_file") or res.get("audio") or {}).get("url")
    if not url:
        raise RuntimeError(f"{name}: no audio in response: {str(res)[:400]}")
    dest.write_bytes(requests.get(url, timeout=600).content)


def generate(name: str, spec: dict, headers: dict, attempts: int = 3) -> pathlib.Path:
    """Generate until the track has a pulse, then encode it.

    The model is not reliable at this. Asked for a continuous ostinato it
    sometimes returns one and sometimes returns a slow procession of drum hits,
    from the same prompt. Since {@code steadiness} can tell the difference, the
    honest thing is to ask again rather than to ship whatever arrived first and
    let it be found out in play.

    Attempts are capped and the best of them is kept regardless, because a
    generator that can loop forever on a bad day is worse than one that
    occasionally ships a six out of ten and says so.
    """
    RAW.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    raw = RAW / f"{name}.wav"
    want = spec.get("steadiness", MIN_STEADINESS)

    best, best_score = None, -1.0
    for attempt in range(1, attempts + 1):
        candidate = RAW / f"{name}.try{attempt}.wav"
        fetch_one(name, spec, headers, candidate)
        start = content_start(candidate)
        score = steadiness(candidate, start, content_end(candidate, spec["seconds"]))
        print(f"    attempt {attempt}: steadiness {score:.2f} (want {want:.2f})")
        if score > best_score:
            if best is not None:
                best.unlink(missing_ok=True)
            best, best_score = candidate, score
        else:
            candidate.unlink(missing_ok=True)
        if best_score >= want:
            break

    if best_score < want:
        print(f"    KEEPING {best_score:.2f}, below the bar, after {attempts} tries")
    # The PCM is kept. Re-encoding is free; regenerating is not, and the raw
    # file is the only way to change the bitrate later without paying again.
    best.replace(raw)

    dest = OUT / f"{name}.mp3"
    encode(raw, dest, spec["seconds"])
    print(f"  {name:10s} steadiness {best_score:.2f}  "
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
