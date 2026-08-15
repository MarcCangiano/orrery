# Sound

Two layers built in completely different ways, for a reason that is worth
stating once.

## Effects are synthesised, not sampled

Everything you hear as a result of the physics is generated in Web Audio at the
moment it happens: `server/src/main/resources/public/audio.mjs`. There are no
sound files.

The reason is not download size, although it is nice that the whole effects
layer costs nothing. It is that a synthesised sound can be told how hard the hit
was. `impact(strength)` takes the change in velocity across a snapshot and turns
it into a sound that is louder, brighter and lower for a harder hit — not the
same sound played at a higher volume. A ball catching another ball at a glance
and a ball arriving at full speed are different events, and a player who can
hear the difference knows something they would otherwise have to look for.

The same applies to the tether, whose pitch tracks how far the rope has been
stretched, so a swing is audible as tension rather than as an on/off tone.

| sound | when | shape |
| --- | --- | --- |
| thrust | every tick, gated by input | filtered noise plus a low sine, gain-ramped |
| shove | your own shove fires | swept noise burst plus a falling sine |
| tether on/off | the predictor's anchor changes | a short pluck up, a shorter one down |
| tether tone | while attached | triangle, pitch tracks rope tension |
| impact | a body's velocity jumps | bandpassed burst plus a thud, both scaled |
| star touch | the star is the body that jumped | brighter, higher, no thud |
| goal | the score changes | a bell; rising if it was yours, falling if not |
| win | a winner appears | the goal bell extended into an arpeggio |
| countdown | each second before a match | a blip, an octave up on the last one |

Effects fire from two different places on purpose. The ones you cause — thrust,
shove, tether — come off the local predicted input, so they land on the same
frame as the key press rather than a round trip later. The ones you observe —
impacts, goals, the countdown — come off snapshots, because the server decides
whether they happened.

## Music is generated ahead of time

A frame drum and a lyre do not come out of an oscillator. Five instrumental beds
are generated once by `tools/audio/music.py` through fal's Stable Audio, and
shipped as MP3 in `public/music/` with a manifest the client reads.

- **lobby-1** — a drone, no pulse at all. Heard before anything is at stake.
- **norse-1, norse-2** — frame drum at a heartbeat, bowed lyre, cold.
- **greek-1, greek-2** — plucked lyre and aulos, warmer, more articulate.

During a match the playlist alternates pantheons rather than shuffling, because
two Norse tracks in a row read as one long track and the point of having both is
that the change is noticeable. Tracks crossfade four seconds before the end;
`ended` is never used, because by the time it fires there is already a gap.

Three things the generator does that are not obvious:

**It trims the dead tail.** Asked for 110 seconds, the model returns 110 seconds
but stops having ideas earlier — norse-1 went quiet with twenty seconds left.
Trailing quiet is detected and cut so the fade lands on the last real note.
Quiet passages in the middle are left alone; those are the arrangement.

**It normalises loudness.** Every track is brought to -23 LUFS, which is quiet
on purpose: this sits under a game whose shove cue has to be audible over it.
Without this the playlist gets louder and softer as it cycles.

**It keeps the PCM.** The raw WAVs stay in `tools/audio/raw/`, gitignored at
ninety megabytes. `tools/audio/reencode.py` rebuilds every MP3 from them, so
changing the bitrate or the loudness target later costs nothing. Regenerating
from scratch is about twenty cents.

## Verifying it

`tools/audio-check.mjs`, wired into `verify.sh`.

It renders every effect through an `OfflineAudioContext` and measures the
samples, rather than asserting that the methods exist. The distinction matters:
a check of the second kind would have passed on every version of this file that
made no sound at all.

What it asserts:

- silence measures silent, which is what makes every other number mean anything
- every effect produces audible signal
- a hard impact measures meaningfully louder than a soft one, so strength is
  still carrying information and not just calling the same sound twice
- muting actually silences the graph
- every method `game.mjs` calls exists on the class
- every track in the manifest is served as real audio

It was confirmed to fail by setting the effects bus gain to zero, which it
reported as eleven silent effects.

## Regenerating

    /usr/bin/python3 tools/audio/music.py            # anything missing
    /usr/bin/python3 tools/audio/music.py --force    # all of it, again
    /usr/bin/python3 tools/audio/music.py norse-1    # one track
    /usr/bin/python3 tools/audio/reencode.py         # re-encode from kept PCM

Needs `FAL_KEY` in `~/.openclaw/master.env` and `ffmpeg` on the path.
