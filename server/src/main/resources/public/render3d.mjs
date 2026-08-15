// The 3D view.
//
// The simulation is and stays two dimensional: circles on a plane, identical on
// the server and in the browser, verified bit for bit by tools/drift-check.sh.
// Nothing in this file touches it. Everything here reads the same body list the
// flat renderer reads and draws it as geometry in a room.
//
// Why bother, when the game is flat underneath: the star is the only light
// source in the arena, and in 2D that idea can only be drawn as a gradient. In
// 3D it is an actual light. Bodies are lit from wherever the star is, they cast
// real shadows across the floor, and the far end of the arena goes properly dark
// when the star is at the near end. The mechanic and the picture become the same
// thing.
//
// ?flat=1 falls back to the canvas renderer, which is kept because it is the one
// that will still run on a machine with no working WebGL.

import * as THREE from './vendor/three.module.js';

const TEAM_COLOR = [0x7fa8e3, 0xe0b062];

export class Renderer3D {
  constructor(canvas, cfg) {
    this.cfg = cfg;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070d);
    this.scene.fog = new THREE.Fog(0x05070d, 90, 240);

    // Looking down the arena at an angle rather than straight down. Straight
    // down is readable and completely flat; this keeps the read while letting
    // the geometry and the shadows show.
    // Higher and less tilted than the first attempt, which foreshortened the
    // far end of the arena badly enough that a body up there was a smudge.
    // Readability wins over drama: this is a game you aim in.
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 600);
    this.camera.position.set(cfg.w / 2, -cfg.h * 0.78, cfg.h * 2.35);
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(cfg.w / 2, cfg.h * 0.5, 0);

    this.buildArena();

    /*
     * The star is meant to be the only light, and taken literally that produced
     * a cave: the far half of the arena was unreadable and the ring fragments
     * were invisible until you hit one. A game you aim in has to be legible.
     *
     * So: a little ambient, and a dim cool light from above that reads as the
     * dead sky rather than as a lamp. Both are far below the star, which still
     * dominates every surface it reaches and still throws every shadow.
     */
    this.scene.add(new THREE.AmbientLight(0x2a3752, 0.9));

    const sky = new THREE.DirectionalLight(0x8fa6d8, 0.35);
    sky.position.set(this.cfg.w * 0.5, this.cfg.h * 0.2, 90);
    this.scene.add(sky);

    this.starLight = new THREE.PointLight(0xffc46a, 900, 260, 2);
    this.starLight.castShadow = true;
    // 512 rather than 1024: the difference is invisible at this scale and it
    // halves the cost of a frame on a machine drawing this in software.
    this.starLight.shadow.mapSize.set(512, 512);
    this.starLight.shadow.camera.near = 1;
    this.starLight.shadow.camera.far = 220;
    this.scene.add(this.starLight);

    this.bodies = new Map();   // id -> THREE.Mesh
    this.tetherLines = new Map();
    this.flashRings = [];

    this.sphere = new THREE.SphereGeometry(1, 32, 24);
  }

  buildArena() {
    const { w, h } = this.cfg;

    // The floor. Slightly larger than the cage so the walls have something to
    // stand on and the fog has something to fade into.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(w + 40, h + 40),
      new THREE.MeshStandardMaterial({ color: 0x0b1120, roughness: 0.95, metalness: 0.05 }),
    );
    floor.position.set(w / 2, h / 2, -0.01);
    floor.receiveShadow = true;
    this.scene.add(floor);

    // The cage, as four low walls. Low on purpose: high walls hide the play.
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x1c2740, roughness: 0.8, metalness: 0.2,
    });
    const wallH = 3.2, wallT = 0.6;
    const walls = [
      [w / 2, 0, w + wallT, wallT],
      [w / 2, h, w + wallT, wallT],
      [0, h / 2, wallT, h],
      [w, h / 2, wallT, h],
    ];
    for (const [x, y, sx, sy] of walls) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, wallH), wallMat);
      mesh.position.set(x, y, wallH / 2);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.scene.add(mesh);
    }

    // A lit edge around the top of the cage. The flat renderer got its
    // readability from a single stroked rectangle, and losing that was the main
    // thing that made the 3D version hard to read: with only a point light in
    // the middle, nothing told you where the floor ended.
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, 0.01)),
      new THREE.LineBasicMaterial({ color: 0x3a5580, transparent: true, opacity: 0.55 }),
    );
    edge.position.set(w / 2, h / 2, wallH);
    this.scene.add(edge);

    // The jaws: the stretch of each end wall a star can be fed through, lit in
    // the colour of the team that scores there.
    const jaws = this.cfg.jaws;
    for (const [x, team] of [[0, 1], [w, 0]]) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, jaws * 2, wallH * 1.15),
        new THREE.MeshStandardMaterial({
          color: TEAM_COLOR[team], emissive: TEAM_COLOR[team],
          emissiveIntensity: 0.55, roughness: 0.5,
        }),
      );
      mesh.position.set(x, h / 2, wallH * 0.575);
      this.scene.add(mesh);
    }
  }

  /** One mesh per body, created on first sight and reused after. */
  meshFor(b) {
    let mesh = this.bodies.get(b.id);
    if (mesh) return mesh;

    let material;
    if (b.id === -1) {
      // The star is emissive, and the light itself is a separate object that
      // follows it. An emissive material lights nothing on its own.
      material = new THREE.MeshStandardMaterial({
        color: 0xffe9b0, emissive: 0xffd98a, emissiveIntensity: 1.4, roughness: 0.4,
      });
    } else if (b.fixed) {
      // A trace of self-illumination on the fragments, so an unlit one on the
      // far side is still an obstacle you can see rather than one you discover.
      material = new THREE.MeshStandardMaterial({
        color: 0x1b2438, roughness: 0.9, metalness: 0.15,
        emissive: 0x121a2b, emissiveIntensity: 1,
      });
    } else {
      material = new THREE.MeshStandardMaterial({
        color: TEAM_COLOR[b.team] ?? 0x8a8f98, roughness: 0.45, metalness: 0.25,
      });
    }

    mesh = new THREE.Mesh(this.sphere, material);
    // The star does not cast a shadow. The light is INSIDE it, so it shadowed
    // itself and sat in a black ellipse of its own making.
    mesh.castShadow = b.id !== -1;
    mesh.receiveShadow = b.fixed === true;
    this.scene.add(mesh);
    this.bodies.set(b.id, mesh);
    return mesh;
  }

  /** A ring on the floor where something was hit. */
  addFlash(x, y, strength) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 0.95, 32),
      new THREE.MeshBasicMaterial({
        color: 0xffe9b0, transparent: true, opacity: 0.7 * strength,
        side: THREE.DoubleSide,
      }),
    );
    ring.position.set(x, y, 0.05);
    this.scene.add(ring);
    this.flashRings.push({ ring, born: performance.now(), strength });
  }

  /**
   * @param bodies  what to draw, from the same source the flat renderer uses
   * @param myId    the local player, drawn brighter
   * @param ghost   the server's opinion of the local player, or null
   */
  draw(bodies, myId, ghost) {
    const seen = new Set();

    for (const b of bodies) {
      seen.add(b.id);
      const mesh = this.meshFor(b);
      mesh.position.set(b.x, b.y, b.r);
      mesh.scale.setScalar(b.r);

      if (b.id === -1) {
        this.starLight.position.set(b.x, b.y, b.r * 2.2);
        const pulse = 1 + Math.sin(performance.now() / 620) * 0.07;
        mesh.material.emissiveIntensity = 1.4 * pulse;
      } else if (b.id === myId) {
        mesh.material.emissive = new THREE.Color(0x7fe3c0);
        mesh.material.emissiveIntensity = 0.35;
      }
    }

    for (const [id, mesh] of this.bodies) {
      if (!seen.has(id)) {
        this.scene.remove(mesh);
        mesh.material.dispose();
        this.bodies.delete(id);
      }
    }

    this.drawTethers(bodies);
    this.updateFlashes();
    this.drawGhost(ghost);
    this.renderer.render(this.scene, this.camera);
  }

  drawTethers(bodies) {
    const live = new Set();
    for (const b of bodies) {
      if (!b.tether) continue;
      const anchor = bodies.find(x => x.id === b.tether);
      if (!anchor) continue;
      live.add(b.id);

      let line = this.tetherLines.get(b.id);
      if (!line) {
        line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
          new THREE.LineBasicMaterial({ color: 0xbed7ff, transparent: true, opacity: 0.75 }),
        );
        this.scene.add(line);
        this.tetherLines.set(b.id, line);
      }
      line.geometry.setFromPoints([
        new THREE.Vector3(b.x, b.y, b.r),
        new THREE.Vector3(anchor.x, anchor.y, anchor.r),
      ]);
    }
    for (const [id, line] of this.tetherLines) {
      if (!live.has(id)) {
        this.scene.remove(line);
        line.geometry.dispose();
        this.tetherLines.delete(id);
      }
    }
  }

  updateFlashes() {
    const now = performance.now();
    for (let i = this.flashRings.length - 1; i >= 0; i--) {
      const f = this.flashRings[i];
      const age = (now - f.born) / 520;
      if (age >= 1) {
        this.scene.remove(f.ring);
        f.ring.geometry.dispose();
        f.ring.material.dispose();
        this.flashRings.splice(i, 1);
        continue;
      }
      f.ring.scale.setScalar(1 + age * 9 * f.strength);
      f.ring.material.opacity = (1 - age) * 0.6 * f.strength;
    }
  }

  drawGhost(ghost) {
    if (!ghost) {
      if (this.ghostMesh) this.ghostMesh.visible = false;
      return;
    }
    if (!this.ghostMesh) {
      this.ghostMesh = new THREE.Mesh(
        this.sphere,
        new THREE.MeshBasicMaterial({
          color: 0xe8b04b, wireframe: true, transparent: true, opacity: 0.35,
        }),
      );
      this.scene.add(this.ghostMesh);
    }
    this.ghostMesh.visible = true;
    this.ghostMesh.position.set(ghost.x, ghost.y, ghost.r);
    this.ghostMesh.scale.setScalar(ghost.r * 1.06);
  }

  resize(width, height) {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}
