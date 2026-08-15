#!/usr/bin/env python3
"""Try text-to-3D for the player bodies.

An experiment, run once and judged on the result rather than on the idea. The
players are spheres because the physics is a circle, and a mesh whose silhouette
is wider than that circle lies about where it can be hit. So a model only earns
its place if it reads as a god AND stays inside the collision radius.

Two steps, because the good 3D models are image-to-3D rather than text-to-3D:

    FLUX          one clean front-on concept per pantheon, plain background
    Hunyuan3D v2  that image to a GLB mesh

    /usr/bin/python3 tools/art/model3d.py            # both
    /usr/bin/python3 tools/art/model3d.py norse      # one

Concepts land in tools/art/plates/, meshes in
server/src/main/resources/public/models/. Roughly $0.30 a pantheon.
"""

import pathlib
import random
import sys
import time

import requests

ROOT = pathlib.Path(__file__).resolve().parents[2]
PLATES = ROOT / "tools" / "art" / "plates"
MODELS = ROOT / "server" / "src" / "main" / "resources" / "public" / "models"
ENV = pathlib.Path.home() / ".openclaw" / "master.env"

FLUX = "fal-ai/flux-pro/v1.1"
TO_3D = "fal-ai/hunyuan3d/v2"

# The concept has to be one figure, front on, evenly lit, on a plain background,
# because everything the 3D model gets wrong it gets wrong from here. Busy
# backgrounds become geometry. Dramatic lighting becomes baked-in shadow.
CONCEPTS = {
    "norse": (
        "Full body character concept of a young Norse god, front view, standing straight, "
        "arms at sides, symmetrical, feet together. Heavy iron helm with a crest, fur mantle over "
        "one shoulder, plated armour rimed with frost, hammer at the belt. Cold blue-grey and "
        "pale steel palette. Single character centred, isolated on a plain flat neutral grey "
        "background, no scenery, no ground, no shadow on the floor, evenly lit from the front, "
        "no dramatic lighting, no rim light, full figure visible head to feet, "
        "clean silhouette, game asset turnaround sheet style, no text."
    ),
    "greek": (
        "Full body character concept of a young Greek god, front view, standing straight, "
        "arms at sides, symmetrical, feet together. Bronze helm with a laurel crest, draped chiton, "
        "bronze breastplate with meander pattern, sandals. Warm gold and bronze and pale marble "
        "palette. Single character centred, isolated on a plain flat neutral grey background, "
        "no scenery, no ground, no shadow on the floor, evenly lit from the front, "
        "no dramatic lighting, no rim light, full figure visible head to feet, "
        "clean silhouette, game asset turnaround sheet style, no text."
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
    r = requests.post(f"https://queue.fal.run/{model}", headers=headers,
                      json=payload, timeout=180).json()
    status_url, response_url = r.get("status_url"), r.get("response_url")
    if not status_url:
        raise RuntimeError(f"{label}: fal returned no status_url: {str(r)[:300]}")
    # 3D generation is slower than an image; give it ten minutes before giving up.
    for _ in range(300):
        s = requests.get(status_url, headers=headers, timeout=120).json()
        if s.get("status") == "COMPLETED":
            return requests.get(response_url, headers=headers, timeout=180).json()
        if s.get("status") == "FAILED":
            raise RuntimeError(f"{label}: FAILED {str(s)[:300]}")
        time.sleep(3)
    raise TimeoutError(f"{label}: still queued after ten minutes")


def concept(name: str, headers: dict) -> pathlib.Path:
    res = submit(FLUX, {
        "prompt": CONCEPTS[name],
        "image_size": "portrait_4_3",
        "num_images": 1,
        "enable_safety_checker": False,
        "seed": random.randint(1, 9_999_999),
    }, headers, f"flux/concept-{name}")
    PLATES.mkdir(parents=True, exist_ok=True)
    dest = PLATES / f"concept-{name}.png"
    dest.write_bytes(requests.get(res["images"][0]["url"], timeout=180).content)
    print(f"  concept  {dest.name}")
    return dest


def mesh(name: str, image_url: str, headers: dict) -> pathlib.Path:
    res = submit(TO_3D, {
        "input_image_url": image_url,
        "num_inference_steps": 50,
        "guidance_scale": 7.5,
        "octree_resolution": 256,
        "textured_mesh": True,
    }, headers, f"hunyuan3d/{name}")
    url = (res.get("model_mesh") or {}).get("url")
    if not url:
        raise RuntimeError(f"{name}: no mesh in response: {str(res)[:300]}")
    MODELS.mkdir(parents=True, exist_ok=True)
    dest = MODELS / f"player-{name}.glb"
    dest.write_bytes(requests.get(url, timeout=600).content)
    print(f"  mesh     {dest.name}  {dest.stat().st_size // 1024} KB")
    return dest


def upload(path: pathlib.Path, headers: dict) -> str:
    """fal needs a URL, so the concept goes up before it can come back as a mesh."""
    r = requests.post(
        "https://rest.alpha.fal.ai/storage/upload/initiate",
        headers={**headers, "Content-Type": "application/json"},
        json={"content_type": "image/png", "file_name": path.name},
        timeout=120,
    )
    r.raise_for_status()
    body = r.json()
    requests.put(body["upload_url"], data=path.read_bytes(),
                 headers={"Content-Type": "image/png"}, timeout=300).raise_for_status()
    return body["file_url"]


def main() -> int:
    env = load_env()
    key = env.get("FAL_KEY")
    if not key:
        print("no FAL_KEY in ~/.openclaw/master.env")
        return 1
    headers = {"Authorization": f"Key {key}"}

    wanted = sys.argv[1:] or list(CONCEPTS)
    for name in wanted:
        if name not in CONCEPTS:
            print(f"unknown: {name}")
            return 1
        print(name)
        image = concept(name, headers)
        url = upload(image, headers)
        mesh(name, url, headers)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
