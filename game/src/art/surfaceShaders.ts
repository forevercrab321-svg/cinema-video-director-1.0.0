import * as THREE from 'three';

/**
 * Shader injections that take surfaces from "clean CG" to "lived-in city".
 *
 *  weathering(material, kind) — world-space, texture-free, applied on top of the PBR maps:
 *    · macro albedo variation (breaks texture tiling at distance)
 *    · walls: dirt band at the base, vertical rain streaks, soot under ledges
 *    · ground: oil stains, tyre-worn darker lanes, damp patches (darker + glossier)
 *
 *  interiorMapping(material, room) — fake rooms behind window glass: the view ray is
 *    intersected with a box room behind each window (per-window centre stored in the
 *    `roomCenter` attribute), giving walls, floor, ceiling, furniture, blinds and lit rooms
 *    with correct parallax, at the cost of a few ALU ops on glass pixels only.
 */
const NOISE = /* glsl */ `
  float wHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float wNoise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(wHash(i), wHash(i + vec3(1,0,0)), f.x), mix(wHash(i + vec3(0,1,0)), wHash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(wHash(i + vec3(0,0,1)), wHash(i + vec3(1,0,1)), f.x), mix(wHash(i + vec3(0,1,1)), wHash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float wFbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * wNoise(p); p *= 2.07; a *= 0.5; } return s; }
`;

const VERTEX_WORLD = /* glsl */ `
  #if defined( USE_BATCHING )
    vec4 wWorld = modelMatrix * batchingMatrix * vec4(transformed, 1.0);
    vWNormal = normalize(mat3(modelMatrix) * mat3(batchingMatrix) * objectNormal);
  #elif defined( USE_INSTANCING )
    vec4 wWorld = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
    vWNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
  #else
    vec4 wWorld = modelMatrix * vec4(transformed, 1.0);
    vWNormal = normalize(mat3(modelMatrix) * objectNormal);
  #endif
  vWPos = wWorld.xyz;
`;

export type WeatherKind = 'wall' | 'ground' | 'prop';

export function weathering(material: THREE.Material, kind: WeatherKind, strength = 1): THREE.Material {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    shader.uniforms.uWeather = { value: strength };
    shader.vertexShader = 'varying vec3 vWPos;\nvarying vec3 vWNormal;\n' + shader.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + VERTEX_WORLD);
    shader.fragmentShader =
      'varying vec3 vWPos;\nvarying vec3 vWNormal;\nuniform float uWeather;\nfloat wWet = 0.0;\n' +
      NOISE +
      shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            vec3 p = vWPos;
            float macro = wFbm(p * 0.07);
            diffuseColor.rgb *= mix(1.0, 0.84 + 0.3 * macro, uWeather);
            ${
              kind === 'wall'
                ? `
            float vertical = 1.0 - smoothstep(0.35, 0.6, abs(vWNormal.y));
            float base = smoothstep(1.6, 0.0, p.y) * (0.55 + 0.45 * wNoise(p * vec3(3.0, 1.5, 3.0)));
            float streak = smoothstep(0.58, 0.82, wNoise(vec3(p.x * 7.0, p.y * 0.22, p.z * 7.0))) * smoothstep(0.0, 3.0, p.y);
            float soot = smoothstep(0.62, 0.9, wFbm(p * vec3(0.9, 0.35, 0.9))) * 0.6;
            float dirt = clamp(base * 0.42 + streak * 0.2 + soot * 0.18, 0.0, 0.6) * vertical * uWeather;
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.62, 0.58, 0.52), dirt);
            wWet = base * 0.25 * vertical;`
                : kind === 'ground'
                  ? `
            float flat_ = smoothstep(0.7, 0.9, vWNormal.y);
            float oil = smoothstep(0.66, 0.8, wFbm(p * 0.45 + 7.0)) * 0.55;
            float lane = smoothstep(0.3, 0.0, abs(fract((p.z + 6.0) / 3.5) - 0.5) - 0.18) * step(-9.4, p.z) * step(p.z, -2.6) * 0.18;
            float damp = smoothstep(0.55, 0.75, wFbm(p * 0.18 + 3.0));
            float mark = clamp(oil * 0.6 + lane + damp * 0.12, 0.0, 0.35) * flat_ * uWeather;
            diffuseColor.rgb *= 1.0 - mark;
            wWet = damp * flat_ * uWeather;`
                  : `
            float grime = smoothstep(0.55, 0.85, wFbm(p * 3.0)) * 0.25;
            diffuseColor.rgb *= 1.0 - grime * uWeather;`
            }
          }`,
        )
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.45, clamp(wWet, 0.0, 1.0));');
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|weather-${kind}`;
  material.needsUpdate = true;
  return material;
}

export interface RoomSpec {
  width: number; // room width across the facade (m)
  depth: number;
  height: number;
  floorBelowCentre: number; // floor height below the window's centre
  litChance: number;
  shop: boolean;
}

export function interiorMapping(material: THREE.MeshStandardMaterial, room: RoomSpec): THREE.Material {
  material.color.set(0x050607);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRoom = { value: new THREE.Vector4(room.width, room.depth, room.height, room.floorBelowCentre) };
    shader.uniforms.uLit = { value: room.litChance };
    shader.vertexShader =
      'attribute vec3 roomCenter;\nvarying vec3 vRoomCenter;\nvarying vec3 vWPos;\nvarying vec3 vWNormal;\n' +
      shader.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + VERTEX_WORLD + '\n  vRoomCenter = roomCenter;');
    shader.fragmentShader =
      'varying vec3 vRoomCenter;\nvarying vec3 vWPos;\nvarying vec3 vWNormal;\nuniform vec4 uRoom;\nuniform float uLit;\n' +
      NOISE +
      `
      vec3 interior(vec3 p, vec3 n, vec3 c) {
        // Only vertical glass has a room behind it; the thin pane's top/bottom faces would make
        // cross(up, n) zero, and normalize(0) is NaN — which bloom smears into black screens.
        if (abs(n.y) > 0.5) return vec3(0.0);
        vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), n));
        vec3 v = normalize(p - cameraPosition);
        vec3 rel = p - c;
        float lx = dot(rel, t), ly = rel.y;
        float dx = dot(v, t), dy = v.y, dz = max(-dot(v, n), 1e-3);
        float W = uRoom.x * 0.5, D = uRoom.y, yf = -uRoom.w, yc = yf + uRoom.z;
        float tx = ((dx > 0.0 ? W : -W) - lx) / (abs(dx) < 1e-4 ? 1e-4 : dx);
        float ty = ((dy > 0.0 ? yc : yf) - ly) / (abs(dy) < 1e-4 ? 1e-4 : dy);
        float tz = D / dz;
        float tm = min(tz, min(tx, ty));
        vec3 h = vec3(lx + dx * tm, ly + dy * tm, dz * tm);
        float s1 = wHash(c * 1.37 + 0.5), s2 = wHash(c * 2.11 + 3.1), s3 = wHash(c * 0.73 + 7.7), s4 = wHash(c * 3.3 + 1.9);
        vec3 wall = mix(mix(vec3(0.62, 0.56, 0.47), vec3(0.72, 0.71, 0.68), s1), mix(vec3(0.48, 0.54, 0.6), vec3(0.6, 0.47, 0.42), s1), step(0.6, s2));
        vec3 floorC = mix(vec3(0.3, 0.2, 0.13), vec3(0.36, 0.36, 0.38), step(0.55, s2));
        vec3 col;
        if (tm == tz) {
          col = wall;
          // furniture silhouette against the back wall, and a picture frame
          if (h.y < yf + 0.85 && abs(h.x - (s3 - 0.5) * W) < W * 0.45) col = mix(vec3(0.16, 0.13, 0.11), vec3(0.3, 0.26, 0.22), s4);
          if (abs(h.y - (yf + 1.7)) < 0.28 && abs(h.x + (s4 - 0.5) * W) < 0.35) col = vec3(0.2, 0.22, 0.25);
        } else if (tm == tx) {
          col = wall * 0.85;
          if (h.y < yf + 1.9 && h.z > D * 0.35 && h.z < D * 0.7) col *= 0.55; // doorway / wardrobe
        } else if (dy < 0.0) {
          col = floorC * (0.8 + 0.2 * wNoise(vec3(h.x * 6.0, 0.0, h.z * 0.8)));
          if (abs(h.x) < W * 0.5 && h.z > D * 0.3 && h.z < D * 0.75) col *= vec3(0.9, 0.55, 0.45) * 1.3; // rug
        } else {
          col = vec3(0.78);
        }
        ${
          room.shop
            ? `// shop: shelving bands on side and back walls, bright even lighting
        if (tm != ty && h.y > yf + 0.3 && h.y < yf + 2.2) {
          float row = floor((h.y - yf) * 2.4);
          float along = (tm == tz ? h.x : h.z) * 4.0;
          float slot = floor(along);
          vec3 prod = 0.3 + 0.5 * vec3(wHash(vec3(slot, row, c.x)), wHash(vec3(row, slot, c.z)), wHash(vec3(slot + row, 1.0, c.y)));
          prod = mix(vec3(dot(prod, vec3(0.3, 0.55, 0.15))), prod, 0.4); // packaging reads muted through glass
          float fill = step(0.25, wHash(vec3(slot * 1.7, row, c.x + c.z))); // gaps where stock is sold
          vec3 shelfBack = wall * 0.55;
          col = fract((h.y - yf) * 2.4) < 0.08 ? vec3(0.55, 0.53, 0.5) : (fract(along) < 0.82 && fill > 0.5 ? prod * 0.75 : shelfBack);
        }
        vec3 light = vec3(1.0, 0.85, 0.62) * (0.25 + 0.35 * exp(-h.z * 0.25));`
            : `bool lit = s3 < uLit;
        float day = 0.28 * exp(-h.z * 0.45) + 0.04;
        vec3 light = lit ? vec3(1.0, 0.78, 0.5) * (0.55 + 0.35 * exp(-length(vec2(h.x, h.z - D * 0.5)) * 0.6)) : vec3(day);`
        }
        col *= light;
        ${
          room.shop
            ? ''
            : `// blinds / curtains covering the top of some windows
        float cover = s4 < 0.45 ? mix(0.25, 1.0, s2) : 0.0;
        if (ly > 0.85 - cover * 1.7) {
          vec3 blind = mix(vec3(0.82, 0.8, 0.74), vec3(0.62, 0.5, 0.4), step(0.5, s1));
          blind *= 0.3 + 0.12 * step(0.5, fract(ly * 22.0));
          col = lit ? blind * vec3(1.6, 1.25, 0.9) : blind;
        }`
        }
        return col;
      }
      ` +
      shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 n = vWNormal / max(length(vWNormal), 1e-5);
          vec3 v = normalize(cameraPosition - vWPos);
          float fres = pow(1.0 - clamp(dot(v, n), 0.0, 1.0), 4.0);
          totalEmissiveRadiance += interior(vWPos, n, vRoomCenter) * (1.0 - fres) * 0.85;
        }`,
      );
  };
  material.customProgramCacheKey = () => `interior-${room.shop ? 'shop' : 'flat'}`;
  material.needsUpdate = true;
  return material;
}
