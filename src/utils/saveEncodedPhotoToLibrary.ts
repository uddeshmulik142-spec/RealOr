import { File, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import {
  saveDevelopedPhotoMetadata,
  type DevelopedPhotoMetadata,
} from './photoMetadata';

export async function saveEncodedPhotoToLibrary(
  base64Data: string,
  metadata: DevelopedPhotoMetadata,
): Promise<string> {
  if (!base64Data) {
    throw new Error('Processed photo data is empty.');
  }

  let outputFile: File | undefined;
  try {
    outputFile = new File(Paths.cache, `realor-${Date.now()}.jpg`);
    outputFile.create({ intermediates: true });
    await outputFile.write(base64Data, { encoding: 'base64' });

    const permission = await MediaLibrary.requestPermissionsAsync(true, ['photo']);
    if (!permission.granted) {
      throw new Error('Photo library permission is required to save this photo.');
    }

    const asset = await MediaLibrary.Asset.create(outputFile.uri);
    const [uri] = await Promise.all([
      asset.getUri(),
      saveDevelopedPhotoMetadata(asset.id, metadata),
    ]);
    return uri;
  } finally {
    if (outputFile?.exists) {
      outputFile.delete();
    }
  }
}
