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
| shove | your own shove fires | swept noise burst plus a falling sine |
| tether on/off | the predictor's anchor changes | a short pluck up, a shorter one down |
| tether tone | while attached | triangle, pitch tracks rope tension |
| impact | a body's velocity jumps | bandpassed burst plus a thud, both scaled |
| star touch | the star is the body that jumped | brighter, higher, no thud |
| goal | the score changes | a bell; rising if it was yours, falling if not |
| win | a winner appears | the goal bell extended into an arpeggio |
| countdown | each second before a match | a blip, an octave up on the last one |

Effects fire from two different places on purpose. The ones you cause — shove
and tether — come off the local predicted input, so they land on the same frame
as the key press rather than a round trip later. The ones you observe — impacts,
goals, the countdown — come off snapshots, because the server decides whether
they happened.

**There is no thrust sound, and that is deliberate.** There was one: filtered
noise under a low sine, gated by how hard you were pushing. In a game where you
thrust almost continuously it ran almost continuously, so it stopped being a cue
and became a floor that the shove, the impacts and the bells all had to be heard
over. It was removed rather than turned down. Adding it back means solving that
first.

## Music is generated ahead of time

A frame drum and a lyre do not come out of an oscillator. Five instrumental beds
are generated once by `tools/audio/music.py` through fal's Stable Audio, and
shipped as MP3 in `public/music/` with a manifest the client reads.

- **lobby-1** — taiko and a rising string ostinato. Anticipation before a fight.
- **norse-1, norse-2** — war drums, bowed tagelharpa riffs, bronze horns.
- **greek-1, greek-2** — driving kithara, soaring aulos, bronze cymbals.

The first version of all five was restrained, to match the art. It was correct
and nobody noticed it, which for a game soundtrack is the same as being wrong.
These are louder, faster and more dramatic, and they start with full energy
rather than building, because a long build at the start of a session is
indistinguishable from the music being broken.

During a match the playlist alternates pantheons rather than shuffling, because
two Norse tracks in a row read as one long track and the point of having both is
that the change is noticeable. Tracks crossfade four seconds before the end;
`ended` is never used, because by the time it fires there is already a gap.

Three things the generator does that are not obvious:

**It trims both ends.** The model writes an intro and an outro whether or not it
was asked for one, and both are wrong here. The intro is wrong because the bed
starts the moment somebody presses START and has to be going already; the outro
is wrong because it is dead air in the middle of a match. Asked for 110 seconds
it returns 110 seconds but stops having ideas before then — norse-1 went quiet
with twenty seconds left.

The head is the harder end, and the trick is that what counts as started is
*sustained* energy, not loud energy. lobby-1 opens at 155% of its own busy level
and still had to be cut twenty seconds: it is a big hit, four seconds of near
silence, another big hit, and it does not become continuous music until 21s.
Measuring the peak said it started at 0s. Measuring the floor over the following
six seconds says 21s, which is where a listener would say it starts — and
cutting to there is also what removed the booming-with-gaps opening.

Quiet passages in the middle are left alone; those are the arrangement. Only a
trailing quiet run that reaches the end of the file counts as an outro.

**It normalises loudness.** Every track is brought to -18 LUFS. Without this the
playlist gets louder and softer as it cycles. It was -23, which is broadcast
quiet and sat under the game so well that it went unnoticed.

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
