import { Skia } from '@shopify/react-native-skia';

export type FilmProfile = 0 | 1 | 2;

export interface FilmShaderSettings {
  profile: FilmProfile;
  grain: number;
  halation: number;
  seed?: number;
}

export const filmShaderSource = `
uniform shader image;
uniform float2 u_resolution;
uniform float u_profile;
uniform float u_grain;
uniform float u_halation;
uniform float u_seed;

float3 sampleLinear(float2 position) {
  return pow(max(image.eval(position).rgb, float3(0.0)), float3(2.2));
}

float luminance(float3 color) {
  return dot(color, float3(0.2126, 0.7152, 0.0722));
}

float3 applySubtractiveMatrix(float3 color) {
  float3 density;

  if (u_profile < 0.5) {
    density = float3(
      dot(color, float3(0.075, 0.025, 0.010)),
      dot(color, float3(0.018, 0.070, 0.020)),
      dot(color, float3(0.008, 0.030, 0.085))
    );
  } else if (u_profile < 1.5) {
    density = float3(
      dot(color, float3(0.090, 0.015, 0.005)),
      dot(color, float3(0.010, 0.065, 0.025)),
      dot(color, float3(0.005, 0.040, 0.110))
    );
  } else {
    density = float3(
      dot(color, float3(0.060, 0.020, 0.015)),
      dot(color, float3(0.015, 0.055, 0.025)),
      dot(color, float3(0.015, 0.025, 0.070))
    );
  }

  return max(color - density, float3(0.0));
}

float hdCurve(float exposure) {
  float logExposure = log(1.0 + 9.0 * clamp(exposure, 0.0, 1.0)) / log(10.0);
  return smoothstep(0.0, 1.0, logExposure);
}

float randomNoise(float2 position) {
  float2 seededPosition = floor(position) + float2(u_seed, u_seed * 0.73);
  return fract(sin(dot(seededPosition, float2(12.9898, 78.233))) * 43758.5453);
}

half4 main(float2 position) {
  float2 resolution = max(u_resolution, float2(1.0));
  float resolutionScale = max(
    1.0,
    max(resolution.x, resolution.y) / 1920.0
  );
  float2 neighborOffset = float2(resolutionScale, resolutionScale);
  float4 centerSample = image.eval(position);
  float3 center = sampleLinear(position);
  float3 left = sampleLinear(position - float2(neighborOffset.x, 0.0));
  float3 right = sampleLinear(position + float2(neighborOffset.x, 0.0));
  float3 above = sampleLinear(position - float2(0.0, neighborOffset.y));
  float3 below = sampleLinear(position + float2(0.0, neighborOffset.y));

  float3 linearColor =
    center * 0.60 +
    (left + right + above + below) * 0.10;

  float neighborHighlights =
    max(luminance(left) - 0.68, 0.0) +
    max(luminance(right) - 0.68, 0.0) +
    max(luminance(above) - 0.68, 0.0) +
    max(luminance(below) - 0.68, 0.0);
  float halo = neighborHighlights * 0.25 * u_halation;
  linearColor += float3(1.0, 0.22, 0.045) * halo;

  linearColor = applySubtractiveMatrix(linearColor);
  if (u_profile < 0.5) {
    linearColor = clamp((linearColor - 0.42) * 1.08 + 0.42, 0.0, 1.0);
  } else if (u_profile < 1.5) {
    linearColor = clamp((linearColor - 0.46) * 1.16 + 0.46, 0.0, 1.0);
  } else {
    linearColor = clamp((linearColor - 0.40) * 1.12 + 0.40, 0.0, 1.0);
  }
  linearColor = float3(
    hdCurve(linearColor.r),
    hdCurve(linearColor.g),
    hdCurve(linearColor.b)
  );

  float3 srgb = pow(clamp(linearColor, 0.0, 1.0), float3(1.0 / 2.2));
  float luma = luminance(srgb);
  float midtoneWeight = 4.0 * luma * (1.0 - luma);
  float grainScale = max(1.0, resolutionScale * 1.25);
  float grain = (randomNoise(position / grainScale) - 0.5) * 2.0;
  srgb += grain * u_grain * midtoneWeight * 0.085;

  return half4(clamp(srgb, 0.0, 1.0), centerSample.a);
}
`;

let cachedFilmRuntimeEffect: ReturnType<typeof Skia.RuntimeEffect.Make> | undefined;

export function createFilmRuntimeEffect() {
  if (cachedFilmRuntimeEffect === undefined) {
    cachedFilmRuntimeEffect = Skia.RuntimeEffect.Make(filmShaderSource);
  }

  if (cachedFilmRuntimeEffect === null) {
    throw new Error('Unable to compile the film shader.');
  }

  return cachedFilmRuntimeEffect;
}
