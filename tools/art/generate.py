#!/usr/bin/env python3
"""Generate the source plates for Orrery's textures with FLUX.

These are PLATES, not finished textures. Everything here goes through
process.py afterwards to be delit, made seamless, and turned into the maps the
renderer actually loads. Generating straight to a texture does not work, for one
reason that governs this whole directory:

    The star is the only light in the arena.

So no texture may contain lighting of its own. Every image model bakes lighting
in by default, because it has been trained on photographs, which have suns in
them. The prompts below fight that as hard as prompting can, and process.py
removes what survives.

    /usr/bin/python3 tools/art/generate.py              # everything
    /usr/bin/python3 tools/art/generate.py floor star   # just these

Plates land in tools/art/plates/. About $0.05 each on flux-pro/v1.1.
"""

import os
import pathlib
import random
import sys
import time

import requests

ROOT = pathlib.Path(__file__).resolve().parents[2]
PLATES = ROOT / "tools" / "art" / "plates"
ENV = pathlib.Path.home() / ".openclaw" / "master.env"

FLUX = "fal-ai/flux-pro/v1.1"

# Prepended to every prompt. The repetition is deliberate: "flat" alone does not
# survive, and the model needs to be told what to omit as well as what to draw.
FLAT = (
    "flat texture map for a 3D game, albedo colour map only, "
    "perfectly evenly lit under uniform diffuse light, absolutely no shadows, "
    "no cast shadows, no highlights, no specular reflections, no glare, "
    "no light coming from any direction, no vignette, no depth of field, "
    "photographed flat straight on from directly above, orthographic, "
    "no perspective, entire surface in focus, no text, no letters, no logos"
)

# Nearly everything here is close to black on purpose. The brief is explicit:
# mid-grey art vanishes against #05070d, and the star's light is what reveals
# the surface at runtime.
PLATES_SPEC = {
    "floor": (
        "Seamless repeating industrial surface texture of the deck plating of a long-abandoned "
        "structure. Very dark near-black blue-grey metal, panel seams in a regular grid, rows of "
        "small rivets, long scoring scratches, patches of fine dust and grit, subtle corrosion "
        "mottling. Tileable, edge to edge continuous pattern, no border, no frame, "
        f"dark charcoal navy palette around hex 0b1120. {FLAT}"
    ),
    # "Orrery texture" first produced an orrery: a centred instrument with dials
    # and compass letters on it. These are spheres, so what is wanted is one
    # small patch of that instrument's material, with nothing centred at all.
    "fragment": (
        "Seamless all-over surface texture of ancient oxidised bronze and dark stone, a close-up of "
        "one small patch of a broken astronomical instrument. Straight parallel machined grooves, "
        "faint engraved arcs and tick marks scattered across the whole surface, chipped worn edges, "
        "pitting, dust and grit in the recesses. A flat material swatch, NOT an object: no dials, no "
        "concentric rings centred in the frame, no wheels, no numerals, no letters, no compass "
        "points, nothing centred, no focal point. Dark desaturated SLATE GREY stone, cold and "
        "neutral, only a trace of dull bronze. Not gold, not orange, not warm: the fragments must "
        "not read as one team's colour when Greek is gold. Close to black. Tileable, continuous "
        f"edge to edge. {FLAT}"
    ),
    "player-norse": (
        "Seamless all-over surface texture of pitted cold forged iron rimed with frost. Hammered "
        "facets and dents from a smith hammer, deep pitting, a scatter of straight angular carved "
        "rune strokes, pale blue-white frost crystals gathered in the hollows. Bold large-scale "
        "features that stay readable at sixty pixels, not fine detail. Cold blue-grey, near-black "
        f"iron with pale frost around hex 7fa8e3. Tileable, no focal point. {FLAT}"
    ),
    # Two wrong readings to steer between. White marble blows out under a light
    # this warm. Oxidised bronze goes green, and green is the problem: Greek is
    # gold everywhere else in the game, on the jaws they defend, on their crest,
    # on their half of the scoreboard. The first version of this plate came back
    # green-dominant, rgb(42,50,36), against a team colour of e0b062 where red
    # leads by a mile. In a contact game you identify a teammate by hue while
    # everything is moving, so team identity beats material realism. Dark warm
    # stone with bronze, and the word verdigris kept well away from it.
    "player-greek": (
        "Seamless all-over surface texture of dark warm charcoal marble shot through with aged "
        "bronze and gold veining. Bold warm veins across the whole surface, scattered bronze meander "
        "key fragments and simple laurel leaf inlays distributed evenly, warm brown-gold patina in "
        "the recesses. DARK warm stone, deep charcoal brown and dark umber, NOT white marble, NOT "
        "bright, NOT light. Absolutely no green, no verdigris, no teal, no malachite, no olive. "
        "Warm gold and bronze accents around hex e0b062. Bold large-scale shapes readable at sixty "
        f"pixels. No borders, no bands, no stripes, no focal point, tileable. {FLAT}"
    ),
    # The one exception to the no-light rule: this surface really does emit.
    "star": ("The churning surface of a hot star seen from very close, the surface COMPLETELY FILLING "
        "the entire frame from edge to edge. Granulation cells, convection texture, bright plasma "
        "filaments, a few darker cooler sunspot patches. There is NO edge of the sun, NO limb, NO "
        "curve, NO black space anywhere, NO corona, NO flares, NO rays: this is a flat close-up of "
        "the surface only, like a photograph of glowing embers. Brilliant warm white-yellow around "
        "hex ffe9b0 with orange around hex ffc46a. No text, no letters, no logos."
    ),
    "backdrop": (
        "Deep space panorama, extremely dark and restrained, almost entirely black. Enormous "
        "broken rings of a colossal derelict orrery receding into darkness, faint edge-lit silhouettes "
        "only, a faint dust lane crossing the frame, sparse tiny cold white stars, one small distant "
        "dim nebula in muted blue. Vast, cold, empty, quiet. Astronomical photograph, not an "
        "illustration. No planets in the foreground, no spacecraft, no bright colours, no neon, "
        "no lens flare, no text. Deep near-black palette around hex 05070d."
    ),
}


def load_env() -> dict:
    env = {}
    if ENV.exists():
        for line in ENV.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip()
    return env


def submit(model: str, payload: dict, headers: dict, label: str) -> dict:
    status_url = response_url = None
    for _ in range(3):
        r = requests.post(f"https://queue.fal.run/{model}", headers=headers,
                          json=payload, timeout=120).json()
        status_url, response_url = r.get("status_url"), r.get("response_url")
        if status_url:
            break
        time.sleep(5)
    if not status_url:
        raise RuntimeError(f"{label}: fal returned no status_url (out of credits?): {str(r)[:200]}")
    for _ in range(180):
        s = requests.get(status_url, headers=headers, timeout=120).json()
        if s.get("status") == "COMPLETED":
            return requests.get(response_url, headers=headers, timeout=120).json()
        if s.get("status") == "FAILED":
            raise RuntimeError(f"{label}: FAILED {s}")
        time.sleep(2)
    raise TimeoutError(f"{label}: still queued after 6 minutes")


def generate(name: str, headers: dict) -> pathlib.Path:
    # The backdrop is the only wide one; everything else is a square swatch that
    # gets tiled or wrapped onto a sphere.
    size = "landscape_16_9" if name == "backdrop" else "square_hd"
    res = submit(FLUX, {
        "prompt": PLATES_SPEC[name],
        "image_size": size,
        "num_images": 1,
        "enable_safety_checker": False,
        "seed": random.randint(1, 9_999_999),
    }, headers, f"flux/{name}")
    PLATES.mkdir(parents=True, exist_ok=True)
    dest = PLATES / f"{name}.png"
    dest.write_bytes(requests.get(res["images"][0]["url"], timeout=180).content)
    return dest


def main() -> int:
    key = load_env().get("FAL_KEY") or os.environ.get("FAL_KEY")
    if not key:
        print("no FAL_KEY in ~/.openclaw/master.env", file=sys.stderr)
        return 1
    headers = {"Authorization": f"Key {key}", "Content-Type": "application/json"}

    wanted = [a.lower() for a in sys.argv[1:]] or list(PLATES_SPEC)
    unknown = [w for w in wanted if w not in PLATES_SPEC]
    if unknown:
        print(f"unknown: {', '.join(unknown)}; known: {', '.join(PLATES_SPEC)}", file=sys.stderr)
        return 1

    failed = []
    for name in wanted:
        try:
            print(f"  ok   {name:<14} -> {generate(name, headers).name}")
        except Exception as e:
            failed.append(name)
            print(f"  FAIL {name:<14} {type(e).__name__}: {e}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
