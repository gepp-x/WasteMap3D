import * as THREE from "three";

/**
 * Technical ground grid: anti-aliased minor/major lines (fwidth), level-of-detail fade when cells
 * shrink below a few pixels (no moiré), radial fade around the camera target, and scene fog.
 * Not tone-mapped so the far ground matches the page background exactly.
 */

const vertexShader = /* glsl */ `
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

const fragmentShader = /* glsl */ `
  uniform vec3 uBase;
  uniform vec3 uMinorColor;
  uniform vec3 uMajorColor;
  uniform float uMinor;
  uniform float uMajor;
  uniform vec3 uCenter;
  uniform float uRadius;
  uniform float uOpacity;
  varying vec3 vWorld;
  #include <fog_pars_fragment>

  float gridLine(vec2 p, float spacing, float width) {
    vec2 c = p / spacing;
    vec2 d = fwidth(c);
    vec2 g = abs(fract(c - 0.5) - 0.5) / max(d * width, vec2(1e-5));
    float line = 1.0 - min(min(g.x, g.y), 1.0);
    float lod = 1.0 - smoothstep(0.12, 0.45, max(d.x, d.y));
    return line * lod;
  }

  void main() {
    vec2 p = vWorld.xz;
    float minor = gridLine(p, uMinor, 1.0);
    float major = gridLine(p, uMajor, 1.35);
    float dist = length(p - uCenter.xz);
    float fade = 1.0 - smoothstep(uRadius * 0.2, uRadius, dist);
    vec3 col = uBase;
    col += uMinorColor * 0.05 * (1.0 - smoothstep(0.0, uRadius * 0.9, dist));
    col = mix(col, uMinorColor, minor * 0.32 * fade * uOpacity);
    col = mix(col, uMajorColor, major * 0.5 * fade * uOpacity);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export function createGridMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uBase: { value: new THREE.Color("#071321") },
        uMinorColor: { value: new THREE.Color("#173449") },
        uMajorColor: { value: new THREE.Color("#1f5671") },
        uMinor: { value: 10 },
        uMajor: { value: 50 },
        uCenter: { value: new THREE.Vector3() },
        uRadius: { value: 600 },
        uOpacity: { value: 1 },
      },
    ]),
    vertexShader,
    fragmentShader,
    fog: true,
    toneMapped: false,
    depthWrite: true,
  });
}
