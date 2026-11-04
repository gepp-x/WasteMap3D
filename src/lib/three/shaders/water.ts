import * as THREE from "three";

/**
 * Water shaders.
 *
 * Flow ribbons: `uv.x` = distance along the line (scene units), `uv.y` = 0→1 across. Streaks are
 * dashes scrolled along +u (the digitised / downstream direction) in three jittered lanes, so the
 * flow never looks like a uniform marquee. `uIntensity` (rain 0–1) speeds and brightens the flow.
 *
 * Water areas: subtle world-space shimmer (two low-frequency sine fields), no textures.
 */

const ribbonVertex = /* glsl */ `
  varying vec2 vUv;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const ribbonFragment = /* glsl */ `
  uniform float uTime;
  uniform float uSpacing;
  uniform float uIntensity;
  uniform float uOpacity;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uFlow;
  varying vec2 vUv;
  #include <fog_pars_fragment>

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    float across = vUv.y;
    float edge = smoothstep(0.0, 0.2, across) * smoothstep(1.0, 0.8, across);
    float center = 1.0 - abs(across - 0.5) * 2.0;
    float lane = floor(across * 3.0);
    float u = vUv.x / uSpacing - uTime * (0.55 + 0.9 * uIntensity);
    float cell = floor(u + lane * 0.37);
    float jitter = hash(vec2(lane, cell));
    float s = fract(u + lane * 0.37);
    float streak = smoothstep(0.0, 0.05, s) * (1.0 - smoothstep(0.08, 0.38, s)) * step(0.3, jitter);
    vec3 col = mix(uDeep, uShallow, center * 0.7);
    col = mix(col, uFlow, streak * (0.28 + 0.42 * uIntensity) * (0.4 + 0.6 * center));
    float a = uOpacity * edge * (0.78 + 0.22 * center);
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export function createFlowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uSpacing: { value: 8 },
        uIntensity: { value: 0 },
        uOpacity: { value: 0.9 },
        uDeep: { value: new THREE.Color("#0b3a5c") },
        uShallow: { value: new THREE.Color("#1a6f98") },
        uFlow: { value: new THREE.Color("#8eeaff") },
      },
    ]),
    vertexShader: ribbonVertex,
    fragmentShader: ribbonFragment,
    fog: true,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

const areaVertex = /* glsl */ `
  varying vec3 vWorld;
  #include <fog_pars_vertex>
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const areaFragment = /* glsl */ `
  uniform float uTime;
  uniform float uScale;
  uniform float uOpacity;
  uniform float uIntensity;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  varying vec3 vWorld;
  #include <fog_pars_fragment>
  void main() {
    vec2 p = vWorld.xz / uScale;
    float w = sin(p.x * 1.3 + uTime * 0.6) * sin(p.y * 1.1 - uTime * 0.5) + 0.5 * sin((p.x - p.y) * 2.3 + uTime * 0.9);
    float sheen = smoothstep(0.6, 1.4, w);
    vec3 col = mix(uDeep, uShallow, 0.35 + 0.35 * sheen + 0.2 * uIntensity);
    gl_FragColor = vec4(col, uOpacity * (0.82 + 0.18 * sheen));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export function createWaterAreaMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uScale: { value: 6 },
        uOpacity: { value: 0.85 },
        uIntensity: { value: 0 },
        uDeep: { value: new THREE.Color("#0a3150") },
        uShallow: { value: new THREE.Color("#17618a") },
      },
    ]),
    vertexShader: areaVertex,
    fragmentShader: areaFragment,
    fog: true,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}
