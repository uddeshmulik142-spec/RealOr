import { File, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';

export async function saveEncodedPhotoToLibrary(base64Data: string): Promise<void> {
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

    await MediaLibrary.Asset.create(outputFile.uri);
  } finally {
    if (outputFile?.exists) {
      outputFile.delete();
    }
  }
}
