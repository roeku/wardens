import * as THREE from 'three';
import type { Kind, Unit } from '../../contracts';
import { Figures, type ManRecord } from '../figures';
import { daylight } from '../light';
import { H, W, EYE_Y, MID_X, type Img } from './post';

// Fallback (a) of the kit: the commander's own 3D figure, head and shoulders close up (01-flow.md §7's framing),
// face detail on, lit from the upper left, on the flat side colour. It returns the raw 80×96 picture with the eyes
// on row 40 and the head's middle on column 40; the caller quantises it. Kept for the comparison in the faces lab:
// out/decisions-d5-faces.md "Procedural faces, not the figure's close-up" records why the game uses (b).
//
// Dev and lab only: it needs a WebGL context of its own and compiles the figure materials for it.

THREE.ColorManagement.enabled = false;

/** The head's radius on the picture, art px (a broodlord's smaller, so its horns fit). */
const HEAD_PX = { man: 24, brute: 13 };
/** How far the head is turned from the camera, radians. */
const TURN = 0.55;
/** Part names never drawn in a portrait: weapons, the horse, banners. */
const HIDE = /^fig:(spear|sword|pitchfork|lance|pennant|shield|bow|string|rein|arrow|bundle|h[A-Z]|saddle|pole|crossbar|finial|banner|chevron|ribbon|bm(Club|Cleaver|Spear)|tr(Club|Maul)|leg|blLeg|blTail|skirt|gown)/;

interface Ctx {
  gl: THREE.WebGLRenderer;
  rt: THREE.WebGLRenderTarget;
  scene: THREE.Scene;
  cam: THREE.OrthographicCamera;
  figures: Figures;
  sun: THREE.DirectionalLight;
  buf: Uint8Array;
}
let ctx: Ctx | null = null;

function make(): Ctx {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const gl = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, stencil: false });
  gl.outputColorSpace = THREE.LinearSRGBColorSpace;
  const rt = new THREE.WebGLRenderTarget(W, H, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, depthBuffer: true });
  const scene = new THREE.Scene();
  const day = daylight(0);
  const sun = new THREE.DirectionalLight(day.sun, day.sunI);
  const hemi = new THREE.HemisphereLight(day.sky, day.ground, day.hemiI);
  scene.add(sun, sun.target, hemi);
  const figures = new Figures();
  scene.add(figures.group);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 50);
  return { gl, rt, scene, cam, figures, sun, buf: new Uint8Array(W * H * 4) };
}

export interface CloseOpts {
  side: 'warden' | 'blight';
  kind: Kind;
  unit: Unit;
  rank: number;
  captain: boolean;
  bg: number;
}

const M = new THREE.Matrix4();
const R = new THREE.Matrix4();
const V = new THREE.Vector3();

/** The commander's head close up: raw RGB, 80×96, rows top-down. */
export function closeUp(face: number, o: CloseOpts): Img {
  ctx ??= make();
  const c = ctx;
  const blight = o.side === 'blight';
  // the figure turned three quarters to the picture's right (sim facing π/2 looks at the camera; 0.55 rad to the right)
  const rec: ManRecord = {
    id: 1, x: 0, y: 0, h: 0, face: Math.PI / 2 - TURN, speed: 0, kind: o.kind, unit: o.unit, team: blight ? 1 : 0, rank: o.rank,
    commander: !o.captain, captain: o.captain, faceSeed: face, routing: false, alive: true, recruit: false, strikes: 0,
    hitAge: Infinity, deathAge: 0, engaged: false,
  };
  // face detail from zoom 28 (02-look.md §5); a large zoom keeps thin things at their true width
  c.figures.update({ men: [rec], dt: 0, time: 0, zoom: 400 });
  c.figures.group.traverse((m) => {
    if (m instanceof THREE.InstancedMesh && HIDE.test(m.name)) m.visible = false;
  });
  // the head's frame, from its instance: the eyes and the head's centre in the world
  // the broodlord's head is one of its muzzles' parts (blHead, blHead1, blHead2); the one drawn this time
  const headName = blight ? /^fig:blHead[12]?$/ : /^fig:head$/;
  let head: THREE.InstancedMesh | null = null;
  c.figures.group.traverse((m) => {
    if (m instanceof THREE.InstancedMesh && headName.test(m.name) && m.count > 0) head = m;
  });
  if (!head) throw new Error(`portrait: no head part drawn`);
  const hm = head as THREE.InstancedMesh;
  hm.getMatrixAt(0, M);
  const root = (hm.geometry.getAttribute('aRoot') as THREE.InstancedBufferAttribute).array;
  R.makeTranslation(root[0], root[1], root[2]).multiply(M);
  const eye = new THREE.Vector3(...(blight ? [0.062, 0.05, 0] as const : [0.057, 0.064, 0] as const)).applyMatrix4(R);
  const mid = new THREE.Vector3(...(blight ? [0.03, 0.04, 0] as const : [0.004, 0.058, 0] as const)).applyMatrix4(R);
  const unitLen = new THREE.Vector3(1, 0, 0).applyMatrix4(R).sub(new THREE.Vector3().setFromMatrixPosition(R)).length();
  const s = (blight ? HEAD_PX.brute / 0.06 : HEAD_PX.man / 0.064) / unitLen;

  // the camera: square on from the picture's front at eye level (from above, a kettle hat's brim hides the face)
  const dir = new THREE.Vector3(0, 0.03, -1).normalize();
  const cam = c.cam;
  cam.position.copy(mid).addScaledVector(dir, -20);
  cam.up.set(0, 1, 0);
  cam.lookAt(mid);
  cam.updateMatrixWorld(true);
  const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
  // eyes on row 40 and the head's middle on column 40 (pixel centres): offsets of the frustum from the camera axis,
  // which runs through the head's middle. Pixel x = (p·right − cx)·s + W/2; pixel y (down) = H/2 − (p·up − cy)·s.
  const ey = V.copy(eye).sub(mid).dot(up);
  const cx = -(MID_X + 0.5 - W / 2) / s;
  const cy = ey + (EYE_Y + 0.5 - H / 2) / s;
  cam.left = cx - W / 2 / s;
  cam.right = cx + W / 2 / s;
  cam.top = cy + H / 2 / s;
  cam.bottom = cy - H / 2 / s;
  cam.updateProjectionMatrix();
  // lit from the upper left, in front
  c.sun.position.copy(mid).addScaledVector(right, -6).addScaledVector(up, 7).addScaledVector(dir, -5);
  c.sun.target.position.copy(mid);
  c.sun.target.updateMatrixWorld();

  c.gl.setClearColor(new THREE.Color(o.bg));
  c.gl.setRenderTarget(c.rt);
  c.gl.render(c.scene, cam);
  c.gl.readRenderTargetPixels(c.rt, 0, 0, W, H, c.buf);
  c.gl.setRenderTarget(null);
  const img = new Uint32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = ((H - 1 - y) * W + x) * 4;
      img[y * W + x] = (c.buf[k] << 16) | (c.buf[k + 1] << 8) | c.buf[k + 2];
    }
  }
  return img;
}
