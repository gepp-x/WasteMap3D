import * as THREE from "three";

/**
 * Illustrative flood water: translucent, view-dependent (fresnel) colour with a slow, low-frequency
 * shimmer. Works on the neighbourhood sheet (horizontal plane, radial edge fade) and on the city
 * "water bands" (extruded footprints → side walls use their normals for the fresnel term).
 * Purely a visual metaphor; nothing in this shader encodes a depth value.
 */

const vertexShader = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormalW;
  #include <fog_pars_vertex>
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  uniform float uScale;
  uniform float uEdgeRadius;
  uniform vec2 uEdgeCenter;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uGlint;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  #include <fog_pars_fragment>

  void main() {
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 N = normalize(vNormalW);
    float fres = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), 2.2);
    vec2 p = vWorld.xz / uScale;
    float w = sin(p.x * 1.7 + uTime * 0.8) * sin(p.y * 1.3 - uTime * 0.6) + 0.5 * sin((p.x + p.y) * 3.1 + uTime * 1.4);
    float glint = smoothstep(0.9, 1.45, w) * step(0.5, N.y);
    vec3 col = mix(uDeep, uShallow, 0.3 + 0.55 * fres);
    col += uGlint * glint * 0.3;
    float edge = 1.0;
    if (uEdgeRadius > 0.0) edge = 1.0 - smoothstep(uEdgeRadius * 0.72, uEdgeRadius, length(vWorld.xz - uEdgeCenter));
    float a = uOpacity * (0.42 + 0.38 * fres + 0.12 * glint) * edge;
    if (a < 0.003) discard;
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export function createFloodMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uOpacity: { value: 0.9 },
        uScale: { value: 6 },
        uEdgeRadius: { value: 0 },
        uEdgeCenter: { value: new THREE.Vector2() },
        uShallow: { value: new THREE.Color("#3fa7d6") },
        uDeep: { value: new THREE.Color("#0d4d78") },
        uGlint: { value: new THREE.Color("#d9f6ff") },
      },
    ]),
    vertexShader,
    fragmentShader,
    fog: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
