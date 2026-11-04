import * as THREE from "three";

/**
 * GPU rain streaks (LineSegments, 2 vertices per drop).
 *
 * The `position` attribute stores per-drop seeds (x, phase, z ∈ [0,1)) and `aEnd` marks head (0) /
 * tail (1). Every frame only uniforms change — the vertex shader derives the drop position from
 * seed + uTime, wraps it inside a box that follows the camera target (world-stable, toroidal),
 * slants it by the wind and fades it at the box edges and near the ground. Zero CPU work per drop.
 *
 *   uDensity  fraction of drops visible (0–1)        uSpeed   fall speed (units/s)
 *   uLength   streak length (units)                  uWind    horizontal drift per unit of fall
 */

const vertexShader = /* glsl */ `
  attribute float aEnd;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uLength;
  uniform float uDensity;
  uniform vec3 uCenter;
  uniform vec3 uBox;
  uniform vec2 uWind;
  varying float vAlpha;
  #include <fog_pars_vertex>

  void main() {
    vec3 seed = position;
    float r = fract(sin(dot(seed.xz, vec2(12.9898, 78.233))) * 43758.5453);
    float visible = step(r, uDensity);
    float speed = uSpeed * (0.75 + 0.5 * fract(r * 7.13));
    float fall = fract(seed.y - uTime * speed / uBox.y);
    float y = fall * uBox.y;
    vec2 anchor = seed.xz * uBox.xz - uWind * y;
    vec2 rel = fract((anchor - uCenter.xz) / uBox.xz + 0.5) - 0.5;
    vec2 xz = uCenter.xz + rel * uBox.xz;
    // the tail sits where the drop was a moment ago: higher and up-wind
    vec3 dir = normalize(vec3(-uWind.x, 1.0, -uWind.y));
    float len = uLength * (0.6 + 0.8 * fract(r * 3.7));
    vec3 p = vec3(xz.x, y, xz.y) + dir * len * aEnd;
    float edge = 1.0 - smoothstep(0.3, 0.5, max(abs(rel.x), abs(rel.y)));
    float ground = smoothstep(0.0, 0.05, fall);
    vAlpha = visible * edge * ground * (1.0 - aEnd);
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAlpha;
  #include <fog_pars_fragment>
  void main() {
    float a = vAlpha * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export function createRainMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uSpeed: { value: 120 },
        uLength: { value: 6 },
        uDensity: { value: 0 },
        uCenter: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(360, 220, 360) },
        uWind: { value: new THREE.Vector2(0.18, 0.08) },
        uColor: { value: new THREE.Color("#cfeeff") },
        uOpacity: { value: 0 },
      },
    ]),
    vertexShader,
    fragmentShader,
    fog: true,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
}

/** Seeds for `count` drops: position = (x, phase, z) ∈ [0,1)³ per drop, duplicated for head/tail. */
export function createRainGeometry(count: number) {
  const pos = new Float32Array(count * 6);
  const end = new Float32Array(count * 2);
  // deterministic LCG so the pattern is stable between sessions (no Math.random in the render path)
  let s = 0x2f6b1d3;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const x = rnd();
    const y = rnd();
    const z = rnd();
    pos.set([x, y, z, x, y, z], i * 6);
    end[i * 2] = 0;
    end[i * 2 + 1] = 1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aEnd", new THREE.BufferAttribute(end, 1));
  return geo;
}
