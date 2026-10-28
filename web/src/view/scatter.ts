import * as THREE from 'three';
import { faceGeometry } from './exact';
import { patchFog } from './fog';
import { PARTS, type PartData, type PartName } from './land-data';
import { gradientMap } from './toon';

// The scatter (docs/spec/03-land.md §5): trees, stones, bushes, fences and haystacks, drawn as five instanced
// shapes. The sim's land writes every instance's matrix and colour; here they go straight into the instance
// buffers. Geometries and materials are made once and never disposed (docs/spec/01-flow.md §8).

/** An icosahedron with smooth normals, so crowns and bushes read round under the toon ramp (02-look.md §9). */
function roundIco(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let k = 0; k < pos.count; k++) {
    v.fromBufferAttribute(pos, k).normalize();
    nor.setXYZ(k, v.x, v.y, v.z);
  }
  return g;
}

interface Shape {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  shadow: boolean;
}

let shapes: Record<PartName, Shape> | null = null;

function toonWhite(): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap });
}

/**
 * Trunks, posts and rails: `Box`; crowns and bushes: `Icosahedron(1,0)`; conifer tiers: `Cone(1,1,7)`; stones:
 * `Dodecahedron(1,0)` with the up-facing coat; haystacks: the same cone without the foliage speckle.
 */
function getShapes(): Record<PartName, Shape> {
  if (shapes) return shapes;
  const cone = faceGeometry(new THREE.ConeGeometry(1, 1, 7));
  const plain = patchFog(toonWhite(), { surface: 'face' });
  const foliage = patchFog(toonWhite(), { surface: 'face', speckle: true });
  shapes = {
    wood: { geometry: faceGeometry(new THREE.BoxGeometry(1, 1, 1)), material: plain, shadow: true },
    leaf: { geometry: faceGeometry(roundIco()), material: foliage, shadow: true },
    tier: { geometry: cone, material: foliage, shadow: true },
    stone: { geometry: faceGeometry(new THREE.DodecahedronGeometry(1, 0)), material: patchFog(toonWhite(), { surface: 'face', coat: true }), shadow: true },
    hay: { geometry: cone, material: plain, shadow: true },
  };
  return shapes;
}

/** One instanced mesh per part, its buffers taken as they are. */
export function scatterMeshes(parts: Record<PartName, PartData>): THREE.InstancedMesh[] {
  const s = getShapes();
  return PARTS.map((name) => {
    const { mat, col } = parts[name];
    const mesh = new THREE.InstancedMesh(s[name].geometry, s[name].material, 0);
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(mat, 16);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(col, 3);
    mesh.count = col.length / 3;
    mesh.castShadow = s[name].shadow;
    mesh.receiveShadow = true;
    mesh.name = `scatter-${name}`;
    return mesh;
  });
}
