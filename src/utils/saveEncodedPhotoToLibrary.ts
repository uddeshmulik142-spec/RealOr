import { File, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import {
  saveDevelopedPhotoMetadata,
  type DevelopedPhotoMetadata,
} from './photoMetadata';

export async function saveEncodedPhotoToLibrary(
  base64Data: string,
  metadata: DevelopedPhotoMetadata,
): Promise<string | null> {
  if (!base64Data) {
    throw new Error('Processed photo data is empty.');
  }

  const { status } = await MediaLibrary.requestPermissionsAsync(false, ['photo']);
  if (status !== 'granted') {
    return null;
  }

  let outputFile: File | undefined;
  try {
    outputFile = new File(Paths.cache, `realor-${Date.now()}.jpg`);
    outputFile.create({ intermediates: true });
    await outputFile.write(base64Data, { encoding: 'base64' });

    let asset: Awaited<ReturnType<typeof MediaLibrary.Asset.create>>;
    try {
      asset = await MediaLibrary.Asset.create(outputFile.uri);
    } catch (error: unknown) {
      throw new Error(
        `Unable to create the photo library asset: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!asset) {
      throw new Error('The photo library did not return a created asset.');
    }

    let uri: string;
    try {
      uri = await asset.getUri();
    } catch (error: unknown) {
      throw new Error(
        `Photo was saved, but its library URI could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!uri) {
      throw new Error('The photo library returned an empty asset URI.');
    }

    await saveDevelopedPhotoMetadata(asset.id, metadata);
    return uri;
  } finally {
    if (outputFile?.exists) {
      outputFile.delete();
    }
  }
}
