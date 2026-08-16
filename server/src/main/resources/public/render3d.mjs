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

/**
 * How fast the camera closes on where it should be, per second.
 *
 * 16 settles in roughly 60ms, which trails the world enough to stay steady and
 * not enough to feel like input lag.
 */
const CAMERA_RATE = 16;

const TEAM_COLOR = [0x7fa8e3, 0xe0b062];

/*
 * Bodies are multiplied by a near-white rather than by the team colour.
 *
 * Multiplying a texture that averages rgb(50,45,30) by a saturated team colour
 * leaves almost nothing: at the distance this game is played from, a player is
 * about twenty pixels across, and twenty pixels of near-black is a dot. The
 * team read comes from the rim shell below, which is emissive and therefore
 * survives being on the dark side of the arena. The texture is then free to be
 * a material rather than a label.
 */
const BODY_TINT = [0xdfe8f8, 0xf0e2c8];
const TEX = './textures/';

/**
 * Every texture the scene uses, loaded once.
 *
 * <p>Colour maps are tagged sRGB and data maps are not, which is not a detail:
 * a normal map read as sRGB has its slopes bent by the transfer curve and the
 * surface lights wrongly in a way that is easy to see and hard to name.
 *
 * <p>Nothing here blocks. Three fills each texture in when it arrives, so a
 * missing or slow file costs the look of a surface and never the game.
 */
function loadTextures() {
  const loader = new THREE.TextureLoader();

  const colour = (file, repeat) => {
    const tex = loader.load(TEX + file);
    tex.colorSpace = THREE.SRGBColorSpace;
    if (repeat) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(repeat[0], repeat[1]);
    }
    return tex;
  };
  const data = (file, repeat) => {
    const tex = loader.load(TEX + file);
    if (repeat) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(repeat[0], repeat[1]);
    }
    return tex;
  };

  // The floor tile is a metre or two across in world units, so the arena wants
  // it repeated rather than stretched over 120 units of plating.
  const floorRepeat = [8, 5];

  return {
    floorAlbedo: colour('floor-albedo.jpg', floorRepeat),
    floorNormal: data('floor-normal.jpg', floorRepeat),
    floorRough: data('floor-roughness.jpg', floorRepeat),
    fragment: colour('fragment-albedo.jpg', [2, 1]),
    norse: colour('player-norse-albedo.jpg'),
    greek: colour('player-greek-albedo.jpg'),
    star: colour('star-equirect.jpg'),
    glow: colour('particle-glow.png'),
    shockwave: colour('particle-shockwave.png'),
  };
}

export class Renderer3D {
  constructor(canvas, cfg) {
    this.cfg = cfg;
    // Exposed so a test can project a world position through this exact camera.
    this.THREE = THREE;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.tex = loadTextures();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070d);
    this.scene.fog = new THREE.Fog(0x05070d, 110, 280);

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
    this.buildSky();

    /*
     * The star is meant to be the only light, and taken literally that produced
     * a cave: the far half of the arena was unreadable and the ring fragments
     * were invisible until you hit one. A game you aim in has to be legible.
     *
     * So: a little ambient, and a dim cool light from above that reads as the
     * dead sky rather than as a lamp. Both are far below the star, which still
     * dominates every surface it reaches and still throws every shadow.
     */
    this.scene.add(new THREE.AmbientLight(0x2a3752, 1.4));

    const sky = new THREE.DirectionalLight(0x8fa6d8, 0.5);
    sky.position.set(this.cfg.w * 0.5, this.cfg.h * 0.2, 90);
    this.scene.add(sky);

    this.starLight = new THREE.PointLight(0xffc46a, 2200, 300, 1.7);
    this.starLight.castShadow = true;
    // 512 rather than 1024: the difference is invisible at this scale and it
    // halves the cost of a frame on a machine drawing this in software.
    this.starLight.shadow.mapSize.set(512, 512);
    this.starLight.shadow.camera.near = 1;
    this.starLight.shadow.camera.far = 220;
    // Without these the floor shadows itself: a point light a couple of units
    // above a large plane produces acne across the whole surface, which read as
    // a hard dark rectangle sitting next to the star.
    this.starLight.shadow.bias = -0.0015;
    this.starLight.shadow.normalBias = 0.35;
    this.scene.add(this.starLight);

    /*
     * The camera follows, rather than watching the whole pitch from orbit.
     *
     * A fixed wide shot fits everything and shows nothing: a player is twenty
     * pixels and a god is a smudge. This tracks the point between you and the
     * star, and pulls back as the two of you separate, so the thing you are
     * about to do is always the thing filling the screen. It is clamped inside
     * the arena so it never drifts off to look at empty space, and it is damped,
     * so a bounce moves the camera smoothly instead of snapping it.
     *
     * Press C for the old fixed view, which is still the better one for
     * watching somebody else play.
     */
    this.follow = true;
    this.camFocus = new THREE.Vector2(cfg.w / 2, cfg.h / 2);
    this.camHeight = cfg.h * 2.35;

    this.bodies = new Map();   // id -> THREE.Mesh
    this.tetherLines = new Map();
    this.flashRings = [];

    this.sphere = new THREE.SphereGeometry(1, 32, 24);

    /*
     * Bodies are spheres, by choice.
     *
     * Generated god meshes were built, wired in, and taken out again: they read
     * as noise at the distance this is played from, and the game is clearer with
     * a ball whose colour tells you whose it is. tools/art/model3d.py still
     * makes them if that judgement ever changes.
     */

    // A soft halo that always faces the camera, so the star reads as something
    // burning rather than as a lit ball. Cheaper and steadier than bloom.
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.tex.glow,
      color: 0xffc46a,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    this.halo.scale.setScalar(26);
    this.scene.add(this.halo);
  }

  /**
   * The dead system, built rather than painted.
   *
   * <p>It was an equirectangular photograph, and it looked it: a generated plate
   * fitted to a 2:1 sphere map and stretched over the whole sky, so every star
   * was several soft blocks across. A star is a point of light one pixel wide,
   * which is the one thing a texture can never be at any resolution you can
   * afford to ship.
   *
   * <p>So the stars are points and the derelict rings are lines. Both stay sharp
   * at any zoom, cost almost nothing, and are deterministic: the same seed every
   * load, because a sky that reshuffles on refresh reads as a bug.
   */
  buildSky() {
    // Small deterministic generator. Math.random would give a different sky on
    // every load and make any screenshot impossible to reproduce.
    let seed = 20260815;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    const COUNT = 2600;
    const R = 420;
    const positions = new Float32Array(COUNT * 3);
    const colours = new Float32Array(COUNT * 3);
    const sizes = new Float32Array(COUNT);

    for (let i = 0; i < COUNT; i++) {
      // Even over the sphere: acos of a uniform, not a uniform angle, or the
      // poles gather far more stars than the equator.
      const theta = rand() * Math.PI * 2;
      const phi = Math.acos(2 * rand() - 1);
      positions[i * 3] = R * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = R * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = R * Math.cos(phi);

      // Mostly cold white, a few warm, none of them bright enough to argue with
      // the star.
      const warm = rand() > 0.86;
      const level = 0.35 + rand() * 0.55;
      colours[i * 3] = level * (warm ? 1 : 0.82);
      colours[i * 3 + 1] = level * (warm ? 0.86 : 0.88);
      colours[i * 3 + 2] = level * (warm ? 0.7 : 1);
      sizes[i] = rand() < 0.06 ? 2.6 : 1.3;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const stars = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 1.6,
      sizeAttenuation: false,   // a star is a point, however far away it is
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      // The scene fog fades everything past 280 units into the background, and
      // the sky lives at 420. Without this the entire starfield renders and is
      // then faded to exactly the colour behind it, which looks identical to
      // having drawn nothing at all.
      fog: false,
    }));
    stars.position.set(this.cfg.w / 2, this.cfg.h / 2, 0);
    this.scene.add(stars);

    // The broken orrery this place fell out of: enormous rings, edge on, tilted
    // away, faint enough to read as structure rather than as decoration.
    const ringMat = new THREE.LineBasicMaterial({
      color: 0x35507e, transparent: true, opacity: 0.8, depthWrite: false,
      fog: false,
    });
    const rings = [
      { radius: 230, tiltX: 1.15, tiltZ: 0.30 },
      { radius: 310, tiltX: 1.32, tiltZ: -0.22 },
      { radius: 385, tiltX: 1.02, tiltZ: 0.55 },
    ];
    for (const { radius, tiltX, tiltZ } of rings) {
      const pts = [];
      for (let i = 0; i <= 220; i++) {
        const a = (i / 220) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
      }
      const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMat);
      ring.rotation.set(tiltX, 0, tiltZ);
      ring.position.set(this.cfg.w / 2, this.cfg.h / 2, 0);
      this.scene.add(ring);
    }
  }

  /**
   * World Y to scene Y, mirrored.
   *
   * <p>The simulation uses screen conventions: Y grows downward, the way a
   * canvas does, and W thrusts toward smaller Y. Dropping those coordinates
   * straight into a 3D scene puts +Y into the screen, so pressing W walked the
   * body UP the arena and DOWN the screen. Controls were inverted and it was
   * the renderer's fault, not the input's.
   *
   * <p>Mirroring here rather than flipping the camera keeps X the right way
   * round: a camera moved to the far side would have fixed up and down and
   * inverted left and right instead. The static geometry is symmetric about
   * this axis, so only moving things need the mapping.
   */
  mapY(y) {
    return this.cfg.h - y;
  }

  buildArena() {
    const { w, h } = this.cfg;

    /*
     * The floor is exactly the cage, not larger.
     *
     * It used to extend forty units past the walls, which lit up as a pale slab
     * spreading out under the arena and made the whole thing look like a board
     * sitting on a table. The arena is supposed to be a platform hanging in a
     * dead system with nothing under it.
     */
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshStandardMaterial({
        map: this.tex.floorAlbedo,
        normalMap: this.tex.floorNormal,
        roughnessMap: this.tex.floorRough,
        // The normal map is derived from the albedo's luminance rather than
        // authored, so it is right about seams and rivets and only roughly
        // right about everything else. Turned down accordingly.
        normalScale: new THREE.Vector2(0.6, 0.6),
        // The albedo is graded very dark on purpose, so it is brightened here
        // rather than in the file: the texture stays the source of truth and
        // the renderer decides how lit the room is.
        // Brighter and slightly metallic. The plating carries panel seams and
        // rivets that were completely invisible at the previous exposure: a
        // texture nobody can see is a texture nobody needed.
        color: 0xe6eeff,
        roughness: 0.72,
        metalness: 0.35,
      }),
    );
    floor.position.set(w / 2, h / 2, 0);
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

    /*
     * The orrery itself, etched into the deck: concentric orbit rings around
     * the centre spot, with tick marks on the outermost. The floor was a plain
     * dark quad and read as an empty table. This is what the arena is supposed
     * to have been built from, it costs a handful of line loops, and it gives
     * the eye something to judge distance and speed against, which a featureless
     * plane never does.
     */
    const ringMat = new THREE.LineBasicMaterial({
      color: 0x2f4468, transparent: true, opacity: 0.55,
    });
    for (const radius of [7, 16, 26, 37]) {
      const pts = [];
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0.04));
      }
      const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMat);
      ring.position.set(w / 2, h / 2, 0);
      this.scene.add(ring);
    }

    // Tick marks around the outer ring, like the graduations on the instrument
    // this place used to be.
    const tickPts = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const inner = i % 4 === 0 ? 34.5 : 36;
      tickPts.push(new THREE.Vector3(Math.cos(a) * inner, Math.sin(a) * inner, 0.04));
      tickPts.push(new THREE.Vector3(Math.cos(a) * 37, Math.sin(a) * 37, 0.04));
    }
    const ticks = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(tickPts), ringMat);
    ticks.position.set(w / 2, h / 2, 0);
    this.scene.add(ticks);

    // The halfway line, because a pitch has one and it tells you whose half the
    // star is in without looking at the score.
    const half = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(w / 2, 0.6, 0.04),
        new THREE.Vector3(w / 2, h - 0.6, 0.04),
      ]),
      new THREE.LineBasicMaterial({ color: 0x2f4468, transparent: true, opacity: 0.4 }),
    );
    this.scene.add(half);

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
        map: this.tex.star,
        emissiveMap: this.tex.star,
        color: 0xffe9b0, emissive: 0xffffff, emissiveIntensity: 1.4, roughness: 0.4,
      });
    } else if (b.fixed) {
      // A trace of self-illumination on the fragments, so an unlit one on the
      // far side is still an obstacle you can see rather than one you discover.
      material = new THREE.MeshStandardMaterial({
        map: this.tex.fragment,
        color: 0x9fb0c8, roughness: 0.9, metalness: 0.15,
        emissive: 0x121a2b, emissiveIntensity: 1,
      });
    } else {
      // Tinted toward the team colour on top of the material, so a Norse body
      // and a Greek body are told apart by hue at a glance and by surface up
      // close.
      material = new THREE.MeshStandardMaterial({
        map: b.team === 0 ? this.tex.norse : this.tex.greek,
        color: BODY_TINT[b.team] ?? 0xc8ccd4,
        // A little self-illumination in the team colour, so a body away from
        // the star is dim rather than absent. The star still decides what a
        // surface looks like; this only stops it from disappearing.
        emissive: TEAM_COLOR[b.team] ?? 0x666a72,
        emissiveIntensity: 0.22,
        roughness: 0.45, metalness: 0.25,
      });
    }

    mesh = new THREE.Mesh(this.sphere, material);
    // The star does not cast a shadow. The light is INSIDE it, so it shadowed
    // itself and sat in a black ellipse of its own making.
    mesh.castShadow = b.id !== -1;
    mesh.receiveShadow = b.fixed === true;

    /*
     * The collision circle, drawn flat on the deck in the team's colour.
     *
     * With a figure standing inside it this is the honest picture of the body:
     * the ring is exactly what the server collides, and it is unlit, so a player
     * on the dark side of the arena is still unmistakably Norse or Greek at any
     * distance. It replaced a rim shell around the sphere, which was the same
     * idea before there were figures to stand in it.
     */
    if (b.id >= 0 && (b.team === 0 || b.team === 1)) {
      const rim = new THREE.Mesh(this.sphere, new THREE.MeshBasicMaterial({
        color: TEAM_COLOR[b.team],
        side: THREE.BackSide,
        transparent: true,
        opacity: 0.85,
      }));
      rim.scale.setScalar(1.2);
      mesh.add(rim);
      mesh.userData.team = b.team;
    }

    this.scene.add(mesh);
    this.bodies.set(b.id, mesh);
    return mesh;
  }

  /** A shockwave on the floor where something was hit. */
  addFlash(x, y, strength) {
    const ring = new THREE.Mesh(
      new THREE.PlaneGeometry(4, 4),
      new THREE.MeshBasicMaterial({
        map: this.tex.shockwave,
        color: 0xffe9b0,
        transparent: true,
        opacity: 0.75 * strength,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    ring.position.set(x, this.mapY(y), 0.06);
    this.scene.add(ring);
    this.flashRings.push({ ring, born: performance.now(), strength });
  }

  /** Toggle between following the play and seeing the whole arena. */
  toggleFollow() {
    this.follow = !this.follow;
    return this.follow;
  }

  /**
   * Move the camera toward where the play is.
   *
   * <p>Focus sits between the local player and the star, weighted to the player
   * because that is what the hands are steering. Height comes from how far apart
   * they are, so a duel over the star is close and a long clearance pulls back
   * to show where it went.
   */
  updateCamera(bodies, myId) {
    const { w, h } = this.cfg;
    let targetX = w / 2;
    let targetY = h / 2;
    let height = h * 2.35;

    if (this.follow) {
      const me = bodies.find(b => b.id === myId);
      const star = bodies.find(b => b.id === -1);
      const anchor = me ?? star;
      if (anchor) {
        const other = me && star ? star : anchor;
        targetX = anchor.x * 0.6 + other.x * 0.4;
        targetY = this.mapY(anchor.y * 0.6 + other.y * 0.4);

        /*
         * One fixed height, deliberately.
         *
         * The first version pulled back as you and the star separated, which is
         * what a camera "should" do and was horrible to play under: the zoom
         * moved constantly, so nothing on screen held a steady size and the eye
         * never settled. A game like this needs a stable scale far more than it
         * needs a clever one. The camera follows; it does not breathe.
         */
        height = h * 1.35;

        // Never look outside the cage. Half the visible width at this height,
        // roughly, is what has to stay inside.
        const marginX = Math.min(w / 2, height * 0.30);
        const marginY = Math.min(h / 2, height * 0.20);
        targetX = Math.min(Math.max(targetX, marginX), w - marginX);
        targetY = Math.min(Math.max(targetY, marginY), h - marginY);
      }
    }

    /*
     * Damped in real time, not per frame.
     *
     * This was a flat 0.08 applied once a frame, described in the previous
     * comment as frame-rate independent enough. It is not independent at all:
     * it converges twice as fast at 120fps as at 60, and on the machine this
     * was measured on it left the camera trailing the player by about 130ms.
     * With the ship itself predicted and exact, a view that drags behind it is
     * precisely what gets reported as lag, and it was the only thing left after
     * the round trip, the input timing, the world prediction and the frame rate
     * all measured clean.
     *
     * An exponential on elapsed time settles in about 60ms and behaves the same
     * at any frame rate. The camera is still allowed to trail the world, which
     * is what stops it from jittering; it is no longer allowed to sightsee.
     */
    const now = performance.now();
    const dt = Math.min(0.1, (now - (this.camLastAt ?? now)) / 1000);
    this.camLastAt = now;
    const k = 1 - Math.exp(-CAMERA_RATE * dt);
    this.camFocus.x += (targetX - this.camFocus.x) * k;
    this.camFocus.y += (targetY - this.camFocus.y) * k;
    this.camHeight += (height - this.camHeight) * k;

    this.camera.position.set(
      this.camFocus.x,
      this.camFocus.y - this.camHeight * 0.33,
      this.camHeight,
    );
    this.camera.lookAt(this.camFocus.x, this.camFocus.y, 0);
  }

  /**
   * @param bodies  what to draw, from the same source the flat renderer uses
   * @param myId    the local player, drawn brighter
   * @param ghost   the server's opinion of the local player, or null
   */
  draw(bodies, myId, ghost) {
    this.updateCamera(bodies, myId);
    const seen = new Set();

    for (const b of bodies) {
      seen.add(b.id);
      const mesh = this.meshFor(b);
      mesh.position.set(b.x, this.mapY(b.y), b.r);
      mesh.scale.setScalar(b.r);


      if (b.id === -1) {
        this.starLight.position.set(b.x, this.mapY(b.y), b.r * 2.2);
        const pulse = 1 + Math.sin(performance.now() / 620) * 0.07;
        mesh.material.emissiveIntensity = 1.4 * pulse;
        mesh.rotation.z += 0.0015;   // the surface turns, slowly
        this.halo.position.set(b.x, this.mapY(b.y), b.r);
        this.halo.scale.setScalar(26 * pulse);
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
        new THREE.Vector3(b.x, this.mapY(b.y), b.r),
        new THREE.Vector3(anchor.x, this.mapY(anchor.y), anchor.r),
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
    this.ghostMesh.position.set(ghost.x, this.mapY(ghost.y), ghost.r);
    this.ghostMesh.scale.setScalar(ghost.r * 1.06);
  }

  resize(width, height) {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}
