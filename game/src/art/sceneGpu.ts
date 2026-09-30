import * as THREE from 'three';

/**
 * Mark a texture as owned by one scene (built with it, dropped with it): releaseSceneGpu
 * disposes it. Shared library textures are never marked.
 */
export function sceneOwned<T extends THREE.Texture>(t: T): T {
  t.userData.sceneOwned = true;
  return t;
}

const TEXTURE_SLOTS = ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'aoMap', 'bumpMap'] as const;

/**
 * Free the GPU resources a retired scene owns: light shadow maps, BatchedMesh / InstancedMesh
 * buffers and data textures, geometries, and textures marked sceneOwned. Materials are left
 * alone (the material library is shared across rounds; per-scene materials hold no GPU
 * memory of their own and their programs are cached by key).
 */
export function releaseSceneGpu(scene: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  scene.traverse((o) => {
    const light = o as THREE.DirectionalLight;
    if (light.isLight) {
      light.shadow?.dispose();
      return;
    }
    const mesh = o as THREE.Mesh;
    // BatchedMesh.dispose() nulls its data textures and throws when called twice.
    if ((o as THREE.BatchedMesh).isBatchedMesh) {
      if ((o as unknown as { _matricesTexture: unknown })._matricesTexture) (o as THREE.BatchedMesh).dispose();
    } else if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    // Sprites share one module-level quad: never dispose it.
    if ((mesh.isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints) && !(o as THREE.Sprite).isSprite) mesh.geometry?.dispose();
    const mat = (mesh as { material?: THREE.Material | THREE.Material[] }).material;
    if (mat) for (const m of Array.isArray(mat) ? mat : [mat]) materials.add(m);
    const depth = (mesh as { customDepthMaterial?: THREE.Material }).customDepthMaterial;
    if (depth) materials.add(depth);
  });
  for (const m of materials) {
    const slots = m as unknown as Record<string, THREE.Texture | null | undefined>;
    for (const k of TEXTURE_SLOTS) if (slots[k]?.userData?.sceneOwned) textures.add(slots[k]!);
  }
  for (const t of textures) t.dispose();
}
