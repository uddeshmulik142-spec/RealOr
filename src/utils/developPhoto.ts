import {
  File,
  Paths,
} from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import {
  FilterMode,
  ImageFormat,
  MipmapMode,
  Skia,
  TileMode,
  type SkData,
  type SkImage,
  type SkPaint,
  type SkShader,
  type SkSurface,
} from '@shopify/react-native-skia';
import {
  createFilmRuntimeEffect,
  type FilmShaderSettings,
} from '../shaders/filmShader';

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
): Promise<string> {
  if (![0, 1, 2].includes(settings.profile)) {
    throw new RangeError('Film profile must be 0, 1, or 2.');
  }

  const grain = clampIntensity(settings.grain, 'Grain');
  const halation = clampIntensity(settings.halation, 'Halation');
  const seed = settings.seed ?? Math.random() * 1000;
  if (!Number.isFinite(seed)) {
    throw new RangeError('Shader seed must be a finite number.');
  }

  let data: SkData | undefined;
  let sourceImage: SkImage | null = null;
  let surface: SkSurface | null = null;
  let imageShader: SkShader | undefined;
  let shader: SkShader | undefined;
  let paint: SkPaint | undefined;
  let snapshot: SkImage | undefined;
  let outputFile: File | undefined;

  try {
    const sourceFile = new File(toFileUri(pathOrUri));
    if (!sourceFile.exists) {
      throw new Error('The captured photo file does not exist.');
    }

    const base64Data = await sourceFile.base64();
    data = Skia.Data.fromBase64(base64Data);
    sourceImage = Skia.Image.MakeImageFromEncoded(data);
    if (!sourceImage) {
      throw new Error('Unable to decode the captured photo. Invalid image buffer.');
    }

    const width = sourceImage.width();
    const height = sourceImage.height();
    surface = Skia.Surface.Make(width, height);
    if (!surface) {
      throw new Error('Failed to create Skia processing surface.');
    }

    imageShader = sourceImage.makeShaderOptions(
      TileMode.Clamp,
      TileMode.Clamp,
      FilterMode.Linear,
      MipmapMode.None,
    );
    shader = createFilmRuntimeEffect().makeShaderWithChildren(
      [width, height, settings.profile, grain, halation, seed],
      [imageShader],
    );
    paint = Skia.Paint();
    paint.setShader(shader);

    const canvas = surface.getCanvas();
    canvas.drawRect(Skia.XYWHRect(0, 0, width, height), paint);
    surface.flush();

    snapshot = surface.makeImageSnapshot();
    const encodedBase64 = snapshot.encodeToBase64(ImageFormat.JPEG, 95);
    if (!encodedBase64) {
      throw new Error('Failed to encode developed film frame.');
    }

    outputFile = new File(Paths.cache, `realor-${Date.now()}.jpg`);
    outputFile.create({ intermediates: true });
    await outputFile.write(encodedBase64, { encoding: 'base64' });

    const permission = await MediaLibrary.requestPermissionsAsync(true, ['photo']);
    if (!permission.granted) {
      throw new Error('Photo library permission is required to save this photo.');
    }

    const asset = await MediaLibrary.Asset.create(outputFile.uri);
    return await asset.getUri();
  } finally {
    snapshot?.dispose();
    paint?.dispose();
    shader?.dispose();
    imageShader?.dispose();
    surface?.dispose();
    sourceImage?.dispose();
    data?.dispose();
    if (outputFile?.exists) {
      outputFile.delete();
    }
  }
}
