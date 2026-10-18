import { File, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import {
  FilterMode,
  ImageFormat,
  MipmapMode,
  Skia,
  TileMode,
} from '@shopify/react-native-skia';
import { filmShaderSource, type FilmShaderSettings } from '../shaders/filmShader';

let compiledFilmShader: ReturnType<typeof Skia.RuntimeEffect.Make> | undefined;

function getCompiledFilmShader() {
  if (compiledFilmShader === undefined) {
    compiledFilmShader = Skia.RuntimeEffect.Make(filmShaderSource);
  }

  if (compiledFilmShader === null) {
    throw new Error('Unable to compile the film shader.');
  }

  return compiledFilmShader;
}

function clampIntensity(value: number, name: string) {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number.`);
  }

  return Math.max(0, Math.min(1, value));
}

function toFileUri(pathOrUri: string) {
  if (!pathOrUri.trim()) {
    throw new Error('A photo file path is required.');
  }

  if (/^(file|content):\/\//i.test(pathOrUri)) {
    return pathOrUri;
  }

  return `file://${pathOrUri.startsWith('/') ? '' : '/'}${pathOrUri}`;
}

export async function developPhoto(
  pathOrUri: string,
  settings: FilmShaderSettings,
): Promise<void> {
  if (![0, 1, 2].includes(settings.profile)) {
    throw new RangeError('Film profile must be 0, 1, or 2.');
  }

  const grain = clampIntensity(settings.grain, 'Grain');
  const halation = clampIntensity(settings.halation, 'Halation');
  const seed = settings.seed ?? Math.random() * 1000;
  if (!Number.isFinite(seed)) {
    throw new RangeError('Shader seed must be a finite number.');
  }

  const shaderEffect = getCompiledFilmShader();
  const data = await Skia.Data.fromURI(toFileUri(pathOrUri));
  const sourceImage = Skia.Image.MakeImageFromEncoded(data);
  if (!sourceImage) {
    data.dispose();
    throw new Error('Unable to decode the captured photo.');
  }

  const width = sourceImage.width();
  const height = sourceImage.height();
  const surface = Skia.Surface.Make(width, height);
  if (!surface) {
    sourceImage.dispose();
    data.dispose();
    throw new Error(`Unable to create a ${width}×${height} processing surface.`);
  }

  const imageShader = sourceImage.makeShaderOptions(
    TileMode.Clamp,
    TileMode.Clamp,
    FilterMode.Linear,
    MipmapMode.None,
  );
  const shader = shaderEffect.makeShaderWithChildren(
    [width, height, settings.profile, grain, halation, seed],
    [imageShader],
  );
  const paint = Skia.Paint();
  paint.setShader(shader);
  const canvas = surface.getCanvas();

  let outputFile: File | undefined;
  let outputImage: ReturnType<typeof surface.makeImageSnapshot> | undefined;

  try {
    canvas.drawRect(Skia.XYWHRect(0, 0, width, height), paint);
    outputImage = surface.makeImageSnapshot();
    const base64 = outputImage.encodeToBase64(ImageFormat.JPEG, 95);
    if (!base64) {
      throw new Error('Unable to encode the developed photo as JPEG.');
    }

    outputFile = new File(Paths.cache, `realor-${Date.now()}.jpg`);
    outputFile.create({ intermediates: true });
    await outputFile.write(base64, { encoding: 'base64' });

    const permission = await MediaLibrary.requestPermissionsAsync(true, ['photo']);
    if (!permission.granted) {
      throw new Error('Photo library permission is required to save this photo.');
    }

    await MediaLibrary.Asset.create(outputFile.uri);
  } finally {
    outputImage?.dispose();
    paint.dispose();
    shader.dispose();
    imageShader.dispose();
    surface.dispose();
    sourceImage.dispose();
    data.dispose();
    if (outputFile?.exists) {
      outputFile.delete();
    }
  }
}
