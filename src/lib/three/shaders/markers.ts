import * as THREE from "three";

/**
 * Selection + outline shaders.
 *
 * Pulse ring — static thin ring plus an expanding ripple (uActive 1 → pulsing, 0 → settled).
 * Merged area outlines — ONE LineSegments for all areas; each vertex carries `aArea` and the
 * shader reads that area's current height / colour from uniform arrays (sized by AREA_COUNT),
 * so heights animate without touching the geometry.
 */

const ringVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ringFragment = /* glsl */ `
  uniform float uTime;
  uniform float uActive;
  uniform float uOpacity;
  uniform vec3 uColor;
  varying vec2 vUv;
  float ring(float r, float c, float w) { return smoothstep(c - w, c, r) * (1.0 - smoothstep(c, c + w, r)); }
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float base = ring(r, 0.5, 0.025) + ring(r, 0.5, 0.09) * 0.18;
    float t = fract(uTime * 0.5);
    float pulse = ring(r, mix(0.5, 1.0, t), 0.05) * (1.0 - t) * uActive;
    float dotC = 1.0 - smoothstep(0.035, 0.06, r);
    float a = (base * 0.95 + pulse * 0.7 + dotC * 0.9) * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }
`;

export function createPulseMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uActive: { value: 1 },
      uOpacity: { value: 1 },
      uColor: { value: new THREE.Color("#25d9f2") },
    },
    vertexShader: ringVertex,
    fragmentShader: ringFragment,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
}

const outlineVertex = /* glsl */ `
  attribute float aArea;
  uniform float uHeights[AREA_COUNT];
  uniform vec4 uColors[AREA_COUNT];
  uniform float uLift;
  varying vec4 vColor;
  #include <fog_pars_vertex>
  void main() {
    int i = int(aArea + 0.5);
    vec3 p = position;
    p.y = uHeights[i] + uLift;
    vColor = uColors[i];
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const outlineFragment = /* glsl */ `
  varying vec4 vColor;
  #include <fog_pars_fragment>
  void main() {
    if (vColor.a < 0.004) discard;
    gl_FragColor = vColor;
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export interface OutlineUniforms {
  uHeights: { value: Float32Array };
  uColors: { value: THREE.Vector4[] };
  uLift: { value: number };
}

export function createOutlineMaterial(count: number, lift: number) {
  const n = Math.max(1, count);
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]) as Record<string, THREE.IUniform>;
  uniforms.uHeights = { value: new Float32Array(n) };
  uniforms.uColors = { value: Array.from({ length: n }, () => new THREE.Vector4(1, 1, 1, 0)) };
  uniforms.uLift = { value: lift };
  const material = new THREE.ShaderMaterial({
    uniforms,
    defines: { AREA_COUNT: n },
    vertexShader: outlineVertex,
    fragmentShader: outlineFragment,
    fog: true,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  return { material, uniforms: uniforms as unknown as OutlineUniforms };
}
